import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

/**
 * Sidebar-thread fields no test here varies: an idle, visible, unpinned,
 * unarchived thread. Spread first in a factory so its own defaults and the
 * test's overrides win.
 */
export const idleSidebarThreadFields = {
  displayTitle: "",
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  pinnedAt: null,
  pinSortKey: null,
  archivedAt: null,
  href: "",
  isHidden: false,
} satisfies Partial<PluginSidebarThread>;

type ListedThread = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["list"]>>[number];

export function archivedListThread(overrides: Partial<ListedThread> & { id: string }): ListedThread {
  return {
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    archivedAt: 500, createdAt: 100, deletedAt: null,
    environmentBranchName: null, environmentHostId: null, environmentId: null,
    environmentIsWorktree: null, environmentName: null, environmentPath: null,
    environmentProviderId: null, environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false, lastReadAt: 100, latestAttentionAt: 100,
    lifecycleOwnerThreadId: null, originKind: null, originPluginId: null,
    parentThreadId: null, pinSortKey: null, pinnedAt: null,
    projectId: "proj_1", providerId: "codex", queuedWork: "none",
    runtime: { displayStatus: "idle" }, sectionId: null, sourceThreadId: null,
    status: "idle", title: "Archived thread", titleFallback: null,
    updatedAt: 100, visibility: "visible",
    ...overrides,
  };
}
