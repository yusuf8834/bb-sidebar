import { z } from "zod";
import type { ServerContext } from "./server-context";
import type { createServerLifecycle } from "./server-lifecycle";
import type { createServerSettings } from "./server-settings";
import {
  DAY_MS,
  isValidAutoArchiveAfterDays,
  isWorkspaceSafeToRetire,
  settledArchiveTree,
  type WorkspaceStatusRow,
} from "./auto-archive";

const GIT_PLUGIN_ID = "bb--git";
/** bb's Git plugin `status` accepts at most this many environment ids per call. */
const MAX_GIT_STATUS_KEYS = 200;
const GIT_STATUS_TIMEOUT_MS = 60_000;
const HOUR_MS = 60 * 60 * 1_000;

/** A failed archive is retried after 1, 2, 4 and 8 hours, then left alone until the thread settles again. */
const MAX_ARCHIVE_ATTEMPTS = 5;
/** Due, but not archivable now: a live child, a pin, a wake. */
const INELIGIBLE_RETRY_MS = 6 * HOUR_MS;
/** Due, but its workspace has uncommitted changes. */
const DIRTY_RETRY_MS = 6 * HOUR_MS;
/** Due, but bb could not say whether its workspace is clean. */
const UNKNOWN_RETRY_MS = HOUR_MS;
/** Archived or deleted elsewhere; look again in case it comes back. */
const ABSENT_RETRY_MS = 7 * DAY_MS;

/**
 * One record per thread whose settle the rule has looked at. `settled_at`
 * names that settle: a new settle replaces the record. `clock_start` is when
 * the settle started counting, normally `settled_at`; it moves to the return
 * when the thread comes back from bb's archive. `retry_at` keeps a thread the
 * rule cannot archive yet from costing a lookup on every pass.
 */
export const AUTO_ARCHIVE_MIGRATION = `CREATE TABLE IF NOT EXISTS auto_archive_state (
  thread_id   TEXT PRIMARY KEY,
  settled_at  INTEGER NOT NULL,
  clock_start INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  retry_at    INTEGER,
  archived_at INTEGER
)`;

interface StateRow {
  thread_id: string;
  settled_at: number;
  clock_start: number;
  attempts: number;
  retry_at: number | null;
  archived_at: number | null;
}

const gitStatusRowSchema = z.union([
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      workingTree: z.object({ hasUncommittedChanges: z.boolean(), state: z.string() }),
    }),
  }),
  z.object({ outcome: z.string() }),
]);

export function createServerAutoArchive(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  settings: Awaited<ReturnType<typeof createServerSettings>>,
) {
  const { readAll, readOne, loadPolicyThreads, threadSignals, withThreadChanges } = lifecycle;
  const readState = (threadId: string) =>
    ctx.db.prepare(`SELECT * FROM auto_archive_state WHERE thread_id = ?`).get(threadId) as StateRow | undefined;
  const writeState = (row: StateRow) =>
    ctx.db
      .prepare(
        `INSERT INTO auto_archive_state (thread_id, settled_at, clock_start, attempts, retry_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           settled_at = excluded.settled_at, clock_start = excluded.clock_start, attempts = excluded.attempts,
           retry_at = excluded.retry_at, archived_at = excluded.archived_at`,
      )
      .run(row.thread_id, row.settled_at, row.clock_start, row.attempts, row.retry_at, row.archived_at);

  /** The record for this settle, starting its clock at the settle when that time is usable. */
  const stateFor = (threadId: string, settledAt: number, now: number): StateRow => {
    const stored = readState(threadId);
    if (stored && stored.settled_at === settledAt) return stored;
    // A settle time in the future or before 1970 is not usable. Count from
    // now rather than guess an older start.
    const usable = settledAt > 0 && settledAt <= now;
    const row = {
      thread_id: threadId,
      settled_at: settledAt,
      clock_start: usable ? settledAt : now,
      attempts: 0,
      retry_at: null,
      archived_at: null,
    };
    if (!usable || stored) writeState(row);
    return row;
  };

  let workspaceStatusFailing = false;
  const loadWorkspaceStatus = async (environmentIds: readonly string[]) => {
    const results = new Map<string, WorkspaceStatusRow>();
    for (let start = 0; start < environmentIds.length; start += MAX_GIT_STATUS_KEYS) {
      const keys = environmentIds.slice(start, start + MAX_GIT_STATUS_KEYS);
      try {
        const rows = await ctx.bb.sdk.plugins.callRpc({
          pluginId: GIT_PLUGIN_ID,
          method: "status",
          input: { keys },
          outputSchema: z.record(z.string(), z.unknown()),
          signal: AbortSignal.timeout(GIT_STATUS_TIMEOUT_MS),
        });
        workspaceStatusFailing = false;
        for (const key of keys) {
          const row = gitStatusRowSchema.safeParse(rows[key]);
          if (row.success) results.set(key, row.data);
        }
      } catch (error) {
        if (!workspaceStatusFailing) {
          ctx.bb.log.warn(
            `Auto-archive could not read workspace status; those threads wait for a later pass: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        workspaceStatusFailing = true;
      }
    }
    return results;
  };

  let running: Promise<string[]> | null = null;

  /**
   * Archive trees that have sat on the Settled shelf for the configured number
   * of days. The one recurring job that reads settled threads: it decides
   * from the sidebar's own rows and lists bb's threads only when one is due.
   */
  const archiveSettledThreads = (now = Date.now()): Promise<string[]> => {
    running ??= run(now).finally(() => {
      running = null;
    });
    return running;
  };

  const run = async (now: number): Promise<string[]> => {
    const configured = settings.readSidebarSettings();
    if (!configured.autoArchiveSettled || !isValidAutoArchiveAfterDays(configured.autoArchiveAfterDays)) return [];
    const afterMs = configured.autoArchiveAfterDays * DAY_MS;
    ctx.db
      .prepare(
        `DELETE FROM auto_archive_state
          WHERE thread_id NOT IN (SELECT thread_id FROM thread_lifecycle WHERE settled_at IS NOT NULL)`,
      )
      .run();
    const rows = new Map(readAll().map((row) => [row.threadId, row]));
    const due = [...rows.values()].flatMap((row) => {
      if (row.settledAt === null) return [];
      const state = stateFor(row.threadId, row.settledAt, now);
      if (state.attempts >= MAX_ARCHIVE_ATTEMPTS || (state.retry_at !== null && state.retry_at > now)) return [];
      return state.clock_start + afterMs <= now ? [state] : [];
    });
    if (due.length === 0) return [];

    const later = (state: StateRow, delayMs: number, change: Partial<StateRow> = {}) =>
      writeState({ ...state, retry_at: now + delayMs, ...change });

    let threads = await loadPolicyThreads(true);
    let byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const candidates: Array<{ state: StateRow; threadIds: string[] }> = [];
    for (const state of due) {
      if (!byId.has(state.thread_id)) {
        later(state, ABSENT_RETRY_MS, { archived_at: state.archived_at ?? now });
        continue;
      }
      if (state.archived_at !== null) {
        // Back from bb's archive with the same settle: it has been on the
        // Settled shelf only since it returned.
        writeState({ ...state, clock_start: now, attempts: 0, retry_at: null, archived_at: null });
        continue;
      }
      const tree = settledArchiveTree(threads, rows, state.thread_id, threadSignals, now);
      if (tree === null) {
        later(state, INELIGIBLE_RETRY_MS);
        continue;
      }
      // A thread settled later inside the tree, or one back from the
      // archive, restarts the tree's clock.
      const memberClock = (id: string) => {
        const member = readState(id);
        return member && member.settled_at === rows.get(id)?.settledAt ? member.clock_start : 0;
      };
      const dueAt =
        Math.max(
          tree.settledAt === state.settled_at ? state.clock_start : Math.max(state.clock_start, tree.settledAt),
          ...tree.threadIds.map(memberClock),
        ) + afterMs;
      if (dueAt > now) {
        later(state, dueAt - now);
        continue;
      }
      candidates.push({ state, threadIds: tree.threadIds });
    }
    if (candidates.length === 0) return [];

    // bb retires an archived thread's workspace only when no unarchived
    // thread uses it any more. One that a thread outside every tree this pass
    // may archive still uses stays as it is and needs no check; two due trees
    // sharing a workspace do not vouch for each other.
    const archiving = new Set(candidates.flatMap((candidate) => candidate.threadIds));
    const environmentsOf = (threadIds: readonly string[]) => {
      const ids = new Set(threadIds.map((id) => byId.get(id)?.environmentId ?? null).filter((id) => id !== null));
      for (const thread of threads) {
        if (!archiving.has(thread.id) && thread.environmentId) ids.delete(thread.environmentId);
      }
      return [...ids];
    };
    const statuses = await loadWorkspaceStatus([
      ...new Set(candidates.flatMap((candidate) => environmentsOf(candidate.threadIds))),
    ]);
    const clean = candidates.filter(({ state, threadIds }) => {
      const environments = environmentsOf(threadIds).map((id) => statuses.get(id));
      if (environments.every(isWorkspaceSafeToRetire)) return true;
      const unknown = environments.some((row) => row === undefined || row.outcome !== "available");
      later(state, unknown ? UNKNOWN_RETRY_MS : DIRTY_RETRY_MS);
      return false;
    });
    if (clean.length === 0) return [];
    const safeEnvironments = new Set([...statuses].flatMap(([id, row]) => (isWorkspaceSafeToRetire(row) ? [id] : [])));

    // The lookups took time. Archive only what still qualifies now.
    threads = await loadPolicyThreads(true);
    byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const archived: string[] = [];
    for (const { state, threadIds } of clean) {
      const current = settings.readSidebarSettings();
      if (!current.autoArchiveSettled || current.autoArchiveAfterDays !== configured.autoArchiveAfterDays) break;
      const freshRows = new Map(readAll().map((row) => [row.threadId, row]));
      const tree = byId.has(state.thread_id)
        ? settledArchiveTree(threads, freshRows, state.thread_id, threadSignals, Date.now())
        : null;
      const sameTree =
        tree !== null &&
        freshRows.get(state.thread_id)?.settledAt === state.settled_at &&
        tree.threadIds.length === threadIds.length &&
        tree.threadIds.every((id) => threadIds.includes(id)) &&
        environmentsOf(tree.threadIds).every((id) => safeEnvironments.has(id));
      if (!sameTree) continue;
      try {
        await withThreadChanges(threadIds, async () => {
          const result = await ctx.bb.sdk.threads.archive({ threadId: state.thread_id });
          const unexpected = result.archivedThreadIds.filter((id) => !threadIds.includes(id));
          if (unexpected.length > 0) {
            ctx.bb.log.warn(`Auto-archive of ${state.thread_id} also archived ${unexpected.join(", ")}`);
          }
        });
        writeState({ ...state, attempts: 0, retry_at: now + ABSENT_RETRY_MS, archived_at: now });
        archived.push(state.thread_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Thread update already in progress")) continue;
        const attempts = state.attempts + 1;
        const giveUp = attempts >= MAX_ARCHIVE_ATTEMPTS;
        writeState({ ...state, attempts, retry_at: giveUp ? null : now + HOUR_MS * 2 ** (attempts - 1) });
        ctx.bb.log.warn(
          giveUp
            ? `Auto-archive gave up on ${state.thread_id} after ${attempts} failed attempts: ${message}`
            : `Auto-archive of ${state.thread_id} failed (attempt ${attempts} of ${MAX_ARCHIVE_ATTEMPTS}): ${message}`,
        );
      }
    }
    return archived;
  };

  /**
   * A thread back from bb's archive, however it got there, starts a new wait
   * from now; so does the tree it returns into.
   */
  const restartClock = (threadId: string, now = Date.now()) => {
    const row = readOne(threadId);
    if (row?.settledAt == null) return;
    writeState({
      thread_id: threadId,
      settled_at: row.settledAt,
      clock_start: now,
      attempts: 0,
      retry_at: null,
      archived_at: null,
    });
  };

  return { archiveSettledThreads, restartClock };
}
