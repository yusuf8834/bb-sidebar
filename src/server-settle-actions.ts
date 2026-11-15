import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerLifecycle, StoredLifecycleRow, CleanupThread } from "./server-lifecycle";
import type { createServerSettleCleanup } from "./server-settle-cleanup";
import { randomUUID } from "node:crypto";
import { threadTreeIds } from "./thread-tree";
import { canPark } from "./lifecycle";
import { threadStoredTitle } from "./inbox";
import { sortPinnedThreads } from "./pinned-order";
import { EMPTY_RECLAIM } from "./reclaim";
import { runThreadTasks } from "./thread-tasks";

export function createServerSettleActions(
  ctx: ServerContext,
  lifecycle: ReturnType<typeof createServerLifecycle>,
  cleanup: ReturnType<typeof createServerSettleCleanup>,
) {
  const {
    loadPolicyThreads,
    threadSignals,
    readOne,
    sameLifecycle,
    withThreadChanges,
    loadSettleTree,
    writeMany,
    publishLifecycleChanges,
    write,
    settleTree,
    wakeAncestors,
  } = lifecycle;
  const { reclaimThreadResources, cleanupError } = cleanup;
  // Undo belongs to one completed action, not to a later Return to Active.
  // Toasts are short-lived; bound snapshots and expire them after five minutes.
  const settleUndos = new Map<
    string,
    {
      threadId: string;
      settledAt: number;
      expiresAt: number;
      previous: Array<{ threadId: string; parentThreadId: string | null; row: StoredLifecycleRow | null }>;
    }
  >();
  ctx.bb.onDispose(() => settleUndos.clear());
  let lastManualSettleAt = 0;

  const matchesSettle = (row: StoredLifecycleRow | null, settledAt: number) =>
    row?.settledAt === settledAt &&
    row.settledOverride === "settled" &&
    row.parkedAt == null &&
    row.snoozedUntil === null &&
    row.snoozedAt === null;

  const handlers = {
    async settle({ threadId }) {
      const allThreads = await loadPolicyThreads(true);
      const ids = new Set(threadTreeIds(allThreads, threadId));
      const tree = allThreads.filter((thread) => ids.has(thread.id));
      if (!tree.some((thread) => thread.id === threadId)) throw new Error("Thread is no longer available");
      const { currentTree, now, previous, cleanupRows, cleanupOwner } = await withThreadChanges([...ids], async () => {
        const busy = tree.find((thread) => !canPark(threadSignals(thread)));
        if (busy) throw new Error(`Cannot settle while ${threadStoredTitle(busy)} is working or waiting for input`);
        const beforeRows = new Map(tree.map((thread) => [thread.id, readOne(thread.id)]));
        const pins = sortPinnedThreads(
          allThreads.filter((thread) => thread.pinnedAt !== null && thread.parentThreadId === null),
        );
        const unpinned: CleanupThread[] = [];
        try {
          for (const thread of tree) {
            if (thread.pinnedAt === null) continue;
            await ctx.bb.sdk.threads.unpin({ threadId: thread.id });
            unpinned.push(thread);
          }
          const currentTree = await loadSettleTree(threadId);
          const beforeById = new Map(tree.map((thread) => [thread.id, thread]));
          if (
            currentTree.length !== tree.length ||
            currentTree.some((thread) => {
              const before = beforeById.get(thread.id);
              return (
                !before ||
                thread.parentThreadId !== before.parentThreadId ||
                thread.pinnedAt !== null ||
                thread.latestAttentionAt > before.latestAttentionAt ||
                !canPark(threadSignals(thread)) ||
                !sameLifecycle(readOne(thread.id), beforeRows.get(thread.id)!)
              );
            })
          )
            throw new Error("Thread tree changed while settling. Try again.");
          // Distinguish actions in the same millisecond when checking stale Undo.
          const now = Math.max(Date.now(), lastManualSettleAt + 1);
          lastManualSettleAt = now;
          const previous = currentTree.map((thread) => ({
            threadId: thread.id,
            parentThreadId: thread.parentThreadId,
            row: readOne(thread.id),
          }));
          writeMany(
            currentTree.map((thread) => ({
              threadId: thread.id,
              settledAt: now,
              settledOverride: "settled" as const,
              snoozedUntil: null,
              snoozedAt: null,
            })),
          );
          publishLifecycleChanges(currentTree.map((thread) => thread.id));
          // Capture ownership before yielding back to another shelf action.
          const cleanupRows = new Map(currentTree.map((thread) => [thread.id, readOne(thread.id)]));
          const cleanupOwner = { threadId, row: readOne(threadId) };
          return { currentTree, now, previous, cleanupRows, cleanupOwner };
        } catch (error) {
          const failed: string[] = [];
          for (const original of unpinned.reverse()) {
            try {
              const current = await ctx.bb.sdk.threads.get({ threadId: original.id });
              // Preserve subsequent native pins, parent changes and shelf choices.
              if (
                current.pinnedAt !== null ||
                current.parentThreadId !== original.parentThreadId ||
                !sameLifecycle(readOne(original.id), beforeRows.get(original.id)!)
              )
                continue;
              await ctx.bb.sdk.threads.pin({ threadId: original.id });
              const index = pins.findIndex((thread) => thread.id === original.id);
              await ctx.bb.sdk.threads.reorderPinned({
                threadId: original.id,
                previousThreadId: pins[index - 1]?.id ?? null,
                nextThreadId: pins[index + 1]?.id ?? null,
              });
            } catch {
              failed.push(threadStoredTitle(original));
            }
          }
          if (failed.length)
            throw new Error(`${cleanupError(error)}. Could not restore pins for: ${failed.join(", ")}`);
          throw error;
        }
      });
      // The shelf move is durable before anything is released, so a slow or
      // unreachable host delays the reminder without holding up the settle.
      const reclaim = { ...EMPTY_RECLAIM };
      await runThreadTasks(
        currentTree.map((thread) => thread.id),
        async (id) => {
          const released = await reclaimThreadResources(
            id,
            currentTree.find((thread) => thread.id === id),
            cleanupRows.get(id),
            cleanupOwner,
          );
          reclaim.closedTerminals += released.closedTerminals;
          reclaim.keptTerminals += released.keptTerminals;
          reclaim.stoppedRuntime ||= released.stoppedRuntime;
        },
      );
      const undoToken = randomUUID();
      for (const [token, undo] of settleUndos) {
        if (undo.expiresAt <= Date.now()) settleUndos.delete(token);
      }
      while (settleUndos.size >= 50) settleUndos.delete(settleUndos.keys().next().value!);
      settleUndos.set(undoToken, { threadId, settledAt: now, expiresAt: Date.now() + 5 * 60_000, previous });
      return { ok: true, reclaim, undoToken };
    },
    async unsettle({ threadId, undoToken }) {
      if (undoToken !== undefined) {
        const undo = settleUndos.get(undoToken);
        if (!undo || undo.threadId !== threadId || undo.expiresAt <= Date.now()) {
          throw new Error("This Settle can no longer be undone. Use Return to Active instead.");
        }
        const tree = new Map((await loadSettleTree(threadId)).map((thread) => [thread.id, thread]));
        const restored = ctx.db.transaction(() => {
          const ids: string[] = [];
          for (const previous of undo.previous) {
            const thread = tree.get(previous.threadId);
            // Keep newer shelf choices, activity, pinning, and parent changes.
            if (
              !thread ||
              thread.parentThreadId !== previous.parentThreadId ||
              thread.pinnedAt !== null ||
              !canPark(threadSignals(thread)) ||
              !matchesSettle(readOne(thread.id), undo.settledAt)
            )
              continue;
            if (previous.row) write(previous.row, false);
            else ctx.db.prepare("DELETE FROM thread_lifecycle WHERE thread_id = ?").run(thread.id);
            ids.push(thread.id);
          }
          return ids;
        })();
        settleUndos.delete(undoToken);
        publishLifecycleChanges(restored);
        return { ok: true };
      }
      const threads = await loadPolicyThreads(true);
      const tree = settleTree(threads, threadId);
      const restoring = tree.filter((thread) => thread.id === threadId || readOne(thread.id)?.settledAt != null);
      ctx.db.transaction(() => {
        for (const thread of restoring) {
          if (thread.id === threadId) {
            write({ threadId, settledAt: null, settledOverride: "active", snoozedUntil: null, snoozedAt: null }, false);
          } else {
            // Returning the parent is not an independent permanent Active choice
            // for every descendant. They resume their ordinary automatic rules.
            ctx.db.prepare("DELETE FROM thread_lifecycle WHERE thread_id = ?").run(thread.id);
          }
        }
      })();
      publishLifecycleChanges(restoring.map((thread) => thread.id));
      await wakeAncestors(tree.find((thread) => thread.id === threadId)!, {
        threadsById: new Map(threads.map((thread) => [thread.id, thread])),
      });
      return { ok: true };
    },
  } satisfies Pick<ServerHandlers, "settle" | "unsettle">;

  return { handlers };
}
