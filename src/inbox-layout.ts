import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { ChildStatusKind } from "./child-status";
import type { OrderUnit } from "./pinned-order";
import { visibleInboxThreads } from "./inbox";

export const ACTIVE_SORT_MODES = ["manual", "activity", "created", "project"] as const;
export type ActiveSortMode = (typeof ACTIVE_SORT_MODES)[number];

export type ReorderMode = "thread" | "unit";
export interface ReorderScope {
  mode: ReorderMode;
  ids: string[];
  parentKey?: string | null;
}

export function isActiveSortMode(value: string): value is ActiveSortMode {
  return ACTIVE_SORT_MODES.some((mode) => mode === value);
}

// Unless every project is grouped, a project needs this many Active threads
// before it earns a header; below it, its thread stays an ordinary card in the
// project's slot.
const MIN_PROJECT_GROUP_SIZE = 2;

/** How many threads a collapsed group hides with one kind of news. */
export interface GroupAlert {
  kind: Exclude<ChildStatusKind, "working">;
  count: number;
}

export type ProjectViewUnit =
  | Extract<ProjectUnit, { kind: "thread" }>
  | (Omit<Extract<ProjectUnit, { kind: "group" }>, "children"> & {
      expanded: boolean;
      threadCount: number;
      alerts: GroupAlert[];
      children?: ProjectViewUnit[];
    });

export type ProjectUnit =
  | { kind: "thread"; key: string; thread: PluginSidebarThread }
  | {
      kind: "group";
      key: string;
      projectId: string;
      threads: PluginSidebarThread[];
      children?: ProjectUnit[];
      environment?: NonNullable<PluginSidebarThread["environment"]>;
    };

// Thread ids never take this form, so a project key cannot collide with one.
const PROJECT_UNIT_KEY_PREFIX = "project:";

export function projectUnitKey(projectId: string): string {
  return `${PROJECT_UNIT_KEY_PREFIX}${projectId}`;
}

/**
 * The project view. Each project holds one slot, taken from the saved project
 * order, so a project stays put while its threads leave Active and come back.
 * Projects the order has not seen yet come first, in the order their first
 * threads appear. Threads keep the inbox order within their project. A project
 * with enough threads is drawn as a group; a smaller one is its lone thread,
 * unless `groupSingleThreads` draws every project as a group.
 */
export function layoutActiveThreadsByProject(
  inbox: readonly PluginSidebarThread[],
  projectOrder: readonly string[] = [],
  groupSingleThreads = false,
): ProjectUnit[] {
  const minGroupSize = groupSingleThreads ? 1 : MIN_PROJECT_GROUP_SIZE;
  const threadsByProject = new Map<string, PluginSidebarThread[]>();
  for (const thread of inbox) {
    const threads = threadsByProject.get(thread.projectId);
    if (threads) threads.push(thread);
    else threadsByProject.set(thread.projectId, [thread]);
  }
  return mergeProjectOrder(projectOrder, [...threadsByProject.keys()]).flatMap((projectId): ProjectUnit[] => {
    const threads = threadsByProject.get(projectId);
    if (!threads) return [];
    if (threads.length < minGroupSize) return [{ kind: "thread", key: threads[0]!.id, thread: threads[0]! }];
    return [{ kind: "group", key: projectUnitKey(projectId), projectId, threads }];
  });
}

/** The saved project order with projects it has not seen yet put first. */
export function mergeProjectOrder(saved: readonly string[], projectIds: readonly string[]): string[] {
  const known = new Set(saved);
  const unseen = projectIds.filter((projectId) => !known.has(projectId));
  return unseen.length ? [...new Set(unseen), ...saved] : [...saved];
}

/** The project a top-level unit of the project view stands for. */
export function unitProjectId(unit: ProjectUnit): string {
  return unit.kind === "thread" ? unit.thread.projectId : unit.projectId;
}

export function projectOrderUnits(units: readonly ProjectUnit[]): OrderUnit[] {
  return units.map((unit) => ({
    key: unit.key,
    ids: unit.kind === "thread" ? [unit.thread.id] : unit.threads.map((thread) => thread.id),
  }));
}

/** Expand a preview of unit keys into the thread order it stands for. */
export function expandProjectUnits(keys: readonly string[], units: readonly ProjectUnit[]): string[] {
  const idsByKey = new Map(projectOrderUnits(units).map((unit) => [unit.key, unit.ids]));
  return keys.flatMap((key) => idsByKey.get(key) ?? []);
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function sortActiveThreads(
  threads: readonly PluginSidebarThread[],
  mode: ActiveSortMode,
): PluginSidebarThread[] {
  if (mode !== "activity" && mode !== "created") return [...threads];
  const primaryKey = mode === "activity" ? "updatedAt" : "createdAt";
  return [...threads].sort(
    (left, right) =>
      right[primaryKey] - left[primaryKey] || right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
  );
}

export function visibleShelfThreads(
  threads: readonly PluginSidebarThread[],
  expanded: boolean,
  activeThreadId: string | null,
  limit = threads.length,
  attentionParentIds?: ReadonlySet<string>,
): PluginSidebarThread[] {
  if (!expanded) {
    return threads.filter((thread) => thread.id === activeThreadId || attentionParentIds?.has(thread.id));
  }
  return threads.filter((thread, index) => index < limit || thread.id === activeThreadId);
}

/** Closest ancestor represented by an actual flat shelf row in this scope. */
export function activeRepresentativeThreadId(
  threads: readonly PluginSidebarThread[],
  threadId: string | null,
  flatRows: readonly PluginSidebarThread[],
): string | null {
  const visibleById = new Map(visibleInboxThreads(threads).map((thread) => [thread.id, thread] as const));
  const flatIds = new Set(flatRows.map((thread) => thread.id));
  const visited = new Set<string>();
  let current = threadId === null ? undefined : visibleById.get(threadId);
  while (current && !visited.has(current.id)) {
    if (flatIds.has(current.id)) return current.id;
    visited.add(current.id);
    current = current.parentThreadId ? visibleById.get(current.parentThreadId) : undefined;
  }
  return null;
}
