import { useSidebarThreadRowStatuses, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { isWorkingTree } from "./working-tree";

/** {@link isWorkingTree} with the row statuses other plugins set. */
export function useIsWorkingTree(
  thread: PluginSidebarThread,
  childThreads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
): boolean {
  return isWorkingTree(thread, childThreads, childrenByParent, useSidebarThreadRowStatuses());
}
