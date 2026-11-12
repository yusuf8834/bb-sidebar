import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerLifecycle, StoredLifecycleRow, CleanupThread } from "./server-lifecycle";
import type { createPortDiscovery } from "./port-discovery";
import type { createThreadPortActions } from "./thread-ports";
import type { z } from "zod";
import type { cleanupIssueSchema, cleanupPreviewSchema, cleanupResultSchema, ownedPortTargetSchema } from "./contract";
import { randomUUID } from "node:crypto";
import { canPark, hasLiveWork, isTurnInFlight } from "./lifecycle";
import { EMPTY_RECLAIM, planTerminalReclaim, type ReclaimSummary } from "./reclaim";
import { runThreadTasks } from "./thread-tasks";

export function createServerSettleCleanup(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  threadPortActions: ReturnType<typeof createThreadPortActions>,
  getOpenPorts: ReturnType<typeof createPortDiscovery>,
) {
  const { loadPolicyThreads, loadPolicyThread, readOne, sameLifecycle, threadSignals } = lifecycle;
  type CleanupIssue = z.infer<typeof cleanupIssueSchema>;

  type CleanupPlanThread = {
    threadId: string;
    terminalIds: string[];
    ports: Array<z.infer<typeof ownedPortTargetSchema>>;
    workspace: { environmentId: string; hostId: string; path: string } | null;
  };

  const sameCleanupWorkspace = (left: CleanupPlanThread["workspace"], right: CleanupPlanThread["workspace"]) =>
    left === null
      ? right === null
      : right !== null &&
        left.environmentId === right.environmentId &&
        left.hostId === right.hostId &&
        left.path === right.path;

  const terminalInCleanupWorkspace = (
    session: { environmentId: string | null; hostId: string | null },
    workspace: CleanupPlanThread["workspace"],
  ) =>
    workspace === null
      ? session.environmentId === null
      : session.environmentId === workspace.environmentId && session.hostId === workspace.hostId;

  const cleanupPlans = new Map<string, { expiresAt: number; threads: CleanupPlanThread[]; skipped: CleanupIssue[] }>();

  const canCleanSettledThread = (thread: CleanupThread, row: StoredLifecycleRow | null) => {
    if (
      !row ||
      thread.visibility !== "visible" ||
      row.settledAt === null ||
      row.parkedAt != null ||
      row.snoozedUntil !== null ||
      thread.pinnedAt !== null ||
      thread.latestAttentionAt > row.settledAt
    )
      return false;
    const activity = thread.activity;
    return canPark({
      hasPendingInteraction: thread.hasPendingInteraction,
      hasQueuedWork: thread.queuedWork !== "none",
      isWorking: hasLiveWork(
        {
          workflows: activity.activeWorkflowCount,
          backgroundAgents: activity.activeBackgroundAgentCount,
          backgroundCommands: activity.activeBackgroundCommandCount,
          planMode: activity.activePlanModeCount,
        },
        isTurnInFlight(thread.status),
      ),
    });
  };

  const cleanupContext = async (targetThreadId?: string) => {
    const beforeLookup = await loadPolicyThreads(true);
    const target = targetThreadId ? beforeLookup.find((thread) => thread.id === targetThreadId) : undefined;
    const lookupThreads = target
      ? beforeLookup.filter(
          (thread) =>
            thread.environmentId === target.environmentId ||
            (target.environmentHostId && thread.environmentHostId === target.environmentHostId),
        )
      : beforeLookup;
    const { paths, failedHosts } = await threadPortActions.canonicalWorkspacePaths(lookupThreads);
    // Host path lookup can take seconds. Policy and activity must be read
    // again after it, before any cleanup decision is made.
    const threads = await loadPolicyThreads(true);
    const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const currentTarget = targetThreadId ? byId.get(targetThreadId) : undefined;
    const relevant = currentTarget
      ? threads.filter(
          (thread) =>
            thread.environmentId === currentTarget.environmentId ||
            (currentTarget.environmentHostId && thread.environmentHostId === currentTarget.environmentHostId),
        )
      : threads;
    const workspaceKeys = (thread: CleanupThread): string[] => {
      if (!thread.environmentId) return [];
      const path = paths.get(thread.environmentId);
      return [
        `environment:${thread.environmentId}`,
        ...(thread.environmentHostId && path ? [`path:${thread.environmentHostId}\0${path}`] : []),
      ];
    };
    // The first thread found protecting each workspace names it in the preview.
    const protectedWorkspaces = new Map<string, CleanupThread>();
    for (const thread of relevant) {
      if (canCleanSettledThread(thread, readOne(thread.id))) continue;
      for (const key of workspaceKeys(thread)) if (!protectedWorkspaces.has(key)) protectedWorkspaces.set(key, thread);
    }
    const unresolvedProtectedHosts = new Set(
      relevant.flatMap((thread) => {
        if (canCleanSettledThread(thread, readOne(thread.id))) return [];
        if (
          !thread.environmentHostId ||
          !thread.environmentPath ||
          !thread.environmentId ||
          !paths.has(thread.environmentId)
        ) {
          return thread.environmentHostId ? [thread.environmentHostId] : [];
        }
        return [];
      }),
    );
    const workspaceProtection = (thread: CleanupThread): string | null => {
      if (!thread.environmentId) return null;
      if (
        !thread.environmentHostId ||
        !thread.environmentPath ||
        failedHosts.has(thread.environmentHostId) ||
        !paths.has(thread.environmentId) ||
        unresolvedProtectedHosts.has(thread.environmentHostId)
      )
        return "could not confirm that its workspace is not shared with active work";
      for (const key of workspaceKeys(thread)) {
        const owner = protectedWorkspaces.get(key);
        if (owner)
          return `shares a workspace with "${owner.title ?? owner.titleFallback ?? owner.id}", which is not settled`;
      }
      return null;
    };
    const isProtectedWorkspace = (thread: CleanupThread) => workspaceProtection(thread) !== null;
    return { byId, isProtectedWorkspace, workspaceProtection };
  };

  const cleanupError = (error: unknown): string =>
    error instanceof Error && error.message.trim() ? error.message : String(error);

  // Queued cleanup belongs to the shelf action that scheduled it. Revalidate
  // after network waits; activity, a new shelf choice, a pin or reparent cancels
  // the remaining work. The SDK has no atomic "stop only if idle" operation.
  const reclaimThreadResources = async (
    threadId: string,
    snapshot?: CleanupThread,
    expectedRow = readOne(threadId),
    owner?: { threadId: string; row: StoredLifecycleRow | null },
    stillEligible?: (thread: CleanupThread) => boolean,
  ): Promise<ReclaimSummary> => {
    const ownsRow = () =>
      expectedRow !== null &&
      sameLifecycle(readOne(threadId), expectedRow) &&
      (!owner || sameLifecycle(readOne(owner.threadId), owner.row));
    const canReclaim = async () => {
      if (!ownsRow()) return false;
      const thread = await loadPolicyThread(threadId, snapshot?.visibility === "hidden");
      return (
        ownsRow() &&
        thread !== undefined &&
        thread.pinnedAt === null &&
        canPark(threadSignals(thread)) &&
        (!stillEligible || stillEligible(thread)) &&
        (!snapshot ||
          (thread.parentThreadId === snapshot.parentThreadId && thread.latestAttentionAt <= snapshot.latestAttentionAt))
      );
    };
    let stoppedRuntime = false;
    try {
      if (!(await canReclaim())) return { ...EMPTY_RECLAIM };
      await ctx.bb.sdk.threads.stop({ threadId });
      stoppedRuntime = true;
    } catch {
      // A thread with no loaded runtime is the common case, not an error.
    }
    let closedTerminals = 0;
    let keptTerminals = 0;
    try {
      const { sessions } = await ctx.bb.sdk.terminals.list({
        scope: { kind: "thread", threadId },
      });
      const plan = planTerminalReclaim(sessions);
      keptTerminals = plan.keep;
      for (const terminalId of plan.close) {
        try {
          if (!(await canReclaim())) break;
          await ctx.bb.sdk.terminals.close({ terminalId, mode: "if-clean" });
          closedTerminals += 1;
        } catch {
          // Someone typed into it between the list and the close.
        }
      }
    } catch {
      // Leave the counts at zero rather than reporting a number we did not see.
    }
    return { closedTerminals, keptTerminals, stoppedRuntime };
  };
  ctx.bb.onDispose(() => cleanupPlans.clear());

  const handlers = {
    async previewSettledCleanup({ threadIds }) {
      const { byId, workspaceProtection } = await cleanupContext();
      const threads: z.infer<typeof cleanupPreviewSchema>["threads"] = [];
      const skipped: CleanupIssue[] = [];
      const planned: CleanupPlanThread[] = [];
      const work = await runThreadTasks(
        threadIds,
        async (threadId) => {
          const thread = byId.get(threadId);
          if (!thread || !canCleanSettledThread(thread, readOne(threadId))) {
            skipped.push({
              threadId,
              resource: "thread",
              message: "Thread is no longer in Settled or has active work",
            });
            return;
          }
          const protection = workspaceProtection(thread);
          if (protection) {
            // Say why live terminals stay open. A quiet thread needs no line.
            try {
              const { sessions } = await ctx.bb.sdk.terminals.list({ scope: { kind: "thread", threadId } });
              const live = sessions.filter(
                (session) =>
                  session.threadId === threadId && (session.status === "running" || session.status === "starting"),
              ).length;
              if (live > 0) {
                skipped.push({
                  threadId,
                  resource: "terminal",
                  message: `Kept ${live} ${live === 1 ? "terminal" : "terminals"} open: ${protection}`,
                });
              }
            } catch {
              // The workspace stays protected either way.
            }
            return;
          }
          let workspace: CleanupPlanThread["workspace"];
          try {
            workspace = await threadPortActions.getThreadWorkspace({ threadId });
          } catch (error) {
            skipped.push({
              threadId,
              resource: "thread",
              message: `Could not verify workspace: ${cleanupError(error)}`,
            });
            return;
          }
          const terminalIds: string[] = [];
          try {
            const { sessions } = await ctx.bb.sdk.terminals.list({ scope: { kind: "thread", threadId } });
            terminalIds.push(
              ...sessions
                .filter(
                  (session) =>
                    session.threadId === threadId &&
                    terminalInCleanupWorkspace(session, workspace) &&
                    (session.status === "running" || session.status === "starting"),
                )
                .map((session) => session.id),
            );
          } catch (error) {
            skipped.push({
              threadId,
              resource: "terminal",
              message: `Could not inspect terminals: ${cleanupError(error)}`,
            });
          }
          let ports: CleanupPlanThread["ports"] = [];
          if (thread.environmentId) {
            try {
              const found = await threadPortActions.getThreadPorts({ threadId });
              ports = found.ports.filter((port) => port.processStartedAt);
              if (!sameCleanupWorkspace(workspace, found.workspace)) {
                skipped.push({ threadId, resource: "port", message: "Thread workspace changed during preview" });
                ports = [];
              }
            } catch (error) {
              skipped.push({ threadId, resource: "port", message: `Could not inspect ports: ${cleanupError(error)}` });
            }
          }
          if (terminalIds.length > 0 || ports.length > 0) {
            planned.push({ threadId, terminalIds, ports, workspace });
            threads.push({
              threadId,
              title: thread.title ?? thread.titleFallback ?? threadId,
              terminalCount: terminalIds.length,
              ports: [...new Set(ports.map((port) => port.port))],
            });
          }
        },
        4,
      );
      skipped.push(
        ...work.failures.map(({ threadId, error }) => ({ threadId, resource: "thread" as const, message: error })),
      );
      const token = randomUUID();
      const now = Date.now();
      for (const [oldToken, plan] of cleanupPlans) if (plan.expiresAt <= now) cleanupPlans.delete(oldToken);
      cleanupPlans.set(token, { expiresAt: now + 2 * 60_000, threads: planned, skipped });
      const order = new Map(threadIds.map((id, index) => [id, index]));
      threads.sort((a, b) => order.get(a.threadId)! - order.get(b.threadId)!);
      return { token, threads, skipped };
    },
    async cleanSettled({ token }) {
      const plan = cleanupPlans.get(token);
      cleanupPlans.delete(token);
      if (!plan || plan.expiresAt <= Date.now())
        throw new Error("Cleanup preview expired. Review the resources again.");
      const result: z.infer<typeof cleanupResultSchema> = {
        closedTerminals: 0,
        signalledPorts: [],
        remainingPorts: [],
        skipped: [...plan.skipped],
        failed: [],
      };
      const plannedById = new Map(plan.threads.map((thread) => [thread.threadId, thread]));
      const work = await runThreadTasks(
        plan.threads.map((thread) => thread.threadId),
        async (threadId) => {
          const { byId, isProtectedWorkspace } = await cleanupContext(threadId);
          const thread = byId.get(threadId);
          if (!thread || !canCleanSettledThread(thread, readOne(threadId)) || isProtectedWorkspace(thread)) {
            result.skipped.push({
              threadId,
              resource: "thread",
              message: "Thread returned to Active or Working, or shares a protected workspace",
            });
            return;
          }
          const plannedThread = plannedById.get(threadId)!;
          if (plannedThread.terminalIds.length > 0) {
            try {
              const { sessions } = await ctx.bb.sdk.terminals.list({ scope: { kind: "thread", threadId } });
              const current = new Map(sessions.map((session) => [session.id, session]));
              for (const terminalId of plannedThread.terminalIds) {
                const latestWorkspace = await threadPortActions.getThreadWorkspace({ threadId });
                const latest = await cleanupContext(threadId);
                const latestThread = latest.byId.get(threadId);
                if (
                  !latestThread ||
                  !canCleanSettledThread(latestThread, readOne(threadId)) ||
                  latest.isProtectedWorkspace(latestThread) ||
                  !sameCleanupWorkspace(plannedThread.workspace, latestWorkspace)
                ) {
                  result.skipped.push({
                    threadId,
                    resource: "terminal",
                    message: `Terminal ${terminalId} is now protected by active work or a shared workspace`,
                  });
                  break;
                }
                const session = current.get(terminalId);
                if (
                  !session ||
                  session.threadId !== threadId ||
                  !terminalInCleanupWorkspace(session, latestWorkspace) ||
                  (session.status !== "running" && session.status !== "starting")
                ) {
                  result.skipped.push({
                    threadId,
                    resource: "terminal",
                    message: `Terminal ${terminalId} is no longer owned by this settled thread`,
                  });
                  continue;
                }
                try {
                  await ctx.bb.sdk.terminals.close({ terminalId, mode: "force" });
                  result.closedTerminals += 1;
                } catch (error) {
                  result.failed.push({
                    threadId,
                    resource: "terminal",
                    message: `Terminal ${terminalId}: ${cleanupError(error)}`,
                  });
                }
              }
            } catch (error) {
              result.failed.push({
                threadId,
                resource: "terminal",
                message: `Could not recheck terminals: ${cleanupError(error)}`,
              });
            }
          }
          if (plannedThread.ports.length === 0) return;
          try {
            const current = await threadPortActions.getThreadPorts({ threadId });
            if (!plannedThread.workspace || !sameCleanupWorkspace(plannedThread.workspace, current.workspace)) {
              result.skipped.push({ threadId, resource: "port", message: "Thread workspace changed since preview" });
              return;
            }
            const targets = plannedThread.ports.filter((target) =>
              current.ports.some(
                (port) =>
                  port.pid === target.pid &&
                  port.port === target.port &&
                  port.processStartedAt === target.processStartedAt,
              ),
            );
            if (targets.length < plannedThread.ports.length) {
              result.skipped.push({
                threadId,
                resource: "port",
                message: "Some previewed ports changed ownership or closed",
              });
            }
            if (targets.length === 0) return;
            const beforeSignal = await cleanupContext(threadId);
            const signalThread = beforeSignal.byId.get(threadId);
            if (
              !signalThread ||
              !canCleanSettledThread(signalThread, readOne(threadId)) ||
              beforeSignal.isProtectedWorkspace(signalThread)
            ) {
              result.skipped.push({
                threadId,
                resource: "port",
                message: "Thread or shared workspace became active before shutdown",
              });
              return;
            }
            const closed = await threadPortActions.closeThreadPorts({
              threadId,
              ports: targets,
              expectedWorkspace: plannedThread.workspace,
            });
            result.signalledPorts.push(...closed.signalled.map((port) => ({ threadId, port })));
            result.skipped.push(
              ...closed.skipped.map((port) => ({
                threadId,
                resource: "port" as const,
                message: `Port :${port} changed before shutdown`,
              })),
            );
            result.failed.push(
              ...closed.failed.map((port) => ({
                threadId,
                resource: "port" as const,
                message: `Could not signal port :${port}`,
              })),
            );
            if (closed.signalled.length > 0) {
              await new Promise((resolve) => setTimeout(resolve, 750));
              const after = await threadPortActions.getThreadPorts({ threadId });
              result.remainingPorts.push(
                ...after.ports
                  .filter((port) => closed.signalled.includes(port.port))
                  .map((port) => ({ threadId, port: port.port })),
              );
            }
          } catch (error) {
            result.failed.push({ threadId, resource: "port", message: cleanupError(error) });
          }
        },
        4,
      );
      result.failed.push(
        ...work.failures.map(({ threadId, error }) => ({ threadId, resource: "thread" as const, message: error })),
      );
      getOpenPorts.invalidate();
      return result;
    },
  } satisfies Pick<ServerHandlers, "previewSettledCleanup" | "cleanSettled">;

  return { reclaimThreadResources, cleanupError, handlers };
}
