import { useEffect, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";

type Sdk = ReturnType<typeof useSdk>;
type ThreadRecord = Awaited<ReturnType<Sdk["threads"]["get"]>>;
type ListedThread = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

/** Header navigation also needs threads outside the sidebar's loaded pages. */
export function headerThread(record: ThreadRecord | ListedThread): PluginSidebarThread {
  const listed = "activity" in record ? record : null;
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    titleFallback: record.titleFallback,
    displayTitle: record.title ?? record.titleFallback ?? "Untitled thread",
    parentThreadId: record.parentThreadId,
    lifecycleOwnerThreadId: record.lifecycleOwnerThreadId,
    sourceThreadId: record.sourceThreadId,
    sectionId: record.sectionId,
    originKind: record.originKind,
    originPluginId: record.originPluginId,
    providerId: record.providerId,
    status: record.status,
    runtimeStatus: record.runtime.displayStatus,
    queuedWork: listed?.queuedWork ?? "none",
    hasPendingInteraction: listed?.hasPendingInteraction ?? false,
    activity: {
      workflows: listed?.activity.activeWorkflowCount ?? 0,
      backgroundAgents: listed?.activity.activeBackgroundAgentCount ?? 0,
      backgroundCommands: listed?.activity.activeBackgroundCommandCount ?? 0,
      planMode: listed?.activity.activePlanModeCount ?? 0,
      goals: listed?.activity.activeGoalCount ?? 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: record.lastReadAt === null || record.latestAttentionAt > record.lastReadAt,
    isPinned: record.pinnedAt !== null,
    pinnedAt: record.pinnedAt,
    pinSortKey: listed?.pinSortKey ?? null,
    isArchived: record.archivedAt !== null,
    archivedAt: record.archivedAt,
    href: `/projects/${encodeURIComponent(record.projectId)}/threads/${encodeURIComponent(record.id)}`,
    isHidden: record.visibility === "hidden",
    environment: listed?.environmentId ? {
      id: listed.environmentId,
      name: listed.environmentName,
      branchName: listed.environmentBranchName,
      path: listed.environmentPath,
      isWorktree: listed.environmentIsWorktree,
      providerId: listed.environmentProviderId,
      workspaceDisplayKind: listed.environmentWorkspaceDisplayKind,
    } : null,
    host: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastReadAt: record.lastReadAt,
    latestAttentionAt: record.latestAttentionAt,
  };
}

export function useHeaderThread(threadId: string | null, threads: readonly PluginSidebarThread[]) {
  const sdk = useSdk();
  const cached = threads.find((thread) => thread.id === threadId);
  const [loaded, setLoaded] = useState<PluginSidebarThread | null>(null);
  useEffect(() => {
    if (!threadId || cached) return;
    const controller = new AbortController();
    void sdk.threads.get({ threadId, signal: controller.signal }).then((thread) => {
      if (!controller.signal.aborted && thread.deletedAt === null) setLoaded(headerThread(thread));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [sdk, threadId, cached]);
  return cached ?? (loaded?.id === threadId ? loaded : null);
}

const PAGE_SIZE = 100;

/** Read only this family, including descendants on older archive pages. */
export async function loadArchivedThreadFamily(
  sdk: Sdk,
  threadId: string,
  activeThreads: readonly PluginSidebarThread[],
  signal: AbortSignal,
): Promise<PluginSidebarThread[]> {
  const result = new Map<string, PluginSidebarThread>();
  const visited = new Set<string>();
  const pending = [threadId];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const batch = pending.splice(0, 4).filter((id) => !visited.has(id));
    batch.forEach((id) => visited.add(id));
    const groups = await Promise.all(batch.map(async (parentThreadId) => {
      const children = activeThreads.filter((thread) => !thread.isArchived && thread.parentThreadId === parentThreadId);
      for (let offset = 0; ; offset += PAGE_SIZE) {
        signal.throwIfAborted();
        const page = await sdk.threads.list({ parentThreadId, archived: true, includeHidden: true, limit: PAGE_SIZE, offset, signal });
        children.push(...page.filter((thread) => thread.deletedAt === null && thread.archivedAt !== null && thread.parentThreadId === parentThreadId).map(headerThread));
        if (page.length < PAGE_SIZE) break;
      }
      return children;
    }));
    for (const children of groups) {
      for (const child of children) {
        if (child.id === threadId) continue;
        result.set(child.id, child);
        if (!visited.has(child.id)) pending.push(child.id);
      }
    }
  }
  return [...result.values()];
}

export function useArchivedThreadFamily(
  threadId: string | null,
  activeThreads: readonly PluginSidebarThread[],
  open: boolean,
) {
  const sdk = useSdk();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ threadId: string; threads: PluginSidebarThread[]; status: "loading" | "ready" | "error" } | null>(null);
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    setState((current) => ({ threadId, threads: current?.threadId === threadId ? current.threads : [], status: "loading" }));
    void loadArchivedThreadFamily(sdk, threadId, activeThreads, controller.signal).then(
      (threads) => {
        if (!controller.signal.aborted) setState({ threadId, threads, status: "ready" });
      },
      () => {
        if (!controller.signal.aborted) setState((current) => ({ threadId, threads: current?.threadId === threadId ? current.threads : [], status: "error" }));
      },
    );
    return () => controller.abort();
  }, [sdk, threadId, activeThreads, open, revision]);
  return {
    threads: state?.threadId === threadId ? state.threads : [],
    status: threadId === null ? "ready" : state?.threadId === threadId ? state.status : "loading",
    retry: () => setRevision((current) => current + 1),
  };
}
