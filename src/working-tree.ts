import type { PluginSidebarThread, PluginSidebarThreadRowStatus } from "@get-bb/plugin-sdk/app";
import { resolveThreadStatus } from "./bb-sdk";
import { childSubtree, threadAsksForInput, type ThreadWorking } from "./child-status";

/**
 * Whether a thread is working, for display: bb's own rule, from bb's status
 * resolver, over the thread and its own row status. A running runtime, any
 * workflow, background agent, background command or plan mode, and another
 * plugin's status with the "running" tone all count. A thread whose machine
 * is disconnected, or that has not started, does not.
 *
 * Display only. Parking, settling, shelf placement and the working clock keep
 * `isThreadWorking` from shared lifecycle.ts, which the server mirrors from
 * rows that never carry another plugin's status.
 */
export function isThreadWorkingForDisplay(
  thread: PluginSidebarThread,
  rowStatus: PluginSidebarThreadRowStatus | null,
): boolean {
  return resolveThreadStatus({ thread, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus }).isWorking;
}

/**
 * Whether a thread, or anything under it, still has work running, by
 * `isWorking` (isThreadWorkingForDisplay with each thread's own row status).
 * Children are asked one by one rather than passed to bb as hidden threads,
 * so each answers with its own row status.
 *
 * The thread itself needing you, or failing, outranks its children's work:
 * that is the user's cue, so such a thread never counts as working here.
 * A descendant waiting on the user outranks the rest of the tree's work too:
 * its question shows only inside this tree, so the tree must stay in view.
 *
 * Decides both the compact row and the Working shelf.
 */
export function isWorkingTree(
  thread: PluginSidebarThread,
  childThreads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  isWorking: ThreadWorking,
): boolean {
  if (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" ||
    thread.queuedWork === "failed"
  ) {
    return false;
  }
  const descendants = childSubtree(childThreads, childrenByParent);
  if (descendants.some(threadAsksForInput)) return false;
  if (isWorking(thread)) return true;
  return descendants.some(
    (child) => child.indicator !== "unread-error" && child.queuedWork !== "failed" && isWorking(child),
  );
}
