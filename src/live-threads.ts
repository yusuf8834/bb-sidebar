import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { resolveRowShelf, sidebarThreadSignals, type ThreadLifecycleRow } from "./lifecycle";
import { shelfRowIds } from "./inbox";
import { threadsWithAskingDescendants } from "./child-status";

/**
 * Unarchived threads whose sidebar row sits on the Settled shelf. Recurring
 * background lookups skip these; everything else, Snoozed, Parked and the
 * Inactive shelf included, stays live.
 *
 * A child goes wherever its row thread goes (`shelfRowIds`), as in
 * `bb sidebar list`. Rows are placed over every unarchived thread, not the
 * project scope, so changing the picker never changes what is looked up.
 *
 * This needs no limit rows: they only keep a snooze waiting on its scheduled
 * Continue (`waitsForScheduledContinue` requires a snooze), and a snoozed row
 * is never settled. That is what lets the rate-limit provider sit above the
 * hook that reads limit rows to place snoozed threads.
 */
export function settledThreadIds(
  threads: readonly PluginSidebarThread[],
  rows: ReadonlyMap<string, ThreadLifecycleRow>,
  now: number,
): Set<string> {
  const unarchived = threads.filter((thread) => !thread.isArchived);
  const byId = new Map(unarchived.map((thread) => [thread.id, thread] as const));
  const rowIds = shelfRowIds(unarchived);
  const asking = threadsWithAskingDescendants(threads);
  const rowSettled = new Map<string, boolean>();
  const settled = new Set<string>();
  for (const thread of unarchived) {
    // A thread in a parent cycle has no sidebar row; it keeps its own.
    const rowThread = byId.get(rowIds.get(thread.id) ?? thread.id)!;
    let isSettled = rowSettled.get(rowThread.id);
    if (isSettled === undefined) {
      const signals = sidebarThreadSignals(rowThread);
      if (asking.has(rowThread.id)) signals.hasPendingInteraction = true;
      isSettled = resolveRowShelf(rows.get(rowThread.id), signals, now, rowThread.isPinned) === "settled";
      rowSettled.set(rowThread.id, isSettled);
    }
    if (isSettled) settled.add(thread.id);
  }
  return settled;
}

/**
 * The workspaces the recurring port scan covers: those of live threads. A
 * workspace shared with a live thread is live; one that only settled threads
 * use is scanned when one of them is looked at.
 */
export function portScanEnvironments(
  threads: readonly PluginSidebarThread[],
  settled: ReadonlySet<string>,
): { live: string[]; settledOnly: Set<string> } {
  const live = new Set<string>();
  const settledOnly = new Set<string>();
  for (const thread of threads) {
    const environmentId = thread.environment?.id;
    if (thread.isArchived || !environmentId) continue;
    (settled.has(thread.id) ? settledOnly : live).add(environmentId);
  }
  for (const environmentId of live) settledOnly.delete(environmentId);
  return { live: [...live].sort(), settledOnly };
}
