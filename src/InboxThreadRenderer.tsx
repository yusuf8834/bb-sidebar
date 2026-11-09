import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ThreadCard, type ThreadReorderControls } from "./ThreadCard";
import { memo, useCallback } from "react";
import { useInboxEnvironment, useInboxActions, useInboxActivity } from "./InboxContext";
import { sortsActiveByTime, type ActiveSortMode } from "./inbox-layout";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";

type ActiveShelfKind = "pinned" | "inbox";

const NO_CHILDREN: readonly PluginSidebarThread[] = [];

type ReorderControls = (thread: PluginSidebarThread, shelf: ActiveShelfKind) => ThreadReorderControls;

// The wrapper receives stable row inputs. Menu hooks and card rendering stay
// behind this boundary when another shelf expands or collapses.
const InboxThread = memo(function InboxThread({
  thread,
  shelf,
  reorderable,
  showProject,
  compact,
  renameShelf,
  showEnvironment,
  isWoke,
  childrenExpanded,
  threadReorderControls,
  activeSortMode,
}: {
  thread: PluginSidebarThread;
  shelf: ActiveShelfKind;
  reorderable: boolean;
  showProject: boolean;
  compact: boolean;
  renameShelf: "active" | "working" | "inactive";
  showEnvironment: boolean;
  isWoke: boolean;
  childrenExpanded: boolean;
  threadReorderControls: ReorderControls;
  activeSortMode: ActiveSortMode;
}) {
  const { sidebarSettings, lifecycle, childrenByParentId } = useInboxEnvironment();
  const { activeThreadId } = useInboxActivity();
  const { setRenamingShelfLocks } = useInboxActions();
  const settings = sidebarSettings ?? DEFAULT_SIDEBAR_SETTINGS;
  const onRenamingChange = useCallback(
    (editing: boolean) => {
      setRenamingShelfLocks((current) => {
        const next = new Map(current);
        if (editing) next.set(thread.id, renameShelf);
        else next.delete(thread.id);
        return next;
      });
    },
    [thread.id, renameShelf, setRenamingShelfLocks],
  );
  return (
    <ThreadCard
      thread={thread}
      showProject={showProject}
      projectIconOnly={renameShelf !== "inactive" && settings.compactProjectIconOnly}
      showEnvironment={showEnvironment}
      isActive={thread.id === activeThreadId}
      isWoke={isWoke}
      canPark={lifecycle.canPark(thread)}
      onRenamingChange={onRenamingChange}
      childThreads={childrenByParentId.get(thread.id) ?? NO_CHILDREN}
      childrenExpanded={childrenExpanded}
      reorder={
        !reorderable ||
        (shelf === "pinned" && thread.pinSortKey == null) ||
        (shelf === "inbox" && sortsActiveByTime(activeSortMode))
          ? undefined
          : threadReorderControls(thread, shelf)
      }
      compactWhenWorking={compact || settings.threadDisplay === "compact-working"}
      compactAlways={
        settings.threadDisplay === "compact-all" &&
        !(shelf === "pinned" && settings.keepPinnedThreadsFull) &&
        !(isWoke && settings.keepWokeThreadsFull)
      }
    />
  );
});

export function createInboxThreadRenderer({
  wokeThreadIds,
  expandedChildParentIds,
  threadReorderControls,
  activeSortMode,
}: {
  wokeThreadIds: ReadonlySet<string>;
  expandedChildParentIds: ReadonlySet<string>;
  threadReorderControls: ReorderControls;
  activeSortMode: ActiveSortMode;
}) {
  return (
    thread: PluginSidebarThread,
    shelf: ActiveShelfKind,
    reorderable = true,
    showProject = true,
    compact = false,
    renameShelf: "active" | "working" | "inactive" = "active",
    showEnvironment = true,
  ) => (
    <InboxThread
      key={thread.id}
      thread={thread}
      shelf={shelf}
      reorderable={reorderable}
      showProject={showProject}
      compact={compact}
      renameShelf={renameShelf}
      showEnvironment={showEnvironment}
      isWoke={wokeThreadIds.has(thread.id)}
      childrenExpanded={expandedChildParentIds.has(thread.id)}
      threadReorderControls={threadReorderControls}
      activeSortMode={activeSortMode}
    />
  );
}
