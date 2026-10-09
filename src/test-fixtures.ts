import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

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
