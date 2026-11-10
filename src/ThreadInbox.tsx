import { useSidebarThreads, useProviders } from "./bb-sdk";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, type PluginSidebarThread, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { useInboxShelfThreads } from "./useInboxShelfThreads";
import { createDragReorderHandler } from "./drag-reorder";
import type { InboxDragOrder } from "./drag-reorder-geometry";
import { ThreadInboxView } from "./ThreadInboxView";
import { useQuantizedNow } from "./useQuantizedNow";
import { useProjectIconRevision } from "./useProjectIconRevision";
import { useRenamingShelfLocks } from "./useRenamingShelfLocks";
import { useDragClickSuppression } from "./useDragClickSuppression";
import { useListMotion, createListAnimationController } from "./useListMotion";
import {
  sameOrder,
  sortActiveThreads,
  visibleShelfThreads,
  type ReorderMode,
  type ReorderScope,
  projectUnitKey,
} from "./inbox-layout";
import type { ThreadReorderControls } from "./ThreadCard";
import { InboxProvider, useInboxContextValues } from "./InboxContext";
import { RateLimitsProvider } from "./RateLimits";
import { createInboxThreadRenderer } from "./InboxThreadRenderer";
import { childThreadsByParent, collapsedChildThreads } from "./ChildThreadList";
import { useChildThreadDisplayValue } from "./ChildThreadDisplay";
import { useLifecycle } from "./useLifecycle";
import type { createDragPreview } from "./drag-preview";
import { usePinnedReorder } from "./usePinnedReorder";
import { useCollapseChildrenOnSettle } from "./useCollapseChildrenOnSettle";
import { useInboxReorder } from "./useInboxReorder";
import { useInboxProjectGroups } from "./useInboxProjectGroups";
import { environmentUnitKey } from "./environment-groups";
import { useWorkingSince } from "./useWorkingSince";
import { useSidebarSettings } from "./useSidebarSettings";
import { useProjectScope } from "./useProjectScope";
import { threadDisplayTitle } from "./inbox";
import { movePinnedIdByOffset, orderPinnedThreads, rebaseMovedId } from "./pinned-order";
import { parseConfiguredSnoozePresets } from "./lifecycle";
import { parseInactiveAfterHours } from "./inactive";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { useScrollFade } from "./useScrollFade";
import { usePersistedPreference } from "./lib/use-persisted-preference";
import { activeSortCodec, childExpansionCodec, shelfExpansionCodec } from "./lib/inbox-preference-codecs";
const SETTLED_INITIAL_LIMIT = 10;

type ActiveShelfKind = "pinned" | "inbox";

/**
 * The sidebar's scrolling list. Manual order is durable; optional views sort
 * the same rows without changing their saved positions.
 *
 * The host owns New thread, and thread search lives in bb's quick palette, so
 * this list ignores the deprecated `searchQuery` prop. It adds the plugin's
 * project scope picker.
 */
export function ThreadInbox(props: PluginThreadListProps) {
  const snapshot = useSidebarThreads();
  return (
    <RateLimitsProvider threads={snapshot.threads}>
      <ThreadInboxContent {...props} snapshot={snapshot} />
    </RateLimitsProvider>
  );
}

function ThreadInboxContent({
  activeThreadId,
  onNavigate,
  isCompactViewport,
  snapshot,
}: PluginThreadListProps & {
  snapshot: ReturnType<typeof useSidebarThreads>;
}) {
  const { status, threads, projects } = snapshot;
  const workingSince = useWorkingSince(threads, status);
  const { providers } = useProviders();
  const navigate = useBbNavigate();
  const sidebarSettings = useSidebarSettings();
  const lifecycle = useLifecycle(threads);
  const projectIconRevision = useProjectIconRevision();
  const listAnimationController = useMemo(() => createListAnimationController(!isCompactViewport), [isCompactViewport]);
  const attachShelvesMotionRef = useListMotion<HTMLDivElement>(listAnimationController);
  const attachDockMotionRef = useListMotion<HTMLDivElement>(listAnimationController);
  const attachScrollFadeRef = useScrollFade<HTMLDivElement>();
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const configuredSnoozePresets = sidebarSettings?.snoozePresets ?? DEFAULT_SIDEBAR_SETTINGS.snoozePresets;
  const snoozePresets = useMemo(() => parseConfiguredSnoozePresets(configuredSnoozePresets), [configuredSnoozePresets]);
  const inactiveAfterHours = parseInactiveAfterHours(
    // Keep the loading view active until saved or cached settings are available.
    sidebarSettings?.inactiveThreadsEnabled ?? false,
    String(sidebarSettings?.inactiveAfterHours ?? DEFAULT_SIDEBAR_SETTINGS.inactiveAfterHours),
  );
  const dockShelvesEnabled = sidebarSettings?.dockShelves ?? DEFAULT_SIDEBAR_SETTINGS.dockShelves;
  const workingShelfEnabled = sidebarSettings?.workingShelf ?? DEFAULT_SIDEBAR_SETTINGS.workingShelf;
  const [scope, setScope] = useProjectScope({ projects, status });
  const now = useQuantizedNow();
  const projectNameById = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const [expandedChildParentIds, setExpandedChildParentIds] = usePersistedPreference(
    STORAGE_KEYS.childExpansion.key,
    childExpansionCodec,
  );
  const [expandedShelves, setExpandedShelves] = usePersistedPreference(
    STORAGE_KEYS.shelfExpansion.key,
    shelfExpansionCodec,
  );
  const [activeSortMode, setActiveSortMode] = usePersistedPreference(STORAGE_KEYS.activeSort.key, activeSortCodec);
  const [settledLimit, setSettledLimit] = useState(SETTLED_INITIAL_LIMIT);
  const [renamingShelfLocks, setRenamingShelfLocks] = useRenamingShelfLocks(threads, lifecycle);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const childDisplay = useChildThreadDisplayValue(sidebarSettings, providerById);
  const childrenByParentId = useMemo(
    () => childThreadsByParent(threads, childDisplay.sort),
    [threads, childDisplay.sort],
  );
  useEffect(() => {
    setExpandedChildParentIds((current) => {
      const next = new Set([...current].filter((threadId) => childrenByParentId.has(threadId)));
      return next.size === current.size ? current : next;
    });
  }, [childrenByParentId]);
  const toggleChildExpansion = useCallback((parentThreadId: string) => {
    setExpandedChildParentIds((current) => {
      const next = new Set(current);
      if (next.has(parentThreadId)) next.delete(parentThreadId);
      else next.add(parentThreadId);
      return next;
    });
  }, []);

  const {
    activeListThreadId,
    pinnedBase,
    inboxBase,
    workingBase,
    inactiveBase,
    allPinnedBase,
    allInboxBase,
    parked,
    snoozed,
    settled,
  } = useInboxShelfThreads({
    activeThreadId,
    childrenByParentId,
    inactiveAfterHours,
    lifecycle,
    now,
    renamingShelfLocks,
    scope,
    threads,
    workingShelfEnabled,
  });
  useCollapseChildrenOnSettle(settled, lifecycle, setExpandedChildParentIds);

  const pinnedReorder = usePinnedReorder(allPinnedBase);
  const inboxReorder = useInboxReorder(allInboxBase);
  // A "unit" drag moves whole project-view units, so its ids are unit keys
  // rather than thread ids.
  const [dragOrder, setDragOrder] = useState<InboxDragOrder | null>(null);
  const dragOrderRef = useRef(dragOrder);
  dragOrderRef.current = dragOrder;
  const dragPreviewRef = useRef<ReturnType<typeof createDragPreview> | null>(null);
  useLayoutEffect(() => {
    dragPreviewRef.current?.play();
  });
  const activeReorderCancelRef = useRef<(() => void) | null>(null);
  const suppressDragClick = useDragClickSuppression(activeReorderCancelRef);
  // A thread can be deleted from anywhere while it is being dragged. Unmounting
  // the whole sidebar already cancels; losing just this row has to as well, or
  // the drag keeps steering an order around an id that is gone. This catches
  // the thread leaving the host's list, not every way a row can stop being a
  // valid drag source — archiving or parking it still leaves the gesture
  // running until the drop rebases it.
  useEffect(() => {
    if (!dragOrder) return;
    const survives = threads.some(
      (thread) =>
        thread.id === dragOrder.movingId ||
        projectUnitKey(thread.projectId) === dragOrder.movingId ||
        (thread.environment?.id && environmentUnitKey(thread.projectId, thread.environment.id) === dragOrder.movingId),
    );
    if (!survives) activeReorderCancelRef.current?.();
  }, [dragOrder, threads]);
  const pinned = useMemo(() => {
    const ordered = orderPinnedThreads(pinnedBase, pinnedReorder.ids);
    return orderPinnedThreads(ordered, dragOrder?.shelf === "pinned" ? dragOrder.ids : null);
  }, [dragOrder, pinnedBase, pinnedReorder.ids]);
  const orderedInbox = useMemo(() => orderPinnedThreads(inboxBase, inboxReorder.ids), [inboxBase, inboxReorder.ids]);
  // Working and Inactive keep Active's manual order, so a thread that leaves
  // for either comes back to the slot it left.
  const working = useMemo(() => orderPinnedThreads(workingBase, inboxReorder.ids), [workingBase, inboxReorder.ids]);
  const inactive = useMemo(() => orderPinnedThreads(inactiveBase, inboxReorder.ids), [inactiveBase, inboxReorder.ids]);
  // Keep the root of an attention path reachable when its shelf is folded.
  const attentionParentIds = useMemo(() => {
    const ids = new Set<string>();
    if (
      !(sidebarSettings?.showRunningChildrenWhenCollapsed ?? DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed)
    ) {
      return ids;
    }
    for (const thread of [...pinnedBase, ...inboxBase, ...inactiveBase]) {
      if (collapsedChildThreads(childrenByParentId.get(thread.id) ?? [], childrenByParentId, null, true).length > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [childrenByParentId, inactiveBase, inboxBase, pinnedBase, sidebarSettings?.showRunningChildrenWhenCollapsed]);
  const visiblePinned = useMemo(
    () => visibleShelfThreads(pinned, expandedShelves.pinned, activeListThreadId, undefined, attentionParentIds),
    [attentionParentIds, activeListThreadId, expandedShelves.pinned, pinned],
  );
  const projectGroups = useInboxProjectGroups({
    orderedInbox,
    dragOrder,
    expanded: expandedShelves.active,
    activeThreadId: activeListThreadId,
    attentionIds: attentionParentIds,
    projectNameById,
    projectMode: activeSortMode === "project",
    orderReady: status === "ready" && inboxReorder.loaded,
  });
  const {
    inbox,
    visibleInbox,
    units: inboxProjectUnits,
    view: inboxProjectView,
    toggleProjectCollapse,
  } = projectGroups;
  const projectGroupsRef = useRef(projectGroups);
  projectGroupsRef.current = projectGroups;
  const visibleWorking = useMemo(
    () => visibleShelfThreads(working, expandedShelves.working, activeListThreadId),
    [activeListThreadId, expandedShelves.working, working],
  );
  const visibleInactive = useMemo(
    () => visibleShelfThreads(inactive, expandedShelves.inactive, activeListThreadId, undefined, attentionParentIds),
    [attentionParentIds, activeListThreadId, expandedShelves.inactive, inactive],
  );
  const sortedVisibleInbox = useMemo(
    () => sortActiveThreads(visibleInbox, activeSortMode),
    [activeSortMode, visibleInbox],
  );
  // A drag installs its listeners once, at pointer-down, but the shelf keeps
  // moving underneath it: the host pushes order changes mid-gesture. The order
  // and the membership a drop depends on are therefore read through these refs
  // rather than captured, or the write reverts whatever landed while the
  // pointer was down. The row and shelf a gesture belongs to stay captured —
  // those are what the gesture is about.
  const reorderTargetsRef = useRef({
    pinned: pinnedReorder,
    inbox: inboxReorder,
  });
  reorderTargetsRef.current = { pinned: pinnedReorder, inbox: inboxReorder };
  const storedOrderUnitsRef = useRef(projectGroups.orderUnits);
  storedOrderUnitsRef.current = projectGroups.orderUnits;
  const activeSortModeRef = useRef(activeSortMode);
  activeSortModeRef.current = activeSortMode;
  /**
   * What a row or header reorders among. In the project view a thread inside
   * a group moves within its project; a lone thread or a group header moves
   * among the top-level units.
   */
  const reorderScope = useCallback(
    (key: string, shelf: "pinned" | "inbox"): ReorderScope => {
      if (shelf === "inbox" && activeSortMode === "project") {
        return projectGroups.reorderScope(key);
      }
      return {
        mode: "thread",
        ids: (shelf === "pinned" ? visiblePinned : visibleInbox).map((candidate) => candidate.id),
      };
    },
    [activeSortMode, projectGroups, visibleInbox, visiblePinned],
  );
  const reorderScopeRef = useRef(reorderScope);
  reorderScopeRef.current = reorderScope;
  const commitReorder = useCallback(
    (
      shelf: "pinned" | "inbox",
      mode: ReorderMode,
      previewIds: readonly string[],
      movingId: string,
      parentKey: string | null = null,
    ) => {
      if (shelf === "pinned") {
        const live = reorderTargetsRef.current.pinned;
        void live.reorder(rebaseMovedId(live.ids, previewIds, movingId), movingId);
        return;
      }
      const live = reorderTargetsRef.current.inbox;
      const ids =
        activeSortModeRef.current === "project" || mode === "unit"
          ? projectGroupsRef.current.rebaseOrder(live.ids, previewIds, movingId, parentKey)
          : rebaseMovedId(live.ids, previewIds, movingId);
      if (ids) void live.reorder(ids);
    },
    [],
  );
  // Keyboard reordering moves a row with no pointer to follow and no sound, so
  // the only feedback a screen reader gets is what this region says.
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");

  /**
   * Pointer and keyboard reordering for one row or project header. `key` is a
   * thread id, or a project unit key for a header.
   */
  const reorderControls = useCallback(
    (key: string, shelf: "pinned" | "inbox", title: string): ThreadReorderControls => {
      const target = reorderTargetsRef.current[shelf];
      return {
        disabled: target.isReordering,
        isDragging: dragOrder?.shelf === shelf && dragOrder.movingId === key,
        onPointerDown: createDragReorderHandler({
          key,
          shelf,
          target,
          activeReorderCancelRef,
          dragOrderRef,
          dragPreviewRef,
          listAnimationController,
          suppressDragClick,
          reorderScopeRef,
          storedOrderUnitsRef,
          setDragOrder,
          commitReorder,
        }),
        onKeyDown: (event) => {
          if (!event.altKey || target.isReordering || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const { mode, ids: currentIds, parentKey } = reorderScopeRef.current(key, shelf);
          const ids = movePinnedIdByOffset(currentIds, key, event.key === "ArrowUp" ? -1 : 1);
          const shelfName = shelf === "pinned" ? "Pinned" : "Active";
          setReorderAnnouncement(
            sameOrder(ids, currentIds)
              ? `${title} is already ${event.key === "ArrowUp" ? "first" : "last"} in ${shelfName}`
              : `${title} moved to ${ids.indexOf(key) + 1} of ${ids.length} in ${shelfName}`,
          );
          commitReorder(shelf, mode, ids, key, parentKey);
        },
      };
    },
    [
      pinnedReorder.isReordering,
      inboxReorder.isReordering,
      dragOrder,
      listAnimationController,
      suppressDragClick,
      commitReorder,
    ],
  );
  const threadReorderControls = useCallback(
    (thread: PluginSidebarThread, shelf: "pinned" | "inbox") =>
      reorderControls(thread.id, shelf, threadDisplayTitle(thread)),
    [reorderControls],
  );

  const visibleParked = useMemo(
    () => visibleShelfThreads(parked, expandedShelves.parked, activeListThreadId),
    [activeListThreadId, expandedShelves.parked, parked],
  );
  const visibleSnoozed = useMemo(
    () => visibleShelfThreads(snoozed, expandedShelves.snoozed, activeListThreadId),
    [activeListThreadId, expandedShelves.snoozed, snoozed],
  );
  const visibleSettled = useMemo(
    () => visibleShelfThreads(settled, expandedShelves.settled, activeListThreadId, settledLimit),
    [activeListThreadId, expandedShelves.settled, settled, settledLimit],
  );
  const wokeThreadIds = useMemo(
    () =>
      new Set(
        [...pinned, ...inbox, ...working, ...inactive]
          .filter((thread) => lifecycle.wokeFor(thread))
          .map((thread) => thread.id),
      ),
    [inactive, inbox, lifecycle, pinned, working],
  );

  const parkActiveThread = useCallback(
    async (thread: PluginSidebarThread, mutation: () => Promise<boolean>) => {
      const parked = await mutation();
      if (!parked || activeThreadIdRef.current !== thread.id) return;

      // Never land on a thread the user did not pick.
      navigate.toCompose({ projectId: thread.projectId, focusPrompt: true });
      onNavigate();
    },
    [navigate, onNavigate],
  );

  const parkThread = useCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.park(thread.id)),
    [parkActiveThread, lifecycle],
  );
  const settleThread = useCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.settle(thread.id)),
    [parkActiveThread, lifecycle],
  );
  const snoozeThread = useCallback(
    (thread: PluginSidebarThread, until: number) =>
      void parkActiveThread(thread, () => lifecycle.snooze(thread.id, until)),
    [parkActiveThread, lifecycle],
  );

  const inboxContext = useInboxContextValues({
    providerById,
    projectNameById,
    projectIconRevision,
    projects,
    sidebarSettings,
    snoozePresets,
    lifecycle,
    childrenByParentId,
    activeThreadId,
    now,
    onNavigate,
    parkThread,
    settleThread,
    snoozeThread,
    toggleChildExpansion,
    setRenamingShelfLocks,
    setScope,
    setExpandedShelves,
    setActiveSortMode,
    setSettledLimit,
    toggleProjectCollapse,
  });
  const renderActiveThread = createInboxThreadRenderer({
    wokeThreadIds,
    expandedChildParentIds,
    threadReorderControls,
    activeSortMode,
  });

  return (
    <InboxProvider
      value={inboxContext}
      listAnimationController={listAnimationController}
      workingSince={workingSince}
      childDisplay={childDisplay}
    >
      <ThreadInboxView
        shelves={{
          pinned: { threads: pinned, visibleThreads: visiblePinned },
          inbox: { threads: inbox, visibleThreads: visibleInbox },
          working: { threads: working, visibleThreads: visibleWorking },
          inactive: { threads: inactive, visibleThreads: visibleInactive },
          snoozed: { threads: snoozed, visibleThreads: visibleSnoozed },
          parked: { threads: parked, visibleThreads: visibleParked },
          settled: { threads: settled, visibleThreads: visibleSettled },
        }}
        scope={scope}
        reorderAnnouncement={reorderAnnouncement}
        attachScrollFadeRef={attachScrollFadeRef}
        status={status}
        expandedChildParentIds={expandedChildParentIds}
        dockShelvesEnabled={dockShelvesEnabled}
        attachShelvesMotionRef={attachShelvesMotionRef}
        attachDockMotionRef={attachDockMotionRef}
        expandedShelves={expandedShelves}
        renderActiveThread={renderActiveThread}
        activeSortMode={activeSortMode}
        inboxProjectView={inboxProjectView}
        environmentGrouping={projectGroups}
        reorderControls={reorderControls}
        sortedVisibleInbox={sortedVisibleInbox}
        settledLimit={settledLimit}
      />
    </InboxProvider>
  );
}
