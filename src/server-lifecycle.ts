import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerContext } from "./server-context";
import type { SettledOverride } from "./auto-settle";
import { LIFECYCLE_CHANNEL } from "./contract";
import { canPark, hasLiveWork, isTurnInFlight, resolveRowShelf } from "./lifecycle";
import { threadTreeIds } from "./thread-tree";
import { shelfRowIds } from "./inbox";

/** One-time data repairs that need bb's thread tree, which SQL cannot see. */
export const LIFECYCLE_BACKFILLS_MIGRATION = `CREATE TABLE IF NOT EXISTS lifecycle_backfills (
  name TEXT PRIMARY KEY
)`;
// The first repair ("settled-child-rows") reached only children with no row.
// This one also reaches children whose own row leaves them Active, so it runs
// once more on installs that already ran the first.
const SETTLED_CHILD_ROWS_BACKFILL = "settled-child-rows-v2";

export interface StoredLifecycleRow {
  threadId: string;
  parkedAt?: number | null;
  settledAt: number | null;
  settledOverride: SettledOverride | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
}
interface LifecycleDbRow {
  thread_id: string;
  parked_at: number | null;
  settled_at: number | null;
  settled_override: SettledOverride | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
}

export function createServerLifecycle(ctx: ServerContext) {
  const readAll = (): StoredLifecycleRow[] =>
    (
      ctx.db
        .prepare(
          `SELECT thread_id, settled_at, settled_override,
                  snoozed_until, snoozed_at, parked_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      parkedAt: row.parked_at,
      settledAt: row.settled_at,
      settledOverride: row.settled_override,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    }));

  const readOne = (threadId: string): StoredLifecycleRow | null => {
    const row = ctx.db
      .prepare(
        `SELECT thread_id, settled_at, settled_override,
                snoozed_until, snoozed_at, parked_at
           FROM thread_lifecycle
          WHERE thread_id = ?`,
      )
      .get(threadId) as LifecycleDbRow | undefined;
    return row
      ? {
          threadId: row.thread_id,
          parkedAt: row.parked_at,
          settledAt: row.settled_at,
          settledOverride: row.settled_override,
          snoozedUntil: row.snoozed_until,
          snoozedAt: row.snoozed_at,
        }
      : null;
  };

  const write = (row: StoredLifecycleRow, publish = true): void => {
    ctx.db
      .prepare(
        `INSERT INTO thread_lifecycle
         (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         settled_override = excluded.settled_override,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at,
         parked_at = excluded.parked_at`,
      )
      .run(row.threadId, row.settledAt, row.settledOverride, row.snoozedUntil, row.snoozedAt, row.parkedAt ?? null);
    if (publish) {
      ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
    }
  };

  const writeMany = ctx.db.transaction((rows: readonly StoredLifecycleRow[]) => {
    for (const row of rows) write(row, false);
  });

  const publishLifecycleChanges = (threadIds: readonly string[]): void => {
    if (threadIds.length === 0) return;
    ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadIds });
  };

  const clear = (threadId: string): void => {
    ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
    ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  const clearSettlingState = (threadId: string): boolean => {
    const row = readOne(threadId);
    if (row === null || (row.settledAt === null && row.settledOverride === null && row.parkedAt == null)) {
      return false;
    }
    if (row.snoozedUntil === null) {
      ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(threadId);
    } else {
      write(
        {
          ...row,
          settledAt: null,
          settledOverride: null,
        },
        false,
      );
    }
    ctx.bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
    return true;
  };

  const sameLifecycle = (left: StoredLifecycleRow | null, right: StoredLifecycleRow | null) =>
    JSON.stringify(left) === JSON.stringify(right);

  type AncestorThread = Pick<
    Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
    "id" | "parentThreadId" | "archivedAt" | "deletedAt"
  >;

  const wakeAncestors = async (
    thread: { id: string; parentThreadId: string | null },
    {
      automaticOnly = false,
      threadsById,
    }: {
      automaticOnly?: boolean;
      threadsById?: ReadonlyMap<string, AncestorThread>;
    } = {},
  ) => {
    if (thread.parentThreadId === null) return [];
    // Capture all shelves before the first lookup, including ancestors whose
    // IDs we will only learn after an earlier request finishes.
    const previousRows = new Map(readAll().map((row) => [row.threadId, row]));
    const visited = new Set([thread.id]);
    const ancestors: string[] = [];
    let parentId: string | null = thread.parentThreadId;
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      let parent: AncestorThread | undefined;
      try {
        // RPCs and policy passes already loaded the complete tree. Do not
        // introduce another network failure after their shelf writes succeed.
        parent = threadsById ? threadsById.get(parentId) : await ctx.bb.sdk.threads.get({ threadId: parentId });
      } catch (error) {
        ctx.bb.log.warn(
          `Could not load ancestor ${parentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
      if (!parent || parent.archivedAt !== null || parent.deletedAt !== null) break;
      ancestors.push(parent.id);
      parentId = parent.parentThreadId;
    }
    // A Settle completed while the ancestors were loading. Keep that newer
    // decision rather than reopening a tree that is already quiet again.
    if (readOne(thread.id)?.settledAt != null) return [];
    const changed = ctx.db.transaction(() => {
      const ids: string[] = [];
      for (const id of ancestors) {
        const row = readOne(id);
        if (!row || (row.settledAt === null && row.parkedAt == null && row.snoozedUntil === null)) continue;
        // A newer manual shelf choice wins over this older child event and
        // protects the ancestors above it as well.
        if (!sameLifecycle(row, previousRows.get(id) ?? null)) break;
        // Reversing an automatic rule is not new child activity. Keep the
        // user's manual shelf choice, including older parent-only settles.
        if (automaticOnly && (row.settledOverride != null || row.parkedAt != null || row.snoozedUntil != null)) break;
        ctx.db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(id);
        ids.push(id);
      }
      return ids;
    })();
    publishLifecycleChanges(changed);
    return changed;
  };

  // Pin, reparent and tree Settle must not validate the same old state.
  const pinParentChanges = new Set<string>();

  const withThreadChanges = async <T>(threadIds: string[], change: () => Promise<T>): Promise<T> => {
    if (threadIds.some((id) => pinParentChanges.has(id))) {
      throw new Error("Thread update already in progress. Try again.");
    }
    threadIds.forEach((id) => pinParentChanges.add(id));
    try {
      return await change();
    } finally {
      threadIds.forEach((id) => pinParentChanges.delete(id));
    }
  };

  const withPinParentChange = <T>(threadId: string, change: () => Promise<T>) => withThreadChanges([threadId], change);

  const readInboxOrder = (): string[] =>
    (
      ctx.db
        .prepare(
          `SELECT thread_id
             FROM inbox_order
            ORDER BY sort_index ASC, thread_id ASC`,
        )
        .all() as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);

  const replaceInboxOrder = ctx.db.transaction((inboxThreadIds: string[]) => {
    ctx.db.prepare(`DELETE FROM inbox_order`).run();
    const insert = ctx.db.prepare(`INSERT INTO inbox_order (thread_id, sort_index) VALUES (?, ?)`);
    inboxThreadIds.forEach((threadId, index) => insert.run(threadId, index));
  });

  // Both endpoints supply complete activity summaries. Project groups provide
  // visible rows in one call; only the paged thread endpoint includes helpers.
  // Use one source per read so an older project row cannot resurrect an archived
  // or deleted thread omitted from the newer thread list.
  const loadPolicyThreads = async (includeHidden = false) => {
    if (!includeHidden) {
      const projects = await ctx.bb.sdk.projects.list({ include: "threads", includePersonal: true });
      return projects.flatMap((project) =>
        "threads" in project
          ? project.threads.filter(
              (thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible",
            )
          : [],
      );
    }
    const byId = new Map<string, Awaited<ReturnType<typeof ctx.bb.sdk.threads.list>>[number]>();
    // Same page size as port discovery; bb sets no upper bound on this list.
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const page = await ctx.bb.sdk.threads.list({ archived: false, includeHidden: true, limit, offset });
      for (const thread of page) {
        if (thread.archivedAt === null && thread.deletedAt === null) byId.set(thread.id, { ...thread });
        else byId.delete(thread.id);
      }
      if (page.length < limit) break;
    }
    return [...byId.values()];
  };

  /** One thread under loadPolicyThreads' rules, without listing every thread. */
  const loadPolicyThread = async (threadId: string, includeHidden = false) => {
    const [thread] = await ctx.bb.sdk.threads.list({ threadIds: [threadId], archived: false, includeHidden });
    if (!thread || thread.id !== threadId || thread.archivedAt !== null || thread.deletedAt !== null) return undefined;
    return includeHidden || thread.visibility === "visible" ? thread : undefined;
  };

  type CleanupThread = Awaited<ReturnType<typeof loadPolicyThreads>>[number];

  const threadSignals = (thread: CleanupThread) => ({
    hasPendingInteraction: thread.hasPendingInteraction,
    hasQueuedWork: thread.queuedWork !== "none",
    isWorking: hasLiveWork(
      {
        workflows: thread.activity.activeWorkflowCount,
        backgroundAgents: thread.activity.activeBackgroundAgentCount,
        backgroundCommands: thread.activity.activeBackgroundCommandCount,
        planMode: thread.activity.activePlanModeCount,
        goals: thread.activity.activeGoalCount,
      },
      isTurnInFlight(thread.status),
    ),
    isUnread: thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
  });

  const settleTree = (threads: readonly CleanupThread[], threadId: string) => {
    const ids = new Set(threadTreeIds(threads, threadId));
    const tree = threads.filter((thread) => ids.has(thread.id));
    if (!tree.some((thread) => thread.id === threadId)) {
      throw new Error("Thread is no longer available");
    }
    return tree;
  };

  const loadSettleTree = async (threadId: string) => settleTree(await loadPolicyThreads(true), threadId);

  // A child's own row that does not shelve it: none, an explicit Active, or a
  // snooze that has run out. A live snooze or a park is the user's choice.
  const leavesChildActive = (row: StoredLifecycleRow | null, now: number) =>
    row === null ||
    (row.settledAt === null && row.parkedAt == null && (row.snoozedUntil === null || row.snoozedUntil <= now));

  /**
   * Rows that file quiet children inside a settled tree with that tree, as a
   * tree Settle does. The sidebar already draws such a child inside its
   * settled parent; without the row the server counts it as Active, where it
   * protects a shared workspace from cleanup forever. The tree's row is the
   * one the sidebar places it by: its top thread's. A child with something
   * newer to say than that settle keeps its own row.
   */
  const settledTreeRows = (
    threads: readonly CleanupThread[],
    candidates: readonly CleanupThread[],
    now: number,
  ): StoredLifecycleRow[] => {
    const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const rowIds = shelfRowIds(threads);
    return candidates.flatMap((thread) => {
      const topId = rowIds.get(thread.id);
      if (thread.pinnedAt !== null || !topId || topId === thread.id) return [];
      const top = byId.get(topId)!;
      const topRow = readOne(topId);
      if (!topRow || resolveRowShelf(topRow, threadSignals(top), now, top.pinnedAt !== null) !== "settled") return [];
      if (!leavesChildActive(readOne(thread.id), now) || !canPark(threadSignals(thread))) return [];
      if (thread.latestAttentionAt > topRow.settledAt!) return [];
      return [
        {
          threadId: thread.id,
          settledAt: topRow.settledAt,
          settledOverride: topRow.settledOverride,
          snoozedUntil: null,
          snoozedAt: null,
          parkedAt: null,
        },
      ];
    });
  };

  // Settle wrote only the root's row before it covered whole trees, and a
  // child archived when its tree settled came back from the archive without
  // one. Repair those trees once.
  const backfillSettledChildRows = (threads: readonly CleanupThread[], now = Date.now()): string[] => {
    const done = ctx.db.prepare(`SELECT 1 FROM lifecycle_backfills WHERE name = ?`);
    if (done.get(SETTLED_CHILD_ROWS_BACKFILL)) return [];
    const written = ctx.db.transaction(() => {
      const rows = settledTreeRows(threads, threads, now);
      for (const row of rows) write(row, false);
      ctx.db.prepare(`INSERT OR IGNORE INTO lifecycle_backfills (name) VALUES (?)`).run(SETTLED_CHILD_ROWS_BACKFILL);
      return rows.map((row) => row.threadId);
    })();
    publishLifecycleChanges(written);
    return written;
  };

  /** A thread back from the archive inside a settled tree is settled with it, with its subtree. */
  const settleUnarchivedTree = async (threadId: string, now = Date.now()): Promise<string[]> => {
    const threads = await loadPolicyThreads(true);
    const ids = new Set(threadTreeIds(threads, threadId));
    const written = ctx.db.transaction(() => {
      const rows = settledTreeRows(
        threads,
        threads.filter((thread) => ids.has(thread.id)),
        now,
      );
      for (const row of rows) write(row, false);
      return rows.map((row) => row.threadId);
    })();
    publishLifecycleChanges(written);
    return written;
  };

  return {
    readAll,
    readOne,
    write,
    writeMany,
    publishLifecycleChanges,
    clear,
    clearSettlingState,
    sameLifecycle,
    wakeAncestors,
    withThreadChanges,
    withPinParentChange,
    readInboxOrder,
    replaceInboxOrder,
    loadPolicyThreads,
    loadPolicyThread,
    threadSignals,
    settleTree,
    loadSettleTree,
    backfillSettledChildRows,
    settleUnarchivedTree,
  };
}

export type CleanupThread = Awaited<ReturnType<ReturnType<typeof createServerLifecycle>["loadPolicyThreads"]>>[number];
