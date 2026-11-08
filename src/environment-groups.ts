import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { layoutActiveThreadsByProject, projectOrderUnits, visibleShelfThreads } from "./inbox-layout";
import type { ProjectUnit, ProjectViewUnit } from "./inbox-layout";
import type { OrderUnit } from "./pinned-order";

export function environmentUnitKey(projectId: string, environmentId: string): string {
  return `environment:${JSON.stringify([projectId, environmentId])}`;
}

export function environmentLabel(environment: NonNullable<PluginSidebarThread["environment"]>): string {
  return (
    environment.branchName ||
    environment.name ||
    environment.path?.split(/[\\/]/).filter(Boolean).at(-1) ||
    "Environment"
  );
}

function environmentUnits(threads: PluginSidebarThread[]): ProjectUnit[] {
  const buckets = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    if (!thread.environment?.isWorktree || !thread.environment.id) continue;
    const bucket = buckets.get(thread.environment.id) ?? [];
    bucket.push(thread);
    buckets.set(thread.environment.id, bucket);
  }
  const emitted = new Set<string>();
  return threads.flatMap((thread): ProjectUnit[] => {
    const environment = thread.environment;
    const bucket = environment?.id && environment.isWorktree ? buckets.get(environment.id) : undefined;
    if (!environment?.id || !bucket || bucket.length < 2) {
      return [{ kind: "thread", key: thread.id, thread }];
    }
    if (emitted.has(environment.id)) return [];
    emitted.add(environment.id);
    return [
      {
        kind: "group",
        key: environmentUnitKey(thread.projectId, environment.id),
        projectId: thread.projectId,
        environment,
        threads: bucket,
      },
    ];
  });
}

export function layoutActiveGroups(
  threads: readonly PluginSidebarThread[],
  groupEnvironments: boolean,
  projectOrder: readonly string[] = [],
  groupSingleThreads = false,
): ProjectUnit[] {
  return layoutActiveThreadsByProject(threads, projectOrder, groupSingleThreads).map((unit) => {
    if (unit.kind === "thread" || !groupEnvironments) return unit;
    const children = environmentUnits(unit.threads);
    return {
      ...unit,
      children,
      threads: children.flatMap((child) => (child.kind === "thread" ? [child.thread] : child.threads)),
    };
  });
}

function groupChildren(unit: Extract<ProjectUnit, { kind: "group" }>): ProjectUnit[] {
  return unit.children ?? unit.threads.map((thread) => ({ kind: "thread", key: thread.id, thread }));
}

export function allOrderUnits(units: readonly ProjectUnit[]): OrderUnit[] {
  return [
    ...projectOrderUnits(units),
    ...units.flatMap((unit) => (unit.kind === "group" ? allOrderUnits(groupChildren(unit)) : [])),
  ];
}

export function siblingScope(
  units: readonly ProjectUnit[],
  key: string,
  parentKey: string | null = null,
): { units: readonly ProjectUnit[]; parentKey: string | null } {
  if (units.some((unit) => unit.key === key)) return { units, parentKey };
  for (const unit of units) {
    if (unit.kind !== "group") continue;
    const siblings = siblingScope(groupChildren(unit), key, unit.key);
    if (siblings.units.length) return siblings;
  }
  return { units: [], parentKey };
}

export function unitsAtScope(units: readonly ProjectUnit[], parentKey: string | null): readonly ProjectUnit[] {
  if (parentKey === null) return units;
  const parent = siblingScope(units, parentKey).units.find((unit) => unit.key === parentKey);
  return parent?.kind === "group" ? groupChildren(parent) : [];
}

export function projectGroupView(
  units: readonly ProjectUnit[],
  collapsedProjects: ReadonlySet<string>,
  collapsedEnvironments: ReadonlySet<string>,
  activeThreadId: string | null,
  attentionIds: ReadonlySet<string>,
): ProjectViewUnit[] {
  return units.map((unit) => {
    if (unit.kind === "thread") return unit;
    const expanded = !(unit.environment ? collapsedEnvironments.has(unit.key) : collapsedProjects.has(unit.projectId));
    const threads = visibleShelfThreads(unit.threads, expanded, activeThreadId, undefined, attentionIds);
    return {
      ...unit,
      expanded,
      threadCount: unit.threads.length,
      threads,
      children:
        expanded && unit.children
          ? projectGroupView(unit.children, collapsedProjects, collapsedEnvironments, activeThreadId, attentionIds)
          : undefined,
    };
  });
}
