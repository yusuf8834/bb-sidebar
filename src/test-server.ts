import { afterEach, vi } from "vitest";
import { createFakePluginHost as createHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { type StoredLifecycleRow } from "./server";
import { deferred } from "./test-fixtures";
import { GITHUB_PR_STATUS_PLUGIN_ID } from "./github-pr-status";

// Default both SDK listings to the test's thread fixture. Host-boundary tests
// override them separately to reproduce visibility, paging and stale replies.
export const createFakePluginHost = (options: Parameters<typeof createHost>[0]) => {
  const result = createHost(options);
  if (!options?.sdk?.threads?.list) {
    result.harness.inspection.sdk.stub(
      "threads.list",
      async (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => {
        const projects = await result.bb.sdk.projects.list({ include: "threads", includePersonal: true });
        const all = projects.flatMap((p) => ("threads" in p ? p.threads : []));
        // bb 0.47 filters by id server-side; unknown ids are left out.
        const threads = args?.threadIds ? all.filter((thread) => args.threadIds!.includes(thread.id)) : all;
        const offset = args?.offset ?? 0;
        return threads.slice(offset, offset + (args?.limit ?? 100));
      },
    );
  }
  return result;
};

export interface LifecycleListResult {
  rows: StoredLifecycleRow[];
}
export type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;

export const disposers: Array<() => Promise<void>> = [];

export function standardProject() {
  return {
    id: "proj_1",
    name: "Sidebar",
    kind: "standard" as const,
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source_1",
        projectId: "proj_1",
        type: "local_path" as const,
        hostId: "host_1",
        path: "/workspace/sidebar",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

export type ProjectThread = Extract<
  Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number],
  { threads: unknown }
>["threads"][number];

/** A thread as bb's project list reports it, idle unless overridden. */
export function projectThread(overrides: Partial<ProjectThread> & { id: string }): ProjectThread {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: null,
    createdAt: 1,
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: null,
    environmentIsWorktree: null,
    environmentName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    lastReadAt: null,
    latestAttentionAt: 1,
    lifecycleOwnerThreadId: null,
    originKind: null,
    originPluginId: null,
    parentThreadId: null,
    pinSortKey: null,
    pinnedAt: null,
    projectId: "proj_1",
    providerId: "codex",
    queuedWork: "none",
    runtime: { displayStatus: "idle" },
    sectionId: null,
    sourceThreadId: null,
    status: "idle",
    title: null,
    titleFallback: null,
    parentNotifications: "auto",
    updatedAt: 1,
    visibility: "visible",
    ...overrides,
  };
}

export function projectsWith(threads: ProjectThread[]) {
  return [{ ...standardProject(), defaultExecutionOptions: null, threads }];
}

export function terminalSession(overrides: {
  id: string;
  environmentId?: string | null;
  lastUserInputAt?: number | null;
  status?: "disconnected" | "exited" | "running" | "starting";
}) {
  return {
    closeReason: null,
    cols: 80,
    createdAt: 1,
    environmentId: null,
    exitCode: null,
    hostId: "host_1",
    initialCwd: "/workspace/sidebar",
    lastUserInputAt: null,
    rows: 24,
    status: "running" as const,
    threadId: "thr_1",
    title: "zsh",
    updatedAt: 1,
    ...overrides,
  };
}

export function availablePullRequest(
  state: "closed" | "draft" | "merged" | "open",
  updatedAt = new Date().toISOString(),
) {
  return {
    outcome: "available" as const,
    pullRequest: {
      attention: state === "merged" ? ("merged" as const) : ("none" as const),
      baseRefName: "main",
      checks: {
        failedCount: 0,
        passedCount: 1,
        pendingCount: 0,
        state: "passing" as const,
        totalCount: 1,
      },
      headRefName: "feature",
      mergeability: {
        mergeStateStatus: "CLEAN" as const,
        mergeable: "MERGEABLE" as const,
        state: "mergeable" as const,
      },
      number: 12,
      review: {
        reviewRequestCount: 0,
        state: "approved" as const,
      },
      state,
      title: "Pull request",
      updatedAt,
      url: "https://example.com/pr/12",
    },
  };
}

type PullRequestStatusRow =
  | ReturnType<typeof availablePullRequest>
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string };

/**
 * A `plugins.callRpc` fake that answers GitHub PR Status's keyed
 * `pullRequests` read with one row per environment id, and records each batch.
 */
export function pullRequestStatus(
  row: (environmentId: string) => PullRequestStatusRow | Promise<PullRequestStatusRow>,
  batches: string[][] = [],
) {
  const callRpc = async ({
    pluginId,
    method,
    input,
    outputSchema,
  }: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]) => {
    if (pluginId !== GITHUB_PR_STATUS_PLUGIN_ID || method !== "pullRequests") {
      throw new Error(`Unexpected RPC ${pluginId}.${method}`);
    }
    const { keys } = input as { keys: string[] };
    batches.push(keys);
    return outputSchema.parse(Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await row(key)]))));
  };
  return callRpc as BbPluginApi["sdk"]["plugins"]["callRpc"];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

export async function loadPlugin(
  unpin: (input: { threadId: string }) => Promise<ReturnType<typeof makeThreadResponse>> = async ({ threadId }) =>
    makeThreadResponse({ id: threadId }),
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith([projectThread({ id: "thr_1" })]) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        pin: async ({ threadId }) => makeThreadResponse({ id: threadId, pinnedAt: Date.now() }),
        unpin,
        reorderPinned: async ({ threadId }) => [
          makeThreadResponse({
            id: threadId,
            pinnedAt: 1,
          }),
        ],
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  return harness;
}

export { deferred };
