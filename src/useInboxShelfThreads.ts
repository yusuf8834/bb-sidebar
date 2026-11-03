import { useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";
import {
  filterByProjects,
  hideChildrenOfVisibleParents,
  partitionPinned,
  sortByCreatedAtDescending,
  sortSettledThreads,
  visibleInboxThreads,
} from "./inbox";
import { activeRepresentativeThreadId } from "./inbox-layout";
import { isInactiveThread } from "./inactive";
import { isWorkingTree } from "./working-tree";
import { threadNeedsAttention } from "./useRenamingShelfLocks";
import { threadsWithAskingDescendants } from "./child-status";
import { filterThreads, hostNames, type Shelf } from "./thread-filter";
import { useThreadFilter } from "./useThreadFilter";

interface InboxShelfThreadsOptions {
  activeThreadId: string | null;
  childrenByParentId: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  inactiveAfterHours: number | null;
  lifecycle: LifecycleApi;
  now: number;
  renamingShelfLocks: ReadonlyMap<string, "active" | "working" | "inactive">;
  scope: readonly string[];
  threads: readonly PluginSidebarThread[];
  workingShelfEnabled: boolean;
}

export function useInboxShelfThreads({
  activeThreadId,
  childrenByParentId,
  inactiveAfterHours,
  lifecycle,
  now,
  renamingShelfLocks,
  scope,
  threads,
  workingShelfEnabled,
}: InboxShelfThreadsOptions) {
  // The filter bar's machines, states, shelves, and keyword narrow every shelf.
  const [filter, onFilterChange] = useThreadFilter();
  const hosts = useMemo(() => hostNames(threads), [threads]);
  const threadFilter = useMemo(() => ({ filter, onFilterChange, hosts }), [filter, onFilterChange, hosts]);
  const shelves = useMemo(() => {
    const allVisible = visibleInboxThreads(threads);
    // A child's question shows only inside its parent's tree, so the tree
    // answers for it in Active, as it would for the parent's own question.
    const askingParentIds = threadsWithAskingDescendants(threads);
    const scoped = filterThreads(filterByProjects(allVisible, scope), filter, (thread) => ({
      needsYou: threadNeedsAttention(thread) || askingParentIds.has(thread.id),
      working: isWorkingTree(thread, childrenByParentId.get(thread.id) ?? [], childrenByParentId),
    }));
    // Children live in their parent's header chip instead of the flat list;
    // an orphan whose parent is not on screen stays here.
    const visible = hideChildrenOfVisibleParents(scoped);
    const active: typeof visible = [];
    const onParkedShelf: typeof visible = [];
    const onSnoozeShelf: typeof visible = [];
    const onSettledShelf: typeof visible = [];
    for (const thread of visible) {
      const shelf = lifecycle.shelfFor(thread);
      if (shelf === "parked") onParkedShelf.push(thread);
      else if (shelf === "snoozed") onSnoozeShelf.push(thread);
      else if (shelf === "settled") onSettledShelf.push(thread);
      else active.push(thread);
    }
    const split = partitionPinned(active);
    const activeUnpinned: typeof split.inbox = [];
    const working: typeof split.inbox = [];
    const inactive: typeof split.inbox = [];
    for (const thread of split.inbox) {
      const lockedShelf = renamingShelfLocks.get(thread.id);
      const needsAttention = threadNeedsAttention(thread) || askingParentIds.has(thread.id);
      if (lockedShelf === "active") {
        activeUnpinned.push(thread);
        continue;
      }
      if (lockedShelf === "working" && workingShelfEnabled && !needsAttention && !lifecycle.wokeFor(thread)) {
        working.push(thread);
        continue;
      }
      if (lockedShelf === "inactive" && !needsAttention) {
        inactive.push(thread);
        continue;
      }
      // A thread with work running anywhere under it waits on the Working
      // shelf, unless it just woke from a snooze: that is news for Active.
      // A child's question is news too, however long the parent sat idle.
      if (
        workingShelfEnabled &&
        !lifecycle.wokeFor(thread) &&
        isWorkingTree(thread, childrenByParentId.get(thread.id) ?? [], childrenByParentId)
      ) {
        working.push(thread);
      } else if (!askingParentIds.has(thread.id) && isInactiveThread(thread, now, inactiveAfterHours)) {
        inactive.push(thread);
      } else {
        activeUnpinned.push(thread);
      }
    }
    const allSplit = partitionPinned(allVisible);
    // An is:<shelf> filter empties every shelf it does not name.
    const shelf = <T>(name: Shelf, rows: T[]): T[] =>
      filter.shelves.length === 0 || filter.shelves.includes(name) ? rows : [];
    return {
      activeListThreadId: activeRepresentativeThreadId(threads, activeThreadId, visible),
      // BB supplies pinned rows in the user's persisted pin order.
      pinnedBase: shelf("pinned", split.pinned),
      inboxBase: shelf("active", sortByCreatedAtDescending(activeUnpinned)),
      // The Working shelf is where Active's running threads wait, so it follows is:active.
      workingBase: shelf("active", sortByCreatedAtDescending(working)),
      inactiveBase: shelf("inactive", sortByCreatedAtDescending(inactive)),
      // Keep a global order behind project-scoped and parked views. Child and
      // parked rows are included because they can become visible later; a
      // reorder elsewhere must not silently discard their old slot.
      allPinnedBase: allSplit.pinned,
      allInboxBase: sortByCreatedAtDescending(allSplit.inbox),
      parked: shelf("parked", sortSettledThreads(onParkedShelf, lifecycle.parkedAtFor)),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozed: shelf(
        "snoozed",
        [...onSnoozeShelf].sort((left, right) => (lifecycle.wakeAtFor(left) ?? 0) - (lifecycle.wakeAtFor(right) ?? 0)),
      ),
      settled: shelf("settled", sortSettledThreads(onSettledShelf, lifecycle.settledAtFor)),
    };
  }, [
    activeThreadId,
    childrenByParentId,
    inactiveAfterHours,
    lifecycle,
    now,
    renamingShelfLocks,
    scope,
    filter,
    threads,
    workingShelfEnabled,
  ]);
  return { ...shelves, threadFilter };
}
