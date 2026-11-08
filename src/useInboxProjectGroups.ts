import { useCallback, useEffect, useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { InboxDragOrder } from "./drag-reorder-geometry";
import { allOrderUnits, layoutActiveGroups, projectGroupView, siblingScope, unitsAtScope } from "./environment-groups";
import { mergeProjectOrder, projectOrderUnits, unitProjectId, visibleShelfThreads } from "./inbox-layout";
import type { ProjectUnit, ProjectViewUnit, ReorderScope } from "./inbox-layout";
import { orderSubsetInPlace, rebaseMovedId, rebaseMovedUnit } from "./pinned-order";
import {
  environmentGroupingCodec,
  projectCollapseCodec,
  projectOrderCodec,
  singleThreadProjectGroupingCodec,
} from "./lib/inbox-preference-codecs";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";

function projectIdsByKey(units: readonly ProjectUnit[]): Map<string, string> {
  return new Map(units.map((unit) => [unit.key, unitProjectId(unit)]));
}

/** A drag among the project view's top-level units moves projects, not threads. */
function isProjectDrag(dragOrder: InboxDragOrder | null, projectMode: boolean): boolean {
  return (
    projectMode && dragOrder?.shelf === "inbox" && dragOrder.mode === "unit" && (dragOrder.parentKey ?? null) === null
  );
}

function toggleId(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function useInboxProjectGroups({
  orderedInbox,
  dragOrder,
  expanded,
  activeThreadId,
  attentionIds,
  projectNameById,
  projectMode,
  orderReady,
}: {
  orderedInbox: PluginSidebarThread[];
  dragOrder: InboxDragOrder | null;
  expanded: boolean;
  activeThreadId: string | null;
  attentionIds: ReadonlySet<string>;
  projectNameById: ReadonlyMap<string, string>;
  projectMode: boolean;
  // Threads and their saved order are both known, so new projects can be told apart.
  orderReady: boolean;
}) {
  const [groupEnvironments, setGroupEnvironments] = usePersistedPreference(
    STORAGE_KEYS.environmentGrouping.key,
    environmentGroupingCodec,
  );
  const [groupSingleThreadProjects, setGroupSingleThreadProjects] = usePersistedPreference(
    STORAGE_KEYS.singleThreadProjectGrouping.key,
    singleThreadProjectGroupingCodec,
  );
  const collapseCodec = useMemo(
    () => ({
      ...projectCollapseCodec,
      prune: (ids: Set<string>) =>
        new Set([...ids].filter((id) => projectNameById.size === 0 || projectNameById.has(id))),
    }),
    [projectNameById],
  );
  const [collapsedProjects, setCollapsedProjects] = usePersistedPreference(
    STORAGE_KEYS.projectCollapse.key,
    collapseCodec,
  );
  const [collapsedEnvironments, setCollapsedEnvironments] = usePersistedPreference(
    STORAGE_KEYS.environmentCollapse.key,
    projectCollapseCodec,
  );
  const projectOrderPruneCodec = useMemo(
    () => ({
      ...projectOrderCodec,
      prune: (ids: string[]) => ids.filter((id) => projectNameById.size === 0 || projectNameById.has(id)),
    }),
    [projectNameById],
  );
  const [projectOrder, setProjectOrder] = usePersistedPreference(STORAGE_KEYS.projectOrder.key, projectOrderPruneCodec);
  // A project gets its slot the first time the project view shows it, so the
  // layout it first appears in is the one it keeps while its threads come and go.
  useEffect(() => {
    if (!projectMode || !orderReady) return;
    const projectIds = orderedInbox.map((thread) => thread.projectId);
    setProjectOrder((saved) => {
      const merged = mergeProjectOrder(saved, projectIds);
      return merged.length === saved.length ? saved : merged;
    });
  }, [projectMode, orderReady, orderedInbox, setProjectOrder]);
  const toggleProjectCollapse = useCallback((id: string) => setCollapsedProjects((ids) => toggleId(ids, id)), []);
  const toggleEnvironmentCollapse = useCallback(
    (id: string) => setCollapsedEnvironments((ids) => toggleId(ids, id)),
    [],
  );
  const storedUnits = useMemo(
    () => layoutActiveGroups(orderedInbox, groupEnvironments, projectOrder, groupSingleThreadProjects),
    [orderedInbox, groupEnvironments, projectOrder, groupSingleThreadProjects],
  );
  // Rows move across environments when their environment headers are hidden.
  // Keep the full thread lists so rebasing preserves hidden siblings' slots.
  const reorderUnits = useMemo(
    () =>
      groupEnvironments && !expanded
        ? layoutActiveGroups(orderedInbox, false, projectOrder, groupSingleThreadProjects)
        : storedUnits.map((unit) =>
            unit.kind === "group" && collapsedProjects.has(unit.projectId) ? { ...unit, children: undefined } : unit,
          ),
    [
      orderedInbox,
      storedUnits,
      groupEnvironments,
      expanded,
      collapsedProjects,
      projectOrder,
      groupSingleThreadProjects,
    ],
  );
  const orderUnits = useMemo(() => allOrderUnits(storedUnits), [storedUnits]);
  const previewProjectOrder = useMemo(() => {
    if (!dragOrder || !isProjectDrag(dragOrder, projectMode)) return projectOrder;
    const projectIdByKey = projectIdsByKey(reorderUnits);
    if (!projectIdByKey.has(dragOrder.movingId)) return projectOrder;
    const moved = dragOrder.ids.flatMap((key) => projectIdByKey.get(key) ?? []);
    return orderSubsetInPlace(
      mergeProjectOrder(projectOrder, moved).map((id) => ({ id })),
      moved,
    ).map(({ id }) => id);
  }, [dragOrder, projectMode, projectOrder, reorderUnits]);
  const inbox = useMemo(() => {
    if (dragOrder?.shelf !== "inbox" || isProjectDrag(dragOrder, projectMode)) return orderedInbox;
    const scope = unitsAtScope(reorderUnits, dragOrder.parentKey ?? null);
    if (dragOrder.mode === "unit" && !scope.some((unit) => unit.key === dragOrder.movingId)) return orderedInbox;
    const idsByKey = new Map(projectOrderUnits(scope).map((unit) => [unit.key, unit.ids]));
    return orderSubsetInPlace(
      orderedInbox,
      dragOrder.mode === "unit" ? dragOrder.ids.flatMap((key) => idsByKey.get(key) ?? []) : dragOrder.ids,
    );
  }, [orderedInbox, reorderUnits, dragOrder, projectMode]);
  const units = useMemo(
    () => layoutActiveGroups(inbox, groupEnvironments, previewProjectOrder, groupSingleThreadProjects),
    [inbox, groupEnvironments, previewProjectOrder, groupSingleThreadProjects],
  );
  const visibleInbox = useMemo(
    () => visibleShelfThreads(inbox, expanded, activeThreadId, undefined, attentionIds),
    [inbox, expanded, activeThreadId, attentionIds],
  );
  const view = useMemo((): ProjectViewUnit[] => {
    if (expanded) {
      return projectGroupView(units, collapsedProjects, collapsedEnvironments, activeThreadId, attentionIds);
    }
    // A folded shelf keeps its few rows in their projects' slots.
    const visibleIds = new Set(visibleInbox.map((thread) => thread.id));
    return units
      .flatMap((unit) => (unit.kind === "thread" ? [unit.thread] : unit.threads))
      .filter((thread) => visibleIds.has(thread.id))
      .map((thread) => ({ kind: "thread", key: thread.id, thread }));
  }, [expanded, units, collapsedProjects, collapsedEnvironments, activeThreadId, attentionIds, visibleInbox]);
  const reorderScope = (key: string): ReorderScope => {
    const visibleKeys = new Set(allOrderUnits(view).map((unit) => unit.key));
    const { units: scopeUnits, parentKey } = siblingScope(reorderUnits, key);
    const siblings = scopeUnits.filter(
      (unit) =>
        visibleKeys.has(unit.key) ||
        (unit.kind === "group" && unit.threads.some((thread) => visibleKeys.has(thread.id))),
    );
    return {
      mode: parentKey === null || siblings.some((unit) => unit.kind === "group") ? "unit" : "thread",
      ids: siblings.map((unit) => unit.key),
      parentKey,
    };
  };
  /** Save a top-level move of the project view as a new project order. */
  const moveProject = (previewKeys: readonly string[], movingKey: string) => {
    const projectIdByKey = projectIdsByKey(reorderUnits);
    const movingProjectId = projectIdByKey.get(movingKey);
    if (movingProjectId === undefined) return;
    const preview = previewKeys.flatMap((key) => projectIdByKey.get(key) ?? []);
    setProjectOrder((saved) => rebaseMovedId(mergeProjectOrder(saved, preview), preview, movingProjectId));
  };
  /**
   * The thread order a move leaves behind, or null when there is none to
   * write. Top-level units of the project view are projects, so moving one
   * saves the project order and leaves the thread order alone.
   */
  const rebaseOrder = (
    liveIds: readonly string[],
    previewIds: readonly string[],
    movingId: string,
    parentKey: string | null,
  ) => {
    if (projectMode && parentKey === null) {
      moveProject(previewIds, movingId);
      return null;
    }
    const participating = new Set(previewIds);
    const liveUnits = projectOrderUnits(unitsAtScope(reorderUnits, parentKey)).filter((unit) =>
      participating.has(unit.key),
    );
    if (!liveUnits.some((unit) => unit.key === movingId)) return null;
    return rebaseMovedUnit(liveIds, liveUnits, previewIds, movingId);
  };
  return {
    inbox,
    visibleInbox,
    units,
    view,
    orderUnits,
    reorderScope,
    rebaseOrder,
    groupEnvironments,
    setGroupEnvironments,
    groupSingleThreadProjects,
    setGroupSingleThreadProjects,
    toggleProjectCollapse,
    toggleEnvironmentCollapse,
  };
}
