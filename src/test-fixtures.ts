import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

/**
 * Sidebar-thread fields no test here varies: an idle, visible, unpinned,
 * unarchived thread. Spread first in a factory so its own defaults and the
 * test's overrides win.
 */
export const idleSidebarThreadFields = {
  displayTitle: "",
  lifecycleOwnerThreadId: null,
  parentNotifications: "auto",
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

/**
 * The `runtimeStatus` behind the status a test gives a thread. bb derives
 * the indicator from `runtimeStatus`, and the sidebar's display rule reads
 * it through bb's status resolver, so a thread a test marks as running with
 * `indicator: "runtime"` or an in-flight `status` also runs by this field.
 * An explicit `runtimeStatus` wins.
 */
function runtimeStatusFor(
  overrides: Pick<Partial<PluginSidebarThread>, "indicator" | "runtimeStatus" | "status">,
): PluginSidebarThread["runtimeStatus"] {
  if (overrides.runtimeStatus !== undefined) return overrides.runtimeStatus;
  const status = overrides.status ?? idleSidebarThreadFields.status;
  return overrides.indicator === "runtime" && (status === "idle" || status === "error") ? "active" : status;
}

/**
 * A sidebar thread for tests: idle and unpinned unless overridden, with a
 * `runtimeStatus` that matches the status the overrides give it.
 */
export function sidebarThread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    runtimeStatus: runtimeStatusFor(overrides),
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
