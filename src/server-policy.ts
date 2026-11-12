import { z } from "zod";
import type { ServerContext } from "./server-context";
import type { createServerLifecycle, StoredLifecycleRow } from "./server-lifecycle";
import type { createThreadPortActions } from "./thread-ports";
import type { createServerSettings } from "./server-settings";
import type { createServerSettleCleanup } from "./server-settle-cleanup";
import {
  autoSettleNeedsPullRequest,
  decideAutoSettle,
  decideAutoSettledThread,
  isAutoSettled,
  parseAutoSettleAfterDays,
  type AutoSettlePullRequest,
} from "./auto-settle";
import { threadTreeIds } from "./thread-tree";
import { resolveShelf } from "./lifecycle";
import { runThreadTasks } from "./thread-tasks";
import { GITHUB_PR_STATUS_PLUGIN_ID, MAX_PULL_REQUEST_KEYS } from "./github-pr-status";

// Reads wait for overdue PR data, so a batch can take a while; the next
// five-minute pass retries.
const PULL_REQUEST_LOOKUP_TIMEOUT_MS = 60_000;

// Rows are parsed one at a time so one malformed row leaves the others usable.
const pullRequestRowSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    pullRequest: z.object({
      state: z.enum(["draft", "open", "merged", "closed"]),
      updatedAt: z.string(),
    }),
  }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable") }),
]);

export function createServerPolicy(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  settings: Awaited<ReturnType<typeof createServerSettings>>,
  cleanup: ReturnType<typeof createServerSettleCleanup>,
  threadPortActions: ReturnType<typeof createThreadPortActions>,
) {
  const { readSidebarSettings } = settings;
  const { reclaimThreadResources } = cleanup;
  const {
    loadPolicyThreads,
    readAll,
    readOne,
    write,
    threadSignals,
    publishLifecycleChanges,
    wakeAncestors,
    backfillSettledChildRows,
  } = lifecycle;
  // A missing row, a lookup error, or `unavailable` (machine offline, `gh`
  // failed, PR Status disabled) is not evidence that no open PR exists. Each
  // becomes `unknown`, which keeps the thread where it is.
  let pullRequestLookupFailing = false;
  const loadPullRequests = async (environmentIds: readonly string[]) => {
    const results = new Map<string, AutoSettlePullRequest>();
    for (let start = 0; start < environmentIds.length; start += MAX_PULL_REQUEST_KEYS) {
      const keys = environmentIds.slice(start, start + MAX_PULL_REQUEST_KEYS);
      let rows: Record<string, unknown> = {};
      try {
        rows = await ctx.bb.sdk.plugins.callRpc({
          pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
          method: "pullRequests",
          input: { keys },
          outputSchema: z.record(z.string(), z.unknown()),
          signal: AbortSignal.timeout(PULL_REQUEST_LOOKUP_TIMEOUT_MS),
        });
        pullRequestLookupFailing = false;
      } catch (error) {
        if (!pullRequestLookupFailing) {
          ctx.bb.log.warn(
            `GitHub PR Status lookup failed; threads with a workspace keep their place until it succeeds: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        pullRequestLookupFailing = true;
      }
      for (const environmentId of keys) {
        const row = pullRequestRowSchema.safeParse(rows[environmentId]);
        if (!row.success || row.data.outcome === "unavailable") {
          results.set(environmentId, { outcome: "unknown" });
        } else if (row.data.outcome === "absent") {
          results.set(environmentId, { outcome: "absent" });
        } else {
          results.set(environmentId, {
            outcome: "available",
            state: row.data.pullRequest.state,
            updatedAt: row.data.pullRequest.updatedAt,
          });
        }
      }
    }
    return results;
  };

  const applyPolicyChanges = ctx.db.transaction(
    (
      changes: ReadonlyArray<{
        decision: "settle" | "unsettle";
        row: StoredLifecycleRow | null;
        threadId: string;
      }>,
      now: number,
    ) => {
      for (const { decision, row, threadId } of changes) {
        if (decision === "settle") {
          write(
            {
              threadId,
              settledAt: now,
              settledOverride: null,
              snoozedUntil: row?.snoozedUntil ?? null,
              snoozedAt: row?.snoozedAt ?? null,
            },
            false,
          );
        } else if (row?.snoozedUntil != null) {
          write(
            {
              ...row,
              settledAt: null,
              settledOverride: null,
            },
            false,
          );
        } else {
          ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
        }
      }
    },
  );

  let policyEvaluation: Promise<string[]> | null = null;

  let policyEvaluationQueued = false;

  let policySettingsRevision = 0;

  // A settled thread is done. Ordinary passes only re-decide live threads; one
  // the policy settled is looked at again only after a rule changes, or on the
  // first pass after the server starts, when the rules may have changed while
  // it was down. The flag stays set until such a pass completes at the current
  // rules, so a failed or superseded pass cannot leave threads settled under
  // rules the user turned off.
  let fullRecheckPending = true;
  // Policy-settled threads a re-check could not decide because their PR lookup
  // had no answer. Each is looked up on later passes until one answers. Holding
  // the flag instead would keep every pass full while a removed workspace keeps
  // reporting `unavailable`.
  let unansweredThreadIds = new Set<string>();

  const evaluatePolicies = (): Promise<string[]> => {
    if (policyEvaluation !== null) {
      policyEvaluationQueued = true;
      return policyEvaluation;
    }
    const evaluation = (async () => {
      const settingsRevision = policySettingsRevision;
      const fullRecheck = fullRecheckPending;
      const rechecks = (threadId: string) => fullRecheck || unansweredThreadIds.has(threadId);
      let unanswered = new Set<string>();
      // Only a completed pass at the rules it read updates either record.
      const finishRecheck = () => {
        if (settingsRevision !== policySettingsRevision) return;
        if (fullRecheck) fullRecheckPending = false;
        unansweredThreadIds = unanswered;
      };
      const configured = readSidebarSettings();
      let threads = await loadPolicyThreads(true);
      // Repair older trees before any decision reads their children's rows.
      const backfilled = backfillSettledChildRows(threads);
      const lifecycleByThreadId = new Map(readAll().map((row) => [row.threadId, row]));
      const policySettings = {
        afterDays: parseAutoSettleAfterDays(configured.autoSettleInactive, String(configured.autoSettleAfterDays)),
        onMerge: configured.autoSettleOnMerge,
      };
      // With both rules off, every known PR outcome leads to the same decision,
      // so skip GitHub entirely and treat each environment as having no PR.
      const readsPullRequests = policySettings.onMerge || policySettings.afterDays !== null;
      const environmentIds = readsPullRequests
        ? [
            ...new Set(
              threads.flatMap((thread) => {
                const row = lifecycleByThreadId.get(thread.id) ?? null;
                if (
                  thread.environmentId === null ||
                  (!rechecks(thread.id) && isAutoSettled(row)) ||
                  !autoSettleNeedsPullRequest(row, thread)
                ) {
                  return [];
                }
                return [thread.environmentId];
              }),
            ),
          ]
        : [];
      const pullRequests = await loadPullRequests(environmentIds);
      const now = Date.now();
      const decide = (keepThreadIds: ReadonlySet<string>) => {
        unanswered = new Set();
        return threads.flatMap((thread) => {
          if (keepThreadIds.has(thread.id) || (thread.visibility === "hidden" && thread.parentThreadId === null))
            return [];
          // Re-read after every lookup so a concurrent Park action wins.
          const row = readOne(thread.id);
          // Decided per thread: PR rows are keyed by environment, so a settled
          // thread sharing a workspace with a live one would otherwise be
          // re-decided from the live thread's lookup.
          if (!rechecks(thread.id) && isAutoSettled(row)) {
            const decision = decideAutoSettledThread(row, thread);
            return decision === "keep" ? [] : [{ decision, row, threadId: thread.id }];
          }
          const pullRequest: AutoSettlePullRequest =
            thread.environmentId === null || !readsPullRequests
              ? { outcome: "absent" }
              : (pullRequests.get(thread.environmentId) ?? { outcome: "unknown" });
          const decision = decideAutoSettle({ lifecycle: row, now, pullRequest, settings: policySettings, thread });
          if (decision === "keep" && pullRequest.outcome === "unknown" && isAutoSettled(row)) {
            unanswered.add(thread.id);
          }
          return decision === "keep" ? [] : [{ decision, row, threadId: thread.id }];
        });
      };
      let changes = decide(new Set());
      // Settling stops the runtime, which kills what its agent left running in
      // the background, and bb cannot see that work when the provider does not
      // report it. A thread still serving a port, such as a dev server, stays
      // out of policy reach until it stops.
      const settling = new Set(changes.flatMap((change) => (change.decision === "settle" ? [change.threadId] : [])));
      if (settling.size > 0) {
        const servingPorts = await threadPortActions.threadsServingPorts(
          threads.filter((thread) => settling.has(thread.id)),
          threads,
        );
        // A child may have been created or restarted during the lookups.
        // Recheck the tree before settling, using only scanned candidates.
        threads = await loadPolicyThreads(true);
        changes = decide(servingPorts).filter(
          (change) => change.decision !== "settle" || settling.has(change.threadId),
        );
      }
      // A parent can only leave the inbox once its whole tree is settled.
      // Descendants keep their own PR, inactivity, pin, and live-work rules.
      const settlingIds = new Set(
        changes.filter((change) => change.decision === "settle").map((change) => change.threadId),
      );
      const restoringIds = new Set(
        changes.filter((change) => change.decision === "unsettle").map((change) => change.threadId),
      );
      const byId = new Map(threads.map((thread) => [thread.id, thread]));
      changes = changes.filter(
        (change) =>
          change.decision !== "settle" ||
          threadTreeIds(threads, change.threadId).every((id) => {
            if (settlingIds.has(id)) return true;
            if (restoringIds.has(id)) return false;
            const thread = byId.get(id)!;
            return resolveShelf(readOne(id) ?? undefined, threadSignals(thread), now) === "settled";
          }),
      );
      // Settings can change while PRs or ports are loading. The queued pass
      // uses the latest rules; this older pass must not move or stop threads.
      if (settingsRevision !== policySettingsRevision || changes.length === 0) {
        finishRecheck();
        return backfilled;
      }
      applyPolicyChanges(changes, now);
      const cleanupRows = new Map(changes.map((change) => [change.threadId, readOne(change.threadId)]));
      const changedThreadIds = new Set(changes.map((change) => change.threadId));
      publishLifecycleChanges([...changedThreadIds]);
      for (const id of backfilled) changedThreadIds.add(id);
      for (const change of changes) {
        if (change.decision === "unsettle") {
          for (const id of await wakeAncestors(byId.get(change.threadId)!, { automaticOnly: true, threadsById: byId }))
            changedThreadIds.add(id);
        }
      }
      // Outside the transaction, because releasing a runtime is a network call
      // and holding a write lock open across one would block every other write.
      await runThreadTasks(
        changes.flatMap((change) => (change.decision === "settle" ? [change.threadId] : [])),
        async (threadId) => {
          await reclaimThreadResources(threadId, byId.get(threadId), cleanupRows.get(threadId), undefined, (thread) => {
            if (settingsRevision === policySettingsRevision) return true;
            const current = readSidebarSettings();
            // A changed rule may return this thread to Active. Only finish its
            // reclaim if it still qualifies under the new rules.
            return (
              decideAutoSettle({
                lifecycle: null,
                now: Date.now(),
                pullRequest:
                  thread.environmentId === null
                    ? { outcome: "absent" }
                    : (pullRequests.get(thread.environmentId) ?? { outcome: "unknown" }),
                settings: {
                  afterDays: parseAutoSettleAfterDays(current.autoSettleInactive, String(current.autoSettleAfterDays)),
                  onMerge: current.autoSettleOnMerge,
                },
                thread,
              }) === "settle"
            );
          });
        },
        4,
      );
      finishRecheck();
      return [...changedThreadIds];
    })();
    const settledEvaluation = evaluation.finally(() => {
      if (policyEvaluation !== settledEvaluation) return;
      policyEvaluation = null;
      if (!policyEvaluationQueued) return;
      policyEvaluationQueued = false;
      void evaluatePolicies().catch((error) => {
        ctx.bb.log.error(
          `Queued automatic settle evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    policyEvaluation = settledEvaluation;
    return settledEvaluation;
  };
  const settingsChanged = () => {
    policySettingsRevision += 1;
    fullRecheckPending = true;
  };

  return { evaluatePolicies, settingsChanged };
}
