import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost as createHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { type StoredLifecycleRow } from "./server";

// Default both SDK listings to the test's thread fixture. Host-boundary tests
// override them separately to reproduce visibility, paging and stale replies.
const createFakePluginHost = (options: Parameters<typeof createHost>[0]) => {
  const result = createHost(options);
  if (!options?.sdk?.threads?.list) {
    result.harness.inspection.sdk.stub("threads.list", async (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => {
      const projects = await result.bb.sdk.projects.list({ include: "threads", includePersonal: true });
      const threads = projects.flatMap(p => "threads" in p ? p.threads : []);
      const offset = args?.offset ?? 0;
      return threads.slice(offset, offset + (args?.limit ?? 100));
    });
  }
  return result;
};

interface LifecycleListResult {
  rows: StoredLifecycleRow[];
}
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;

const disposers: Array<() => Promise<void>> = [];

function standardProject() {
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

type ProjectThread = Extract<
  Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number],
  { threads: unknown }
>["threads"][number];

/** A thread as bb's project list reports it, idle unless overridden. */
function projectThread(
  overrides: Partial<ProjectThread> & { id: string },
): ProjectThread {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
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
    updatedAt: 1,
    visibility: "visible",
    ...overrides,
  };
}

function projectsWith(threads: ProjectThread[]) {
  return [{ ...standardProject(), defaultExecutionOptions: null, threads }];
}

function terminalSession(
  overrides: {
    id: string;
    environmentId?: string | null;
    lastUserInputAt?: number | null;
    status?: "disconnected" | "exited" | "running" | "starting";
  },
) {
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

function availablePullRequest(
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function loadPlugin(
  unpin: (input: {
    threadId: string;
  }) => Promise<ReturnType<typeof makeThreadResponse>> = async ({ threadId }) =>
    makeThreadResponse({ id: threadId }),
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith([projectThread({ id: "thr_1" })]) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        pin: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, pinnedAt: Date.now() }),
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

describe("lifecycle RPC", () => {
  it("loads archive-preview storage without resetting shelves or project appearance", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    const settings = await harness.behavior.callRpc("getSidebarSettings", {}) as Record<string, unknown>;
    const saved = await harness.behavior.callRpc("updateSidebarSettings", {
      ...settings, projectColorsEnabled: true, projectColorDisplay: "grouped",
      autoSettleInactive: false, autoSettleOnMerge: false,
    });
    const db = bb.storage.database();
    db.prepare("UPDATE sidebar_settings SET archived_shelf_enabled = 1 WHERE id = 1").run();
    db.prepare("INSERT INTO project_colors (project_id, color) VALUES (?, ?)").run("proj_1", "#668899");
    db.prepare(`INSERT INTO thread_lifecycle
      (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("thr_1", 123, "settled", null, null, null);
    const before = await harness.behavior.callRpc("listLifecycle", {});

    const restored = (await harness.lifecycle.reload(plugin)).harness;
    disposers.push(() => restored.lifecycle.dispose());
    await expect(restored.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(saved);
    expect(saved).not.toHaveProperty("archivedShelfEnabled");
    await expect(restored.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: { proj_1: "#668899" } });
    expect(restored.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(restored.inspection.sdk.callsTo("threads.unarchive")).toHaveLength(0);
  });

  it("persists per-project colors, validates them, and resets to automatic", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.get", async () => standardProject());
    await expect(harness.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: {} });
    await harness.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: "#Ab12CD" });
    const reloaded = await harness.lifecycle.reload(plugin);
    const restored = reloaded.harness;
    disposers.push(() => restored.lifecycle.dispose());
    restored.inspection.sdk.stub("projects.get", async () => standardProject());
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: { proj_1: "#ab12cd" } });
    await expect(restored.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: "url(https://example.com)" })).rejects.toThrow();
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: { proj_1: "#ab12cd" } });
    await restored.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: null });
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: {} });
    expect(restored.inspection.realtimeSignals).toContainEqual({ channel: "project-colors", payload: { projectId: "proj_1" } });
  });

  it("previews settled resources and skips a thread that becomes active before cleaning", async () => {
    let laterActive = false;
    const settled = projectThread({ id: "thr_settled", environmentId: "env_shared", environmentHostId: "host_1", environmentPath: "/workspace/shared" });
    const active = projectThread({ id: "thr_active", environmentId: "env_shared", environmentHostId: "host_1", environmentPath: "/workspace/shared", status: "active" });
    const safe = projectThread({ id: "thr_safe" });
    const empty = projectThread({ id: "thr_empty" });
    const later = () => projectThread({ id: "thr_later", status: laterActive ? "active" : "idle" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([settled, active, safe, empty, later()]) },
        threads: {
            get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
          unpin: async ({ threadId }) => makeThreadResponse({ id: threadId }),
          stop: async () => ({ ok: true as const }),
        },
        terminals: {
          list: async ({ scope }) => ({ sessions: scope.threadId === "thr_empty" ? [] : [{
            ...terminalSession({ id: `term_${scope.threadId}`, lastUserInputAt: 5 }),
            threadId: scope.threadId,
          }] }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_settled" });
    await harness.behavior.callRpc("settle", { threadId: "thr_later" });
    await harness.behavior.callRpc("settle", { threadId: "thr_safe" });
    await harness.behavior.callRpc("settle", { threadId: "thr_empty" });

    const preview = await harness.behavior.callRpc("previewSettledCleanup", {
      threadIds: ["thr_settled", "thr_safe", "thr_later", "thr_active", "thr_empty"],
    }) as { token: string; threads: Array<{ threadId: string; terminalCount: number; ports: number[] }>; skipped: Array<{ threadId: string }> };
    expect(preview.threads).toEqual([
      expect.objectContaining({ threadId: "thr_safe", terminalCount: 1, ports: [] }),
      expect.objectContaining({ threadId: "thr_later", terminalCount: 1, ports: [] }),
    ]);
    expect(preview.skipped).toEqual([expect.objectContaining({ threadId: "thr_active" })]);
    const stopsBefore = harness.inspection.sdk.callsTo("threads.stop").length;
    laterActive = true;
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({
      closedTerminals: 1,
      signalledPorts: [],
      skipped: expect.arrayContaining([expect.objectContaining({ threadId: "thr_later", resource: "thread" })]),
    });
    expect(harness.inspection.sdk.callsTo("threads.stop").slice(stopsBefore)).toEqual([]);
    expect(harness.inspection.sdk.callsTo("terminals.close")).toEqual([[{ terminalId: "term_thr_safe", mode: "force" }]]);
    await expect(harness.behavior.callRpc("cleanSettled", { token: preview.token })).rejects.toThrow("expired");
  });

  it("signals only previewed owned ports and rechecks shared workspaces before cleaning", async () => {
    let portOpen = true;
    let activeSibling = false;
    let shutdownCalls = 0;
    let workspacePath = "/workspace/shared";
    const owner = projectThread({ id: "thr_owner", environmentId: "env_one", environmentHostId: "host_1", environmentPath: "/workspace/shared" });
    const sibling = projectThread({ id: "thr_sibling", environmentId: "env_other", environmentHostId: "host_1", environmentPath: "/workspace/shared", status: "active", visibility: "hidden" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: Array<{ environmentId: string; path: string }> }).roots };
        if (method === "scan") return { ports: portOpen ? [{ environmentId: "env_one", port: 3000, pid: 45, processStartedAt: "Sat Oct  3 12:29:38 2026", source: "process", ownerThreadId: "thr_owner" }] : [] };
        if (method === "closeOwnedPorts") {
          shutdownCalls += 1;
          portOpen = false;
          return { signalled: [3000], skipped: [], failed: [] };
        }
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith(activeSibling ? [owner, sibling] : [owner]) },
        threads: {
            get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        environments: {
          get: async () => ({ id: "env_one", hostId: "host_1", path: workspacePath, status: "ready" }) as Environment,
        },
        terminals: { list: async () => ({ sessions: [] }) },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });

    const first = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { token: string; threads: Array<{ ports: number[] }> };
    expect(first.threads[0]?.ports).toEqual([3000]);
    const firstResult = await harness.behavior.callRpc("cleanSettled", { token: first.token });
    expect(firstResult).toMatchObject({ signalledPorts: [{ threadId: "thr_owner", port: 3000 }], remainingPorts: [] });
    expect(shutdownCalls).toBe(1);

    portOpen = true;
    const second = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { token: string };
    activeSibling = true;
    const secondResult = await harness.behavior.callRpc("cleanSettled", { token: second.token });
    expect(secondResult).toMatchObject({
      signalledPorts: [],
      skipped: [expect.objectContaining({ threadId: "thr_owner", resource: "thread" })],
    });
    expect(shutdownCalls).toBe(1);

    activeSibling = false;
    const third = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { token: string };
    workspacePath = "/workspace/elsewhere";
    const thirdResult = await harness.behavior.callRpc("cleanSettled", { token: third.token });
    expect(thirdResult).toMatchObject({
      signalledPorts: [],
      skipped: [expect.objectContaining({ threadId: "thr_owner", resource: "port", message: "Thread workspace changed since preview" })],
    });
    expect(shutdownCalls).toBe(1);
  });

  it("does not close a previewed terminal when its thread starts working during inspection", async () => {
    let working = false;
    let terminalLists = 0;
    const closed: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([projectThread({ id: "thr_race", status: working ? "active" : "idle" })]) },
        threads: { get: async () => makeThreadResponse({ id: "thr_race" }), unpin: async () => makeThreadResponse({ id: "thr_race" }), stop: async () => ({ ok: true as const }) },
        terminals: {
          list: async () => {
            terminalLists += 1;
            if (terminalLists === 3) working = true;
            return { sessions: [{ ...terminalSession({ id: "term_race", lastUserInputAt: 5 }), threadId: "thr_race" }] };
          },
          close: async ({ terminalId }) => { closed.push(terminalId); return terminalSession({ id: terminalId, status: "exited" }); },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_race" });
    const preview = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_race"] }) as { token: string; threads: unknown[] };
    expect(preview.threads).toHaveLength(1);
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({ closedTerminals: 0, skipped: [expect.objectContaining({ resource: "terminal" })] });
    expect(closed).toEqual([]);
  });

  it("protects terminals when different environments resolve to the same workspace", async () => {
    const owner = projectThread({ id: "thr_owner", environmentId: "env_one", environmentHostId: "host_1", environmentPath: "/workspace/shared" });
    const active = projectThread({ id: "thr_active", environmentId: "env_two", environmentHostId: "host_1", environmentPath: "/workspace/shared/", status: "active" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: Array<{ environmentId: string }> }).roots.map((root) => ({ environmentId: root.environmentId, path: "/workspace/shared" })) };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner, active]) },
        threads: { get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }), unpin: async () => makeThreadResponse({ id: "thr_owner" }), stop: async () => ({ ok: true as const }) },
        terminals: { list: async () => ({ sessions: [{ ...terminalSession({ id: "term_shared", lastUserInputAt: 5 }), threadId: "thr_owner" }] }) },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const closesBefore = harness.inspection.sdk.callsTo("terminals.close").length;
    const preview = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { threads: unknown[] };
    expect(preview.threads).toEqual([]);
    expect(harness.inspection.sdk.callsTo("terminals.close").slice(closesBefore)).toEqual([]);
  });

  it("does not close a terminal when work is queued during the final workspace lookup", async () => {
    let cleaning = false;
    let queued = false;
    const owner = () => projectThread({
      id: "thr_owner", environmentId: "env_one", environmentHostId: "host_1",
      environmentPath: "/workspace/one", queuedWork: queued ? "waiting" : "none",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: unknown[] }).roots };
        if (method === "scan") return { ports: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner()]) },
        threads: {
            get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        environments: { get: async () => {
          if (cleaning) queued = true;
          return { id: "env_one", hostId: "host_1", path: "/workspace/one", status: "ready" } as Environment;
        } },
        terminals: {
          list: async () => ({ sessions: [{ ...terminalSession({ id: "term_owner", environmentId: "env_one", lastUserInputAt: 5 }), threadId: "thr_owner" }] }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const preview = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { token: string; threads: unknown[] };
    expect(preview.threads).toHaveLength(1);
    cleaning = true;
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(queued).toBe(true);
    expect(result).toMatchObject({ closedTerminals: 0, skipped: [expect.objectContaining({ resource: "terminal" })] });
    expect(harness.inspection.sdk.callsTo("terminals.close")).toEqual([]);
  });

  it("keeps preview inspection failures in the final cleanup result", async () => {
    const owner = projectThread({ id: "thr_owner", environmentId: "env_one", environmentHostId: "host_1", environmentPath: "/workspace/one" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: unknown[] }).roots };
        if (method === "scan") throw new Error("Port scan unavailable");
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner]) },
        threads: { get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }), unpin: async () => makeThreadResponse({ id: "thr_owner" }), stop: async () => ({ ok: true as const }) },
        environments: { get: async () => ({ id: "env_one", hostId: "host_1", path: "/workspace/one", status: "ready" }) as Environment },
        terminals: {
          list: async () => ({ sessions: [{ ...terminalSession({ id: "term_owner", environmentId: "env_one", lastUserInputAt: 5 }), threadId: "thr_owner" }] }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const preview = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { token: string; skipped: Array<{ resource: string }> };
    expect(preview.skipped).toEqual([expect.objectContaining({ resource: "port" })]);
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({ closedTerminals: 1, skipped: [expect.objectContaining({ resource: "port", message: expect.stringContaining("Port scan unavailable") })] });
  });

  it("does not close a terminal left in an earlier shared workspace", async () => {
    const owner = projectThread({ id: "thr_owner", environmentId: "env_private", environmentHostId: "host_1", environmentPath: "/workspace/private" });
    const sibling = projectThread({ id: "thr_active", environmentId: "env_shared", environmentHostId: "host_1", environmentPath: "/workspace/shared", status: "active" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: unknown[] }).roots };
        if (method === "scan") return { ports: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner, sibling]) },
        threads: { get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_private" }), unpin: async () => makeThreadResponse({ id: "thr_owner" }), stop: async () => ({ ok: true as const }) },
        environments: { get: async () => ({ id: "env_private", hostId: "host_1", path: "/workspace/private", status: "ready" }) as Environment },
        terminals: {
          list: async () => ({ sessions: [
            { ...terminalSession({ id: "term_old", environmentId: "env_shared", lastUserInputAt: 5 }), threadId: "thr_owner" },
            { ...terminalSession({ id: "term_current", environmentId: "env_private", lastUserInputAt: 5 }), threadId: "thr_owner" },
          ] }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const closesBefore = harness.inspection.sdk.callsTo("terminals.close").length;
    const preview = await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] }) as { token: string; threads: unknown[] };
    expect(preview.threads).toEqual([expect.objectContaining({ threadId: "thr_owner", terminalCount: 1 })]);
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({ closedTerminals: 1, failed: [] });
    expect(harness.inspection.sdk.callsTo("terminals.close").slice(closesBefore)).toEqual([[{ terminalId: "term_current", mode: "force" }]]);
  });

  it("returns no ports when no threads have environments", async () => {
    const harness = await loadPlugin();
    await expect(harness.behavior.callRpc("getOpenPorts", {})).resolves.toEqual({
      groups: [],
    });
  });

  it("returns only model and reasoning details, including unset options", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "default",
      source: "client/turn/start",
    }));
    await expect(harness.behavior.callRpc("getThreadExecutionDetails", {
      threadId: "thr_1",
    })).resolves.toEqual({ model: "gpt-6", reasoningLevel: "high" });
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => null);
    await expect(harness.behavior.callRpc("getThreadExecutionDetails", {
      threadId: "thr_1",
    })).resolves.toBeNull();
  });

  it("stores the grouped sidebar settings through RPC", async () => {
    const harness = await loadPlugin();
    expect(harness.inspection.registrations.settingsDescriptors).toEqual({});
    await expect(
      harness.behavior.callRpc("getSidebarSettings", {}),
    ).resolves.toEqual({
      snoozePresets: "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00",
      inactiveThreadsEnabled: true,
      inactiveAfterHours: 6,
      showRunningChildrenWhenCollapsed: true,
      autoSettleInactive: true,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      childSortField: "created",
      childSortDirection: "ascending",
      childIconStyle: "disc",
      compactWorkingThreads: false,
      workingShelf: false,
      dockShelves: false,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
    });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "10m, 4h",
        inactiveThreadsEnabled: false,
        inactiveAfterHours: 12,
        showRunningChildrenWhenCollapsed: false,
        autoSettleInactive: false,
        autoSettleAfterDays: 7,
        autoSettleOnMerge: false,
        childSortField: "activity",
        childSortDirection: "descending",
        childIconStyle: "provider",
        compactWorkingThreads: true,
        workingShelf: true,
        dockShelves: true,
        projectColorsEnabled: true,
        projectColorDisplay: "grouped",
      }),
    ).resolves.toEqual({
      snoozePresets: "10m, 4h",
      inactiveThreadsEnabled: false,
      inactiveAfterHours: 12,
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 7,
      autoSettleOnMerge: false,
      childSortField: "activity",
      childSortDirection: "descending",
      childIconStyle: "provider",
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
      projectColorsEnabled: true,
      projectColorDisplay: "grouped",
    });
    // A client that predates the setting leaves it out and must not reset it.
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "10m, 4h",
        inactiveThreadsEnabled: false,
        inactiveAfterHours: 12,
        showRunningChildrenWhenCollapsed: false,
        autoSettleInactive: false,
        autoSettleAfterDays: 7,
        autoSettleOnMerge: false,
        childSortField: "activity",
        childSortDirection: "descending",
        childIconStyle: "provider",
      }),
    ).resolves.toMatchObject({ compactWorkingThreads: true, workingShelf: true, dockShelves: true, projectColorsEnabled: true, projectColorDisplay: "grouped" });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "sidebar-settings",
      payload: {},
    });
    expect(harness.inspection.registrations.schedules).toContainEqual(
      expect.objectContaining({ name: "auto-settle", cron: "*/5 * * * *" }),
    );
  });

  it("persists color display mode across reloads and rejects unknown modes", async () => {
    const harness = await loadPlugin();
    const settings = await harness.behavior.callRpc("getSidebarSettings", {}) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, projectColorDisplay: "full" });
    await expect(harness.behavior.callRpc("updateSidebarSettings", { ...settings, projectColorDisplay: "invalid" })).rejects.toThrow("rpc input validation failed");
    const reloaded = await harness.lifecycle.reload(plugin);
    disposers.push(() => reloaded.harness.lifecycle.dispose());
    await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      projectColorDisplay: "full",
      projectColorsEnabled: false,
    });
  });

  it("rejects invalid snooze shortcuts at the RPC boundary", async () => {
    const harness = await loadPlugin();

    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "later",
        inactiveThreadsEnabled: true,
        inactiveAfterHours: 6,
        showRunningChildrenWhenCollapsed: true,
        autoSettleInactive: true,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
        childSortField: "created",
        childSortDirection: "ascending",
        childIconStyle: "disc",
      }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(
      harness.behavior.callRpc("getSidebarSettings", {}),
    ).resolves.toMatchObject({ snoozePresets: "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00" });
  });

  it("saves editable calendar shortcuts and rejects invalid times", async () => {
    const harness = await loadPlugin();
    const settings = await harness.behavior.callRpc("getSidebarSettings", {}) as Record<string, unknown>;
    const snoozePresets = "1h, Wait refresh=5h, Tonight=evening@20:00, Morning=tomorrow@08:30, Monday=next-week@10:00";
    await expect(harness.behavior.callRpc("updateSidebarSettings", { ...settings, snoozePresets })).resolves.toMatchObject({ snoozePresets });
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ snoozePresets });
    await expect(harness.behavior.callRpc("updateSidebarSettings", { ...settings, snoozePresets: "tomorrow@24:00" })).rejects.toThrow("rpc input validation failed");
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ snoozePresets });
  });

  it("migrates values from the previous flat settings form", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        plugins: {
          getSettings: async () => ({
            ok: true as const,
            schema: {},
            values: {
              snoozePresets: "20m, 6h",
              inactiveThreadsEnabled: false,
              inactiveAfterHours: "18",
              showRunningChildrenWhenCollapsed: false,
              autoSettleInactive: false,
              autoSettleAfterDays: "14",
              autoSettleOnMerge: false,
            },
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("getSidebarSettings", {}),
    ).resolves.toEqual({
      snoozePresets: "20m, 6h",
      inactiveThreadsEnabled: false,
      inactiveAfterHours: 18,
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 14,
      autoSettleOnMerge: false,
      childSortField: "created",
      childSortDirection: "ascending",
      childIconStyle: "disc",
      compactWorkingThreads: false,
      workingShelf: false,
      dockShelves: false,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
    });
  });

  it("settles and restores a thread", async () => {
    const harness = await loadPlugin();

    await harness.behavior.callRpc("settle", { threadId: "thr_1" });
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toEqual([]);
    const settled = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    expect(settled.rows).toEqual([
      expect.objectContaining({
        threadId: "thr_1",
        settledAt: expect.any(Number),
        snoozedUntil: null,
      }),
    ]);

    await harness.behavior.callRpc("unsettle", { threadId: "thr_1" });
    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({
      rows: [
        expect.objectContaining({
          threadId: "thr_1",
          settledAt: null,
          settledOverride: "active",
        }),
      ],
    });
  });

  it.each(["settle", "snooze", "park"])(
    "makes pin and %s mutually exclusive in both directions",
    async (method) => {
      const harness = await loadPlugin();
      let pinned = false;
      harness.inspection.sdk.stub("projects.list", async () => projectsWith([projectThread({ id: "thr_1", pinnedAt: pinned ? 1 : null })]));
      harness.inspection.sdk.stub("threads.pin", async ({ threadId }) => {
        pinned = true;
        return makeThreadResponse({ id: threadId, pinnedAt: Date.now() });
      });
      harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
        pinned = false;
        return makeThreadResponse({ id: threadId, pinnedAt: null });
      });

      await harness.behavior.callRpc("pin", { threadId: "thr_1" });
      expect(pinned).toBe(true);
      await harness.behavior.callRpc(method, {
        threadId: "thr_1",
        ...(method === "snooze" ? { snoozedUntil: Date.now() + 60_000 } : {}),
      });
      expect(pinned).toBe(false);
      const shelfField = method === "park" ? "parkedAt"
        : method === "snooze" ? "snoozedUntil" : "settledAt";
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toMatchObject({
        rows: [{ [shelfField]: expect.any(Number) }],
      });

      await expect(harness.behavior.callRpc("pin", { threadId: "thr_1" }))
        .resolves.toEqual({ ok: true });
      expect(pinned).toBe(true);
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({
        rows: [{
          threadId: "thr_1",
          parkedAt: null,
          settledAt: null,
          settledOverride: "active",
          snoozedUntil: null,
          snoozedAt: null,
        }],
      });
      expect(harness.inspection.realtimeSignals.at(-1)).toEqual({
        channel: "lifecycle",
        payload: { threadId: "thr_1" },
      });
    },
  );

  it.each(["settle", "snooze", "park"])(
    "preserves %s when native pinning fails",
    async (method) => {
      const harness = await loadPlugin();
      await harness.behavior.callRpc(method, {
        threadId: "thr_1",
        ...(method === "snooze" ? { snoozedUntil: Date.now() + 60_000 } : {}),
      });
      const before = await harness.behavior.callRpc("listLifecycle", {});
      harness.inspection.sdk.stub("threads.pin", async () => {
        throw new Error("pin update failed");
      });

      await expect(harness.behavior.callRpc("pin", { threadId: "thr_1" }))
        .rejects.toThrow("pin update failed");
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    },
  );

  it("releases the agent session and only the terminals nobody used", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([projectThread({ id: "thr_1" })]) },
        threads: {
            unpin: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId }),
          stop: async () => ({ ok: true as const }),
        },
        terminals: {
          list: async () => ({
            sessions: [
              terminalSession({ id: "term_idle" }),
              terminalSession({ id: "term_used", lastUserInputAt: 5 }),
              terminalSession({ id: "term_gone", status: "exited" }),
            ],
          }),
          close: async ({ terminalId }: { terminalId: string }) =>
            terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("settle", { threadId: "thr_1" }),
    ).resolves.toEqual({
      ok: true,
      reclaim: { closedTerminals: 1, keptTerminals: 1, stoppedRuntime: true },
      undoToken: expect.any(String),
    });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_1" }],
    ]);
    expect(harness.inspection.sdk.callsTo("terminals.close")).toEqual([
      [{ terminalId: "term_idle", mode: "if-clean" }],
    ]);
  });

  it("settles even when the runtime and terminals cannot be reached", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([projectThread({ id: "thr_1" })]) },
        threads: {
            unpin: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId }),
          stop: async () => {
            throw new Error("host offline");
          },
        },
        terminals: {
          list: async () => {
            throw new Error("host offline");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("settle", { threadId: "thr_1" }),
    ).resolves.toEqual({
      ok: true,
      reclaim: { closedTerminals: 0, keptTerminals: 0, stoppedRuntime: false },
      undoToken: expect.any(String),
    });
    const settled = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    expect(settled.rows).toEqual([
      expect.objectContaining({ threadId: "thr_1", settledOverride: "settled" }),
    ]);
  });

  it("releases every archived runtime even when one stop fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        threads: {
            stop: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_offline") throw new Error("host offline");
            return { ok: true as const };
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("releaseRuntimes", {
        threadIds: ["thr_offline", "thr_1"],
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_offline" }],
      [{ threadId: "thr_1" }],
    ]);
  });

  it("keeps settle and snooze mutually exclusive", async () => {
    const harness = await loadPlugin();
    const wakeAt = Date.now() + 60_000;

    await harness.behavior.callRpc("settle", { threadId: "thr_1" });
    await harness.behavior.callRpc("snooze", {
      threadId: "thr_1",
      snoozedUntil: wakeAt,
    });

    const result = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    expect(result.rows).toEqual([
      expect.objectContaining({
        threadId: "thr_1",
        settledAt: null,
        snoozedUntil: wakeAt,
        snoozedAt: expect.any(Number),
      }),
    ]);
  });

  it("clears a woken snooze when the user acknowledges it", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("snooze", {
      threadId: "thr_woke",
      snoozedUntil: Date.now() - 1,
    });

    await harness.behavior.callRpc("acknowledgeWake", {
      threadId: "thr_woke",
    });

    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
  });

  it("persists pinned placement through the bb SDK", async () => {
    const harness = await loadPlugin();

    await expect(
      harness.behavior.callRpc("reorderPinned", {
        threadId: "thr_2",
        previousThreadId: "thr_1",
        nextThreadId: "thr_3",
      }),
    ).resolves.toEqual({ pinnedThreadIds: ["thr_2"] });
    expect(harness.inspection.sdk.callsTo("threads.reorderPinned")).toEqual([
      [
        {
          threadId: "thr_2",
          previousThreadId: "thr_1",
          nextThreadId: "thr_3",
        },
      ],
    ]);
  });

  it("persists inbox order in the plugin database and publishes it", async () => {
    const harness = await loadPlugin();

    await expect(
      harness.behavior.callRpc("reorderInbox", {
        inboxThreadIds: ["thr_2", "thr_1"],
      }),
    ).resolves.toEqual({ inboxThreadIds: ["thr_2", "thr_1"] });
    await expect(
      harness.behavior.callRpc("listInboxOrder", {}),
    ).resolves.toEqual({ inboxThreadIds: ["thr_2", "thr_1"] });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "inbox-order",
      payload: {},
    });

    const reloaded = await harness.lifecycle.reload(plugin);
    disposers.push(() => reloaded.harness.lifecycle.dispose());
    await expect(
      reloaded.harness.behavior.callRpc("listInboxOrder", {}),
    ).resolves.toEqual({ inboxThreadIds: ["thr_2", "thr_1"] });
  });

  it("rejects duplicate inbox ids without replacing the saved order", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("reorderInbox", {
      inboxThreadIds: ["thr_1", "thr_2"],
    });

    await expect(
      harness.behavior.callRpc("reorderInbox", {
        inboxThreadIds: ["thr_1", "thr_1"],
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("listInboxOrder", {}),
    ).resolves.toEqual({ inboxThreadIds: ["thr_1", "thr_2"] });
  });

  it("removes lifecycle state when bb deletes the thread", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("settle", { threadId: "thr_1" });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
  });

  it("removes a deleted thread from the saved inbox order", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("reorderInbox", {
      inboxThreadIds: ["thr_1", "thr_2"],
    });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    await expect(
      harness.behavior.callRpc("listInboxOrder", {}),
    ).resolves.toEqual({ inboxThreadIds: ["thr_2"] });
  });

  it.each(["settle", "snooze", "park"])("does not %s when native unpinning fails", async (method) => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([projectThread({ id: "thr_1", pinnedAt: 1 })]) },
        threads: {
          unpin: async () => {
            throw new Error("pin update failed");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc(method, {
        threadId: "thr_1",
        ...(method === "snooze" ? { snoozedUntil: Date.now() + 60_000 } : {}),
      }),
    ).rejects.toThrow("pin update failed");
    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  });
});

describe("settling thread trees", () => {
  const tree = () => [
    projectThread({ id: "parent" }),
    projectThread({ id: "child", parentThreadId: "parent", projectId: "other" }),
    projectThread({ id: "grandchild", parentThreadId: "child" }),
    projectThread({ id: "hidden", parentThreadId: "parent", visibility: "hidden" }),
    projectThread({ id: "archived", parentThreadId: "parent", archivedAt: 1 }),
    projectThread({ id: "unrelated" }),
  ];

  it.each(["thread.created", "thread.active"] as const)(
    "reopens settled ancestors across projects on %s without waking siblings",
    async (event) => {
      const harness = await loadPlugin();
      const threads = tree();
      harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
        const thread = threads.find(thread => thread.id === threadId)!;
        return makeThreadResponse({ id: thread.id, parentThreadId: thread.parentThreadId, projectId: thread.projectId });
      });
      await harness.behavior.callRpc("settle", { threadId: "parent" });
      const child = event === "thread.created"
        ? projectThread({ id: "new-child", parentThreadId: "child" })
        : threads.find(thread => thread.id === "grandchild")!;
      await harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: child.id, parentThreadId: child.parentThreadId, status: "active" }),
      });
      const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
      expect(rows.some(row => ["parent", "child", child.id].includes(row.threadId))).toBe(false);
      expect(rows.find(row => row.threadId === "hidden")?.settledAt).toEqual(expect.any(Number));
      if (event === "thread.created") {
        expect(rows.find(row => row.threadId === "grandchild")?.settledAt).toEqual(expect.any(Number));
      }
      expect(harness.inspection.realtimeSignals.at(-1)).toEqual({
        channel: "lifecycle", payload: { threadIds: ["child", "parent"] },
      });
    },
  );

  it("reopens ancestors when a child is manually returned to Active", async () => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      const thread = threads.find(thread => thread.id === threadId)!;
      return makeThreadResponse({ id: thread.id, parentThreadId: thread.parentThreadId });
    });
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    await harness.behavior.callRpc("unsettle", { threadId: "grandchild" });
    const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(rows.some(row => row.threadId === "parent" || row.threadId === "child")).toBe(false);
    expect(rows.find(row => row.threadId === "grandchild")?.settledOverride).toBe("active");
    expect(rows.find(row => row.threadId === "hidden")?.settledAt).toEqual(expect.any(Number));
  });

  it("keeps a newer settle when an earlier child event finishes late", async () => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    const parent = deferred<ReturnType<typeof makeThreadResponse>>();
    harness.inspection.sdk.stub("threads.get", () => parent.promise);
    const event = harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id: "child", parentThreadId: "parent" }),
    });
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    parent.resolve(makeThreadResponse({ id: "parent" }));
    await event;
    const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(rows.every(row => row.settledAt !== null)).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it.each([
    ["thread.active", "park", "child"],
    ["thread.active", "snooze", "child"],
    ["thread.created", "park", "child"],
    ["thread.created", "snooze", "child"],
    ["thread.active", "park", "parent"],
    ["thread.active", "snooze", "parent"],
    ["thread.created", "park", "parent"],
    ["thread.created", "snooze", "parent"],
  ] as const)("a delayed %s preserves a newer %s on %s while ancestor lookups are pending", async (event, action, target) => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    const entered = deferred<void>();
    const lookup = deferred<void>();
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === "child") {
        entered.resolve();
        await lookup.promise;
      }
      return makeThreadResponse(threads.find(thread => thread.id === threadId)!);
    });
    const pending = harness.behavior.emitThreadEvent(event, {
      thread: makeThreadResponse({
        id: event === "thread.created" ? "new-child" : "grandchild",
        parentThreadId: "child", status: "active",
      }),
    });
    await entered.promise;
    await harness.behavior.callRpc(action, {
      threadId: target,
      ...(action === "snooze" ? { snoozedUntil: Date.now() + 86400000 } : {}),
    });
    const before = (await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult).rows;
    lookup.resolve();
    expect((await pending).errors).toEqual([]);
    const after = (await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult).rows;
    expect(after.find(row => row.threadId === target)).toEqual(before.find(row => row.threadId === target));
    // A newer choice on the nearest ancestor also protects the shelves above it.
    if (target === "child") {
      expect(after.find(row => row.threadId === "parent")).toEqual(before.find(row => row.threadId === "parent"));
    }
  });

  it("returns a child and its ancestors to Active without a lookup after the shelf move", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree()));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    harness.inspection.sdk.stub("threads.get", async () => { throw new Error("ancestor unavailable"); });

    await expect(harness.behavior.callRpc("unsettle", { threadId: "grandchild" })).resolves.toEqual({ ok: true });
    const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(rows.some(row => ["parent", "child"].includes(row.threadId))).toBe(false);
    expect(rows.find(row => row.threadId === "grandchild")?.settledOverride).toBe("active");
    expect(rows.find(row => row.threadId === "hidden")?.settledOverride).toBe("settled");
  });

  it("does not change shelves when Return to Active cannot load the tree", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree()));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    harness.inspection.sdk.stub("threads.list", async () => { throw new Error("tree unavailable"); });

    await expect(harness.behavior.callRpc("unsettle", { threadId: "grandchild" })).rejects.toThrow("tree unavailable");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it("finishes policy wakeups and runtime cleanup without ancestor lookups after writing rows", async () => {
    const harness = await loadPlugin();
    const old = Date.now() - 8 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    const threads = [
      projectThread({ id: "parent", ...quiet }),
      projectThread({ id: "child", parentThreadId: "parent", ...quiet }),
    ];
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
    await harness.behavior.callRpc("evaluateAutoSettle", {});

    threads[1]!.status = "active";
    threads.push(projectThread({ id: "quiet-root", ...quiet }));
    harness.inspection.sdk.stub("threads.get", async () => { throw new Error("ancestor unavailable"); });
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["child", "quiet-root", "parent"],
    });
    const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(rows.map(row => row.threadId)).toEqual(["quiet-root"]);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toContainEqual([{ threadId: "quiet-root" }]);
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
  });

  it("keeps the child event successful when a higher ancestor lookup fails", async () => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === "parent") throw new Error("ancestor unavailable");
      return makeThreadResponse(threads.find(thread => thread.id === threadId)!);
    });

    const { errors } = await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "grandchild", parentThreadId: "child", status: "active" }),
    });
    expect(errors).toEqual([]);
    const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(rows.some(row => ["child", "grandchild"].includes(row.threadId))).toBe(false);
    expect(rows.find(row => row.threadId === "parent")?.settledOverride).toBe("settled");
    expect(harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn", message: "Could not load ancestor parent: ancestor unavailable",
    }));
  });

  it("settles descendants across projects together and explicitly returns the tree to Active", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree()));
    harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    const { rows } = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(rows.map(row => row.threadId).sort()).toEqual(["child", "grandchild", "hidden", "parent"]);
    expect(new Set(rows.map(row => row.settledAt)).size).toBe(1);
    expect(rows.every(row => row.settledOverride === "settled" && row.snoozedUntil === null)).toBe(true);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(4);
    expect(harness.inspection.realtimeSignals.filter(signal => signal.channel === "lifecycle")).toHaveLength(1);
    await harness.behavior.callRpc("unsettle", { threadId: "parent" });
    const restored = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(restored.rows).toEqual([expect.objectContaining({ threadId: "parent", settledAt: null, settledOverride: "active" })]);
  });

  it("Undo restores children's previous shelves without adding Active overrides", async () => {
    const harness = await loadPlugin();
    const threads = [
      projectThread({ id: "parent" }),
      ...["ordinary", "settled", "parked", "snoozed"].map(id =>
        projectThread({ id, parentThreadId: "parent" })),
    ];
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    await harness.behavior.callRpc("settle", { threadId: "settled" });
    await harness.behavior.callRpc("park", { threadId: "parked" });
    await harness.behavior.callRpc("snooze", { threadId: "snoozed", snoozedUntil: Date.now() + 86400000 });
    const before = await harness.behavior.callRpc("listLifecycle", {});

    const { undoToken } = await harness.behavior.callRpc("settle", { threadId: "parent" }) as { undoToken: string };
    await harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    await expect(harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken })).rejects.toThrow("can no longer be undone");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it("a quiet tree can automatically settle again after Undo", async () => {
    const harness = await loadPlugin();
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    harness.inspection.sdk.stub("projects.list", async () => projectsWith([
      projectThread({ id: "parent", ...quiet }),
      projectThread({ id: "child", parentThreadId: "parent", ...quiet }),
    ]));
    const { undoToken } = await harness.behavior.callRpc("settle", { threadId: "parent" }) as { undoToken: string };
    await harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {}))
      .resolves.toEqual({ changedThreadIds: ["parent", "child"] });
  });

  it("Undo preserves newer shelf choices and children that have resumed work", async () => {
    const harness = await loadPlugin();
    const threads = [
      projectThread({ id: "parent" }),
      ...["ordinary", "parked", "snoozed", "working"].map(id =>
        projectThread({ id, parentThreadId: "parent" })),
    ];
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({
      id: threadId, parentThreadId: threads.find(thread => thread.id === threadId)!.parentThreadId,
    }));
    await harness.behavior.callRpc("park", { threadId: "working" });
    const { undoToken } = await harness.behavior.callRpc("settle", { threadId: "parent" }) as { undoToken: string };
    await harness.behavior.callRpc("park", { threadId: "parked" });
    await harness.behavior.callRpc("snooze", { threadId: "snoozed", snoozedUntil: Date.now() + 86400000 });
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "working", parentThreadId: "parent", status: "active" }),
    });
    const before = await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    await harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({
      rows: before.rows.filter(row => row.threadId !== "ordinary"),
    });
  });

  it("an earlier Undo cannot erase a newer settle, even within the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const harness = await loadPlugin();
    const first = await harness.behavior.callRpc("settle", { threadId: "thr_1" }) as { undoToken: string };
    const before = await harness.behavior.callRpc("listLifecycle", {});
    const second = await harness.behavior.callRpc("settle", { threadId: "thr_1" }) as { undoToken: string };
    const newer = await harness.behavior.callRpc("listLifecycle", {});
    await harness.behavior.callRpc("unsettle", { threadId: "thr_1", undoToken: first.undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(newer);
    await harness.behavior.callRpc("unsettle", { threadId: "thr_1", undoToken: second.undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each(["expired", "reloaded"])("rejects an %s Undo without changing lifecycle state", async reason => {
    let harness = await loadPlugin();
    const { undoToken } = await harness.behavior.callRpc("settle", { threadId: "thr_1" }) as { undoToken: string };
    const before = await harness.behavior.callRpc("listLifecycle", {});
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
    else {
      harness = (await harness.lifecycle.reload(plugin)).harness;
      disposers.push(() => harness.lifecycle.dispose());
    }
    await expect(harness.behavior.callRpc("unsettle", { threadId: "thr_1", undoToken })).rejects.toThrow("can no longer be undone");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each([
    { status: "active" as const },
    { hasPendingInteraction: true },
    { queuedWork: "waiting" as const },
    { activity: { ...projectThread({ id: "unused" }).activity, activeBackgroundCommandCount: 1 } },
  ])("refuses the whole settle when a descendant has live work: %j", async (busy) => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree().map(thread =>
      thread.id === "grandchild" ? { ...thread, ...busy } : thread,
    )));
    await expect(harness.behavior.callRpc("settle", { threadId: "parent" })).rejects.toThrow("Cannot settle");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("does not settle any rows if a descendant cannot be unpinned", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree().map(thread => thread.id === "child" ? { ...thread, pinnedAt: 1 } : thread)));
    harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      if (threadId === "child") throw new Error("unpin failed");
      return makeThreadResponse({ id: threadId });
    });
    await expect(harness.behavior.callRpc("settle", { threadId: "parent" })).rejects.toThrow("unpin failed");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("rechecks descendants after unpinning before stopping runtimes", async () => {
    const harness = await loadPlugin();
    let active = false;
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree().map(thread =>
      thread.id === "grandchild" && active ? { ...thread, status: "active" as const } :
      thread.id === "child" && !active ? { ...thread, pinnedAt: 1 } : thread,
    )));
    harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      active = true;
      return makeThreadResponse({ id: threadId });
    });
    await expect(harness.behavior.callRpc("settle", { threadId: "parent" })).rejects.toThrow("Thread tree changed");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });
});

describe("project icons", () => {
  it("stores per-project choices and searches only supported image files", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          list: async () => [project],
          paths: async () => ({
            paths: [
              {
                kind: "file" as const,
                name: "brand.svg",
                path: "public/brand.svg",
                positions: [],
                score: 1,
              },
              {
                kind: "file" as const,
                name: "readme.md",
                path: "README.md",
                positions: [],
                score: 0.5,
              },
            ],
            truncated: false,
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("listProjectIconSettings", {}),
    ).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: null,
          customUploadName: null,
        },
      ],
    });
    await expect(
      harness.behavior.callRpc("searchProjectIconFiles", {
        projectId: "proj_1",
        query: "brand",
      }),
    ).resolves.toEqual({ paths: ["public/brand.svg"] });

    await expect(
      harness.behavior.callRpc("setProjectIcon", {
        projectId: "proj_1",
        path: "public/brand.svg",
      }),
    ).resolves.toEqual({
      customPath: "public/brand.svg",
      customUploadName: null,
    });
    await expect(
      harness.behavior.callRpc("listProjectIconSettings", {}),
    ).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: "public/brand.svg",
          customUploadName: null,
        },
      ],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "project-icons",
      payload: { projectId: "proj_1" },
    });

    await expect(
      harness.behavior.callRpc("uploadProjectIcon", {
        projectId: "proj_1",
        filename: "brand.svg",
        mimeType: "image/svg+xml",
        contentBase64: "PHN2Zy8+",
      }),
    ).resolves.toEqual({
      customPath: null,
      customUploadName: "brand.svg",
    });
    await expect(
      harness.behavior.callRpc("listProjectIconSettings", {}),
    ).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: null,
          customUploadName: "brand.svg",
        },
      ],
    });
    const response = await harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=proj_1",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    await expect(response.text()).resolves.toBe("<svg/>");
  });

  it("serves an automatically discovered favicon through the local route", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (path !== "favicon.svg") throw new Error("not found");
            return {
              content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
              contentEncoding: "utf8" as const,
              mimeType: "image/svg+xml",
              sizeBytes: 46,
            };
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const [response, concurrentResponse] = await Promise.all([
      harness.behavior.fetchHttp(
        "GET",
        "/project-icon?projectId=proj_1",
      ),
      harness.behavior.fetchHttp(
        "GET",
        "/project-icon?projectId=proj_1",
      ),
    ]);
    expect(response.status).toBe(200);
    expect(concurrentResponse.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    await expect(response.text()).resolves.toContain("<svg");
    expect(harness.inspection.sdk.callsTo("projects.fileContent")).toEqual([
      [
        {
          projectId: "proj_1",
          hostId: "host_1",
          path: "favicon.svg",
        },
      ],
    ]);
  });

  it("does not cache a failed icon read as a missing icon", async () => {
    const project = standardProject();
    let hostReady = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (!hostReady) throw new Error("Host host_1 is not connected");
            if (path !== "icon.svg") throw new Error("not found");
            return {
              content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
              contentEncoding: "utf8" as const,
              mimeType: "image/svg+xml",
              sizeBytes: 46,
            };
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const failed = await harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=proj_1",
    );
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");

    hostReady = true;
    const recovered = await harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=proj_1",
    );
    expect(recovered.status).toBe(200);
    await expect(recovered.text()).resolves.toContain("<svg");
  });

  it("does not reuse or cache an icon resolution that was invalidated", async () => {
    const project = standardProject();
    let oldReadStarted!: () => void;
    const oldReadStartedPromise = new Promise<void>((resolve) => {
      oldReadStarted = resolve;
    });
    let resolveOldRead!: (file: {
      content: string;
      contentEncoding: "utf8";
      mimeType: string;
      sizeBytes: number;
    }) => void;
    const oldRead = new Promise<{
      content: string;
      contentEncoding: "utf8";
      mimeType: string;
      sizeBytes: number;
    }>((resolve) => {
      resolveOldRead = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (path === "old.svg") {
              oldReadStarted();
              return oldRead;
            }
            if (path === "new.svg") {
              return {
                content: "new",
                contentEncoding: "utf8" as const,
                mimeType: "image/svg+xml",
                sizeBytes: 3,
              };
            }
            throw new Error("not found");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await harness.behavior.callRpc("setProjectIcon", {
      projectId: "proj_1",
      path: "old.svg",
    });
    const firstResponse = harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=proj_1",
    );
    await oldReadStartedPromise;

    await expect(
      harness.behavior.callRpc("setProjectIcon", {
        projectId: "proj_1",
        path: "new.svg",
      }),
    ).resolves.toEqual({
      customPath: "new.svg",
      customUploadName: null,
    });
    const secondResponse = await harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=proj_1",
    );
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.text()).resolves.toBe("new");

    resolveOldRead({
      content: "old",
      contentEncoding: "utf8",
      mimeType: "image/svg+xml",
      sizeBytes: 3,
    });
    const first = await firstResponse;
    expect(first.status).toBe(200);
    await expect(first.text()).resolves.toBe("old");

    const afterPendingResponse = await harness.behavior.fetchHttp(
      "GET",
      "/project-icon?projectId=proj_1",
    );
    expect(afterPendingResponse.status).toBe(200);
    await expect(afterPendingResponse.text()).resolves.toBe("new");
  });
});

describe("project management", () => {
  it("renames standard projects and rejects personal projects or empty names", async () => {
    let project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: { projects: { get: async () => project, update: async ({ name }) => ({ ...project, name: name! }) } },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("renameProject", { projectId: "proj_1", name: "  New name  " })).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("projects.update")).toEqual([[{ projectId: "proj_1", name: "New name" }]]);
    await expect(harness.behavior.callRpc("renameProject", { projectId: "proj_1", name: " " })).rejects.toThrow();
    project = { ...project, kind: "personal" } as unknown as typeof project;
    await expect(harness.behavior.callRpc("renameProject", { projectId: "proj_1", name: "No" })).rejects.toThrow("Personal projects");
    expect(harness.inspection.sdk.callsTo("projects.update")).toHaveLength(1);
  });

  it("only offers connected machines without a source and rejects duplicate paths", async () => {
    const project = standardProject();
    const host = { id: "host_1", name: "Desktop", status: "connected" as const, type: "persistent" as const,
      createdAt: 1, updatedAt: 1, lastSeenAt: 1, lastRejectedProtocolVersion: null, maxPermissionMode: "auto" as const };
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        hosts: { list: async () => [host, { ...host, id: "host_2", name: "Laptop" }, { ...host, id: "host_3", status: "disconnected" }] },
        projects: { get: async () => project, sources: { add: async () => ({ ...project.sources[0]!, hostId: "host_2" }) } },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("projectPathHosts", { projectId: "proj_1" })).resolves.toEqual({ hosts: [{ id: "host_2", name: "Laptop" }] });
    await expect(harness.behavior.callRpc("addProjectPath", { projectId: "proj_1", hostId: "host_1", path: "/work" })).rejects.toThrow("already has a path");
    expect(harness.inspection.sdk.callsTo("projects.sources.add")).toHaveLength(0);
    await harness.behavior.callRpc("addProjectPath", { projectId: "proj_1", hostId: "host_2", path: "/work" });
    expect(harness.inspection.sdk.callsTo("projects.sources.add")).toEqual([[{ projectId: "proj_1", hostId: "host_2", path: "/work", type: "local_path" }]]);
  });

  it("requires the project name before removing a standard project", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          delete: async () => ({ ok: true as const }),
          get: async () => project,
          list: async () => [project],
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("listProjects", {})).resolves.toEqual({
      projects: [{ id: "proj_1", name: "Sidebar" }],
    });
    await expect(
      harness.behavior.callRpc("removeProject", {
        projectId: "proj_1",
        confirmation: "sidebar",
      }),
    ).rejects.toThrow("Enter the project name exactly as shown");
    expect(harness.inspection.sdk.callsTo("projects.delete")).toEqual([]);

    await harness.behavior.callRpc("uploadProjectIcon", {
      projectId: "proj_1",
      filename: "brand.svg",
      mimeType: "image/svg+xml",
      contentBase64: "PHN2Zy8+",
    });
    await harness.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: "#123456" });
    await expect(
      harness.behavior.callRpc("removeProject", {
        projectId: "proj_1",
        confirmation: "Sidebar",
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("projects.delete")).toEqual([
      [{ projectId: "proj_1" }],
    ]);
    expect(await harness.behavior.callRpc("getProjectColors", {})).toEqual({ colors: {} });
    expect(harness.inspection.realtimeSignals.at(-1)).toEqual({ channel: "project-colors", payload: { projectId: "proj_1" } });
    await expect(
      harness.behavior.callRpc("listProjectIconSettings", {}),
    ).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: null,
          customUploadName: null,
        },
      ],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "project-icons",
      payload: { projectId: "proj_1" },
    });
  });
});

describe("automatic settle evaluation", () => {
  it.each((["autoSettleInactive", "autoSettleOnMerge"] as const).flatMap(setting =>
    (["settled", "parked", "snoozed"] as const).map(shelf => ({ setting, shelf })),
  ))(
    "preserves a manually $shelf parent after trying $setting on and off",
    async ({ setting, shelf }) => {
      const old = Date.now() - 4 * 86400000;
      const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
      const { bb, harness } = createFakePluginHost({
        pluginId: "bb-sidebar",
        sdk: {
          plugins: { getSettings: async () => ({ ok: true as const, schema: {}, values: {
            inactiveThreadsEnabled: false, autoSettleInactive: false, autoSettleOnMerge: false,
          } }) },
          projects: { list: async () => projectsWith([
            projectThread({ id: "parent", ...quiet }),
            projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
          ]) },
          threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
          environments: { pullRequest: async () => setting === "autoSettleOnMerge"
            ? availablePullRequest("merged") : { outcome: "absent" as const } },
        },
      });
      await plugin(bb);
      disposers.push(() => harness.lifecycle.dispose());
      // Existing manual shelves can have quiet children without lifecycle
      // rows, including settles made before settling applied to whole trees.
      bb.storage.database().prepare(`INSERT INTO thread_lifecycle
        (thread_id, settled_at, settled_override, parked_at, snoozed_until, snoozed_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        "parent", shelf === "settled" ? old + 1000 : null, shelf === "settled" ? "settled" : null,
        shelf === "parked" ? old + 1000 : null,
        shelf === "snoozed" ? Date.now() + 86400000 : null, shelf === "snoozed" ? old + 1000 : null,
      );
      const before = await harness.behavior.callRpc("listLifecycle", {});
      const settings = await harness.behavior.callRpc("getSidebarSettings", {}) as Record<string, unknown>;
      await harness.behavior.callRpc("updateSidebarSettings", { ...settings, [setting]: true });
      await harness.behavior.callRpc("evaluateAutoSettle", {});
      expect((await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult).rows)
        .toEqual(expect.arrayContaining([expect.objectContaining({ threadId: "child", settledAt: expect.any(Number), settledOverride: null })]));
      await harness.behavior.callRpc("updateSidebarSettings", settings);
      await harness.behavior.callRpc("evaluateAutoSettle", {});
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
      // Real child activity must still reopen the parent.
      await harness.behavior.emitThreadEvent("thread.active", {
        thread: makeThreadResponse({ id: "child", parentThreadId: "parent", status: "active" }),
      });
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    },
  );

  it("does not run settling when only appearance or layout settings change", async () => {
    const harness = await loadPlugin();
    const settings = await harness.behavior.callRpc("getSidebarSettings", {}) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", {
      ...settings, projectColorsEnabled: true, workingShelf: true,
    });
    expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it.each(["thread.created", "thread.active"] as const)(
    "rechecks descendants after %s during an automatic settle lookup",
    async (event) => {
      const old = Date.now() - 4 * 86400000;
      const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
      let threads = [projectThread({ id: "parent", environmentId: "env_parent", ...quiet })];
      if (event === "thread.active") threads.push(projectThread({ id: "child", parentThreadId: "parent", ...quiet }));
      const entered = deferred<void>();
      const release = deferred<void>();
      const { bb, harness } = createFakePluginHost({
        pluginId: "bb-sidebar",
        sdk: {
          projects: { list: async () => projectsWith(threads) },
          threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
          environments: { pullRequest: async () => {
            entered.resolve();
            await release.promise;
            return { outcome: "absent" as const };
          } },
        },
      });
      await plugin(bb);
      disposers.push(() => harness.lifecycle.dispose());
      const evaluation = harness.behavior.callRpc("evaluateAutoSettle", {});
      await entered.promise;
      threads = [threads[0]!, projectThread({
        id: "child", parentThreadId: "parent", updatedAt: Date.now(),
        status: event === "thread.active" ? "active" : "idle",
      })];
      await harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: "child", parentThreadId: "parent" }),
      });
      release.resolve();
      await expect(evaluation).resolves.toEqual({ changedThreadIds: [] });
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
      expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    },
  );

  it("reopens an already settled parent when its child's PR reopens", async () => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    let prOpen = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([
          projectThread({ id: "parent", ...quiet }),
          projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
        ]) },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
        environments: { pullRequest: async () => availablePullRequest(prOpen ? "open" : "merged") },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {}))
      .resolves.toEqual({ changedThreadIds: ["parent", "child"] });
    prOpen = true;
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {}))
      .resolves.toEqual({ changedThreadIds: ["child", "parent"] });
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("does not settle a parent while a child's PR is reopening", async () => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    let parentPinned = true;
    let prOpen = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([
          projectThread({ id: "parent", ...quiet, pinnedAt: parentPinned ? 1 : null }),
          projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
        ]) },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
        environments: { pullRequest: async () => availablePullRequest(prOpen ? "open" : "merged") },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: ["child"] });
    parentPinned = false;
    prOpen = true;
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: ["child"] });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("waits for active descendants before automatically settling their parent", async () => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    let child = projectThread({ id: "child", parentThreadId: "parent", projectId: "other", updatedAt: Date.now() });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: { projects: { list: async () => projectsWith([
        projectThread({ id: "parent", ...quiet }), child,
      ]) } },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    child = { ...child, ...quiet, hasPendingInteraction: true };
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    child = { ...child, hasPendingInteraction: false };
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: ["parent", "child"] });
    expect((await harness.behavior.callRpc("listLifecycle", {}) as LifecycleListResult).rows)
      .toEqual(expect.arrayContaining(["parent", "child"].map(threadId => expect.objectContaining({ threadId, settledAt: expect.any(Number) }))));
  });

  it("settles inactive threads and publishes one batched refresh", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
            projectThread({
              id: "thr_old",
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "idle",
            }),
            ]),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: ["thr_old"] });
    const result = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    expect(result.rows).toEqual([
      expect.objectContaining({
        threadId: "thr_old",
        settledAt: expect.any(Number),
        settledOverride: null,
      }),
    ]);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "lifecycle",
      payload: { threadIds: ["thr_old"] },
    });
  });

  it("never settles or stops idle threads that still have live work", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    const idleActivity = {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
              projectThread({ id: "thr_quiet", ...quiet }),
              projectThread({ id: "thr_asking", ...quiet, hasPendingInteraction: true }),
              projectThread({ id: "thr_queued", ...quiet, queuedWork: "waiting" }),
              projectThread({
                id: "thr_workflow",
                ...quiet,
                activity: { ...idleActivity, activeWorkflowCount: 1 },
              }),
              projectThread({
                id: "thr_command",
                ...quiet,
                activity: { ...idleActivity, activeBackgroundCommandCount: 1 },
              }),
              projectThread({ id: "thr_archived", ...quiet, archivedAt: old }),
              projectThread({ id: "thr_hidden", ...quiet, visibility: "hidden" }),
            ]),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: ["thr_quiet"] });
    expect(harness.inspection.sdk.callsTo("projects.list")).toEqual([
      [{ include: "threads", includePersonal: true }],
      [{ include: "threads", includePersonal: true }],
      [{ include: "threads", includePersonal: true }],
    ]);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_quiet" }],
    ]);
  });

  it("never settles a thread still serving a port, or one whose host cannot be scanned", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const inWorkspace = (id: string, environmentId: string, hostId = "host_1") => projectThread({
      id, createdAt: old, updatedAt: old, latestAttentionAt: old,
      environmentId, environmentPath: `/workspace/${environmentId}`, environmentHostId: hostId,
    });
    const scans: Array<{ hostId: string; input: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, hostId, input }) => {
        expect(method).toBe("scan");
        scans.push({ hostId, input });
        if (hostId === "host_offline") throw new Error("Host is not connected");
        return {
          ports: [
            { environmentId: "env_owned", port: 3000, pid: 11, source: "process", ownerThreadId: "thr_owned" },
            { environmentId: "env_solo", port: 4000, pid: 12, source: "process" },
            { environmentId: "env_shared", port: 5000, pid: 13, source: "process" },
            { environmentId: "env_docker", port: 6000, source: "docker" },
          ],
        };
      },
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
              inWorkspace("thr_owned", "env_owned"),
              inWorkspace("thr_solo", "env_solo"),
              inWorkspace("thr_shared_a", "env_shared"),
              inWorkspace("thr_shared_b", "env_shared"),
              inWorkspace("thr_docker", "env_docker"),
              inWorkspace("thr_offline", "env_offline", "host_offline"),
              projectThread({ id: "thr_gone", createdAt: old, updatedAt: old, latestAttentionAt: old, environmentId: "env_gone" }),
            ]),
        },
        environments: {
          pullRequest: async () => ({ outcome: "absent" as const }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({
      changedThreadIds: ["thr_shared_a", "thr_shared_b", "thr_docker", "thr_gone"],
    });
    expect(scans.map((scan) => scan.hostId).sort()).toEqual(["host_1", "host_offline"]);
    expect(
      (harness.inspection.sdk.callsTo("threads.stop") as Array<[{ threadId: string }]>)
        .map(([{ threadId }]) => threadId)
        .sort(),
    ).toEqual(["thr_docker", "thr_gone", "thr_shared_a", "thr_shared_b"]);
  });

  it("keeps manual un-settle active until real work clears the override", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const fields = {
      id: "thr_override",
      createdAt: old,
      updatedAt: old,
      latestAttentionAt: old,
      status: "idle" as const,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () => projectsWith([projectThread(fields)]),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await harness.behavior.callRpc("unsettle", {
      threadId: "thr_override",
    });
    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: [] });

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse(fields),
    });
    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
  });

  it("looks up a shared environment once and settles merged PR threads together", async () => {
    const old = Date.now() - 60_000;
    const environmentId = "env_shared";
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
            projectThread({
              id: "thr_a",
              environmentId,
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "idle",
            }),
            projectThread({
              id: "thr_b",
              environmentId,
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "idle",
            }),
            projectThread({
              id: "thr_running",
              environmentId: "env_running",
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "active",
            }),
            projectThread({
              id: "thr_pinned",
              environmentId: "env_pinned",
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              pinnedAt: Date.now(),
              status: "idle",
            }),
            ]),
        },
        environments: {
          pullRequest: async () => availablePullRequest("merged"),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: ["thr_a", "thr_b"] });
    expect(
      harness.inspection.sdk.callsTo("environments.pullRequest"),
    ).toHaveLength(1);
  });

  it("discards an outdated policy pass when settings change during evaluation", async () => {
    const old = Date.now() - 60_000;
    const environmentId = "env_queued";
    const thread = projectThread({
      id: "thr_queued",
      environmentId,
      createdAt: old,
      updatedAt: old,
      latestAttentionAt: old,
      status: "idle",
    });
    let pullRequestCalls = 0;
    let resolveFirstPullRequest!: (value: ReturnType<typeof availablePullRequest>) => void;
    const firstPullRequest = new Promise<ReturnType<typeof availablePullRequest>>(
      (resolve) => {
        resolveFirstPullRequest = resolve;
      },
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([thread]) },
        environments: {
          pullRequest: async () => {
            pullRequestCalls += 1;
            return pullRequestCalls === 1
              ? firstPullRequest
              : availablePullRequest("merged");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const firstEvaluation = harness.behavior.callRpc("evaluateAutoSettle", {});
    for (let attempt = 0; attempt < 10 && pullRequestCalls < 1; attempt += 1) {
      await Promise.resolve();
    }
    expect(pullRequestCalls).toBe(1);

    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "30m, 2h, 1d, 1w",
        inactiveThreadsEnabled: true,
        inactiveAfterHours: 6,
        showRunningChildrenWhenCollapsed: true,
        autoSettleInactive: false,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: false,
        childSortField: "created",
        childSortDirection: "ascending",
        childIconStyle: "disc",
      }),
    ).resolves.toMatchObject({ autoSettleInactive: false });

    resolveFirstPullRequest(availablePullRequest("merged"));
    await expect(firstEvaluation).resolves.toEqual({
      changedThreadIds: [],
    });
    for (let attempt = 0; attempt < 10 && pullRequestCalls < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(pullRequestCalls).toBe(2);
    let lifecycle = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    for (let attempt = 0; attempt < 10 && lifecycle.rows.length > 0; attempt += 1) {
      await Promise.resolve();
      lifecycle = (await harness.behavior.callRpc(
        "listLifecycle",
        {},
      )) as LifecycleListResult;
    }
    expect(lifecycle).toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("returns a policy-settled thread when its PR reopens", async () => {
    const recent = Date.now() - 60_000;
    let pullRequestState: "merged" | "open" = "merged";
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
            projectThread({
              id: "thr_pr",
              environmentId: "env_pr",
              createdAt: recent,
              updatedAt: recent,
              latestAttentionAt: recent,
              status: "idle",
            }),
            ]),
        },
        environments: {
          pullRequest: async () => availablePullRequest(pullRequestState),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: ["thr_pr"] });
    pullRequestState = "open";
    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: ["thr_pr"] });
    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
  });

  it("clears policy-owned settled state when the user pins the thread", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    let pinnedAt: number | null = null;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
            projectThread({
              id: "thr_pin",
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              pinnedAt,
              status: "idle",
            }),
            ]),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await harness.behavior.callRpc("evaluateAutoSettle", {});
    pinnedAt = Date.now();
    await expect(
      harness.behavior.callRpc("evaluateAutoSettle", {}),
    ).resolves.toEqual({ changedThreadIds: ["thr_pin"] });
    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
  });
});


describe("parked lifecycle", () => {
  it("stores parking, replaces snooze, and resumes with cleanup protection", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("snooze", { threadId: "thr_1", snoozedUntil: Date.now() + 60000 });
    await harness.behavior.callRpc("park", { threadId: "thr_1" });
    expect(await harness.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ parkedAt: expect.any(Number), snoozedUntil: null, settledAt: null }] });
    await harness.behavior.callRpc("resume", { threadId: "thr_1" });
    expect(await harness.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ parkedAt: null, settledOverride: "active" }] });
  });
  it.each(["snooze", "settle"])("clears parking when moved to %s", async (method) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thr_1" });
    await harness.behavior.callRpc(method, { threadId: "thr_1", ...(method === "snooze" ? { snoozedUntil: Date.now() + 60000 } : {}) });
    expect(await harness.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ parkedAt: null }] });
  });
  it("clears parking permanently when work starts", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thr_1" });
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1" }) });
    expect(await harness.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
  });
});


describe("parent thread RPC", () => {
  it("uses BB's thread update for assigning and removing a parent", async () => {
    const harness = await loadPlugin();
    let state = makeThreadResponse({ id: "thr_1" });
    harness.inspection.sdk.stub("threads.get", async () => state);
    harness.inspection.sdk.stub("threads.update", async ({ parentThreadId }) => {
      state = { ...state, parentThreadId: parentThreadId ?? null };
      return state;
    });
    for (const parentThreadId of ["thr_parent", null]) {
      await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thr_1", parentThreadId })).resolves.toEqual({ ok: true });
    }
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([
      [{ threadId: "thr_1", parentThreadId: "thr_parent" }],
      [{ threadId: "thr_1", parentThreadId: null }],
    ]);
  });
  it("propagates BB's validation failures", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("Invalid parent relationship"); });
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thr_1", parentThreadId: "thr_parent" })).rejects.toThrow("Invalid parent relationship");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("pin/parent policy", () => {
  it.each([null, 0, 1])("rejects child Pin with pinnedAt=%s without changing lifecycle", async (pinnedAt) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "child" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "child", parentThreadId: "missing-parent", pinnedAt }));
    await expect(harness.behavior.callRpc("pin", { threadId: "child" })).rejects.toThrow("Child threads cannot be pinned");
    expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(0);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "child" }));
    await expect(harness.behavior.callRpc("pin", { threadId: "child" })).resolves.toEqual({ ok: true });
  });

  it("allows root and fork-root Pin and clears lifecycle after SDK success", async () => {
    const harness = await loadPlugin();
    for (const originKind of [null, "fork"] as const) {
      await harness.behavior.callRpc("park", { threadId: "root" });
      harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "root", originKind, sourceThreadId: originKind ? "source" : null }));
      await expect(harness.behavior.callRpc("pin", { threadId: "root" })).resolves.toEqual({ ok: true });
      expect(await harness.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ threadId: "root", parkedAt: null, settledOverride: "active" }] });
    }
    expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(2);
  });

  it("accepts Pin for an existing pinned root with pinnedAt=0", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "root", pinnedAt: 0 }));
    await expect(harness.behavior.callRpc("pin", { threadId: "root" })).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.pin")).toEqual([[{ threadId: "root" }]]);
  });

  it.each([null, "old"])("updates parent before unpinning a pinned thread with current parent=%s (pin zero)", async (currentParent) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thread" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    const calls: string[] = [];
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread", parentThreadId: currentParent, pinnedAt: 0 }));
    harness.inspection.sdk.stub("threads.update", async () => { calls.push("update"); return makeThreadResponse({ id: "thread", parentThreadId: "next", pinnedAt: 0 }); });
    harness.inspection.sdk.stub("threads.unpin", async () => { calls.push("unpin"); return makeThreadResponse({ id: "thread", parentThreadId: "next" }); });
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["update", "unpin"]);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each([
    { currentParent: null, pinnedAt: null, nextParent: "parent" },
    { currentParent: null, pinnedAt: 0, nextParent: null },
    { currentParent: "old", pinnedAt: 0, nextParent: "next" },
    { currentParent: "old", pinnedAt: 0, nextParent: "old" },
    { currentParent: "old", pinnedAt: 0, nextParent: null },
  ])("allows parent correction/clear: $currentParent/$pinnedAt → $nextParent", async ({ currentParent, pinnedAt, nextParent }) => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thread", parentThreadId: currentParent, pinnedAt }));
    harness.inspection.sdk.stub("threads.update", async () => makeThreadResponse({ id: "thread", parentThreadId: nextParent, pinnedAt }));
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: nextParent })).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual(currentParent === nextParent ? [] : [[{ threadId: "thread", parentThreadId: nextParent }]]);
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(nextParent != null && currentParent !== nextParent && pinnedAt != null ? 1 : 0);
  });

  it("requires explicit parentThreadId, never treating omission as clear", async () => {
    const harness = await loadPlugin();
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thread" })).rejects.toThrow();
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it.each(["get", "pin", "update"])("preserves lifecycle and releases the gate after %s failure", async (stage) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thread" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    let failing = true;
    harness.inspection.sdk.stub("threads.get", async () => {
      if (stage === "get" && failing) throw new Error("GET failed");
      return makeThreadResponse({ id: "thread" });
    });
    harness.inspection.sdk.stub("threads.pin", async () => {
      if (stage === "pin" && failing) throw new Error("pin failed");
      return makeThreadResponse({ id: "thread", pinnedAt: 1 });
    });
    harness.inspection.sdk.stub("threads.update", async () => {
      if (stage === "update" && failing) throw new Error("Invalid parent relationship");
      return makeThreadResponse({ id: "thread", parentThreadId: "parent" });
    });
    const run = () => stage === "update"
      ? harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "parent" })
      : harness.behavior.callRpc("pin", { threadId: "thread" });
    await expect(run()).rejects.toThrow(stage === "get" ? "GET failed" : stage === "pin" ? "pin failed" : "Invalid parent relationship");
    if (stage === "get") {
      expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(0);
      expect(harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
    }
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    failing = false;
    await expect(run()).resolves.toEqual({ ok: true });
  });

  it.each(["pin", "setThreadParent"])("holds one gate during %s and rechecks the changed state", async (firstMethod) => {
    const harness = await loadPlugin();
    const entered = deferred<void>(), release = deferred<void>();
    let state = makeThreadResponse({ id: "thread" });
    harness.inspection.sdk.stub("threads.get", async () => ({ ...state }));
    harness.inspection.sdk.stub("threads.pin", async () => {
      entered.resolve(); await release.promise;
      state = { ...state, pinnedAt: 0 };
      return state;
    });
    harness.inspection.sdk.stub("threads.update", async ({ parentThreadId }) => {
      entered.resolve(); await release.promise;
      state = { ...state, parentThreadId: parentThreadId ?? null };
      return state;
    });
    harness.inspection.sdk.stub("threads.unpin", async () => { state = { ...state, pinnedAt: null }; return state; });
    const pin = () => harness.behavior.callRpc("pin", { threadId: "thread" });
    const parent = () => harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "parent" });
    const first = firstMethod === "pin" ? pin() : parent();
    await entered.promise;
    const opposite = firstMethod === "pin" ? parent : pin;
    for (let i = 0; i < 2; i += 1) await expect(opposite()).rejects.toThrow("Thread update already in progress. Try again.");
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    release.resolve();
    await expect(first).resolves.toEqual({ ok: true });
    if (firstMethod === "pin") {
      await expect(opposite()).resolves.toEqual({ ok: true });
      expect(state.parentThreadId).toBe("parent");
      expect(state.pinnedAt).toBeNull();
      expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(1);
    } else {
      await expect(opposite()).rejects.toThrow("Child threads cannot be pinned");
      expect(harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(0);
    }
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
  });

  it("acquires before GET awaits and keeps different thread IDs independent", async () => {
    const harness = await loadPlugin();
    const entered = deferred<void>(), release = deferred<void>();
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === "a") { entered.resolve(); await release.promise; }
      return makeThreadResponse({ id: threadId });
    });
    harness.inspection.sdk.stub("threads.update", async ({ threadId }) => makeThreadResponse({ id: threadId, parentThreadId: "parent" }));
    const first = harness.behavior.callRpc("pin", { threadId: "a" });
    await entered.promise;
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "a", parentThreadId: "parent" })).rejects.toThrow("Thread update already in progress");
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "b", parentThreadId: "parent" })).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.get")).toEqual([[{ threadId: "a" }], [{ threadId: "b" }]]);
    release.resolve();
    await expect(first).resolves.toEqual({ ok: true });
  });
});


describe("parent auto-unpin partial result", () => {
  it.each(["get", "update"])("keeps pin/lifecycle and never unpins on %s failure", async (stage) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thread" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    const unpinsBefore = harness.inspection.sdk.callsTo("threads.unpin").length;
    const state = makeThreadResponse({ id: "thread", pinnedAt: 0 });
    harness.inspection.sdk.stub("threads.get", async () => { if (stage === "get") throw new Error("GET failed"); return state; });
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("Invalid parent relationship"); });
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" })).rejects.toThrow(stage === "get" ? "GET failed" : "Invalid parent relationship");
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(unpinsBefore);
    expect(state.pinnedAt).toBe(0);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each([false, true])("holds the gate through deferred unpin, failed=%s, and never retries same-parent", async (fails) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("park", { threadId: "thread" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    let state = makeThreadResponse({ id: "thread", pinnedAt: 0 });
    const entered = deferred<void>(), release = deferred<void>();
    const calls: string[] = [];
    harness.inspection.sdk.stub("threads.get", async () => ({ ...state }));
    harness.inspection.sdk.stub("threads.update", async ({ parentThreadId }) => { calls.push("update"); state = { ...state, parentThreadId: parentThreadId ?? null }; return state; });
    harness.inspection.sdk.stub("threads.unpin", async () => {
      calls.push("unpin"); entered.resolve(); await release.promise;
      if (fails) throw new Error("Lost unpin response");
      state = { ...state, pinnedAt: null }; return state;
    });
    const first = harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" });
    await entered.promise;
    expect(state.parentThreadId).toBe("next");
    expect(state.pinnedAt).toBe(0);
    for (const method of ["pin", "setThreadParent"]) {
      await expect(harness.behavior.callRpc(method, { threadId: "thread", ...(method === "setThreadParent" ? { parentThreadId: "next" } : {}) })).rejects.toThrow("Thread update already in progress");
    }
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    release.resolve();
    await expect(first).resolves.toEqual(fails ? { ok: true, unpinFailed: true } : { ok: true });
    expect(calls).toEqual(["update", "unpin"]);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    if (fails) {
      expect(harness.inspection.logEntries).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringContaining("thread thread, parent next: Lost unpin response") }));
      expect(state.pinnedAt).toBe(0);
    } else expect(state.pinnedAt).toBeNull();
    await expect(harness.behavior.callRpc("setThreadParent", { threadId: "thread", parentThreadId: "next" })).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(calls).toEqual(["update", "unpin"]); // no rollback or repeat unpin
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });
});

describe("release lifecycle safety", () => {
  async function host(threads: ProjectThread[]) {
    const harness = await loadPlugin();
    // Match the real host: projects hide helpers; the paged thread list does not.
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads.filter(t => t.visibility === "visible")));
    harness.inspection.sdk.stub("threads.list", async (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => { const { offset = 0, limit = 100 } = args ?? {}; return threads.slice(offset, offset + limit); });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse(threads.find(t => t.id === threadId)!));
    harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      const thread = threads.find(t => t.id === threadId)!;
      thread.pinnedAt = null;
      return makeThreadResponse(thread);
    });
    harness.inspection.sdk.stub("threads.pin", async ({ threadId }) => {
      const thread = threads.find(t => t.id === threadId)!;
      thread.pinnedAt = Date.now();
      return makeThreadResponse(thread);
    });
    harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
    return harness;
  }

  it.each(["activity", "return", "pin", "reparent"])("cancels queued reclaim after newer %s", async (change) => {
    const threads = [projectThread({ id: "root" }), ...Array.from({ length: 5 }, (_, i) => projectThread({ id: `child${i}`, parentThreadId: "root" }))];
    const h = await host(threads);
    const gate = deferred<void>();
    const started = deferred<void>();
    const stopped: string[] = [];
    h.inspection.sdk.stub("threads.stop", async ({ threadId }) => {
      stopped.push(threadId);
      if (stopped.length === 4) started.resolve();
      await gate.promise;
      return { ok: true };
    });
    const settling = h.behavior.callRpc("settle", { threadId: "root" });
    await started.promise;
    const late = threads.at(-1)!;
    if (change === "activity") {
      late.status = "active";
      await h.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse(late) });
    } else if (change === "return") {
      await h.behavior.callRpc("unsettle", { threadId: late.id });
    } else if (change === "pin") {
      late.pinnedAt = Date.now();
    } else late.parentThreadId = null;
    gate.resolve();
    await settling;
    expect(stopped).not.toContain(late.id);
  });

  it("rechecks activity after terminal lookup before closing anything", async () => {
    const threads = [projectThread({ id: "root" })];
    const h = await host(threads);
    const gate = deferred<void>();
    const started = deferred<void>();
    h.inspection.sdk.stub("terminals.list", async () => {
      started.resolve();
      await gate.promise;
      return { sessions: [{ ...terminalSession({ id: "terminal" }), threadId: "root" }] };
    });
    h.inspection.sdk.stub("terminals.close", async () => ({ ok: true }));
    const settling = h.behavior.callRpc("settle", { threadId: "root" });
    await started.promise;
    threads[0]!.status = "active";
    await h.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse(threads[0]!) });
    gate.resolve();
    await settling;
    expect(h.inspection.sdk.callsTo("terminals.close")).toEqual([]);
  });

  it("automatically settles finished descendants after a returned parent runs again", async () => {
    const old = Date.now() - 8 * 86400000;
    const threads = [projectThread({ id: "root", createdAt: old, latestAttentionAt: old, updatedAt: old }), projectThread({ id: "child", parentThreadId: "root", createdAt: old, latestAttentionAt: old, updatedAt: old })];
    const h = await host(threads);
    await h.behavior.callRpc("settle", { threadId: "root" });
    await h.behavior.callRpc("unsettle", { threadId: "root" });
    expect(await h.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ threadId: "root", settledOverride: "active" }] });
    await h.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ ...threads[0]!, status: "active" }) });
    expect(await h.behavior.callRpc("evaluateAutoSettle", {})).toEqual({ changedThreadIds: ["root", "child"] });
  });

  it.each(["unpin fails", "child starts"])("restores native pins when Settle fails: %s", async (reason) => {
    const threads = [projectThread({ id: "root", pinnedAt: 1, pinSortKey: "B" }), projectThread({ id: "child", parentThreadId: "root", pinnedAt: 2 }), projectThread({ id: "other", pinnedAt: 1, pinSortKey: "A" })];
    const h = await host(threads);
    h.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      if (threadId === "child" && reason === "unpin fails") throw new Error("unpin failed");
      threads.find(t => t.id === threadId)!.pinnedAt = null;
      if (reason === "child starts") threads[1]!.status = "active";
      return makeThreadResponse({ id: threadId });
    });
    await expect(h.behavior.callRpc("settle", { threadId: "root" })).rejects.toThrow();
    expect(threads[0]!.pinnedAt).not.toBeNull();
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
    expect(h.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    expect(h.inspection.sdk.callsTo("threads.reorderPinned")).toContainEqual([{ threadId: "root", previousThreadId: "other", nextThreadId: null }]);
  });

  it.each(["pin", "setThreadParent"])("serializes %s against a Settle waiting on native unpin", async (method) => {
    const threads = [projectThread({ id: "root", pinnedAt: 1 })];
    const h = await host(threads);
    const gate = deferred<void>();
    const entered = deferred<void>();
    h.inspection.sdk.stub("threads.unpin", async () => {
      entered.resolve();
      await gate.promise;
      threads[0]!.pinnedAt = null;
      return makeThreadResponse(threads[0]!);
    });
    const settling = h.behavior.callRpc("settle", { threadId: "root" });
    await entered.promise;
    await expect(h.behavior.callRpc(method, {
      threadId: "root", ...(method === "setThreadParent" ? { parentThreadId: "other" } : {}),
    })).rejects.toThrow("already in progress");
    gate.resolve();
    await settling;
    expect(threads[0]!.pinnedAt).toBeNull();
    expect(await h.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ threadId: "root", settledOverride: "settled" }] });
  });

  it("loads hidden nodes beyond the first page and refuses busy subtrees", async () => {
    const threads = [projectThread({ id: "root" }), ...Array.from({ length: 100 }, (_, i) => projectThread({ id: `other${i}` })), projectThread({ id: "hidden", parentThreadId: "root", visibility: "hidden", queuedWork: "failed" }), projectThread({ id: "grandchild", parentThreadId: "hidden", status: "active" })];
    const h = await host(threads);
    await expect(h.behavior.callRpc("settle", { threadId: "root" })).rejects.toThrow("Cannot settle");
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
    expect(h.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    threads[101]!.queuedWork = "none";
    await expect(h.behavior.callRpc("settle", { threadId: "root" })).rejects.toThrow("Cannot settle");
    threads[102]!.status = "idle";
    await h.behavior.callRpc("settle", { threadId: "root" });
    const result = await h.behavior.callRpc("listLifecycle", {}) as LifecycleListResult;
    expect(result.rows.map(r => r.threadId).sort()).toEqual(["grandchild", "hidden", "root"]);
  });

  it.each([false, true])("rechecks queued automatic cleanup under changed rules, still eligible=%s", async (eligible) => {
    const old = Date.now() - 8 * 86400000;
    const threads = Array.from({ length: 6 }, (_, i) => projectThread({ id: `root${i}`, createdAt: old, updatedAt: old, latestAttentionAt: old }));
    const h = await host(threads);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const stopped: string[] = [];
    h.inspection.sdk.stub("threads.stop", async ({ threadId }) => {
      stopped.push(threadId);
      if (stopped.length === 4) entered.resolve();
      await gate.promise;
      return { ok: true };
    });
    const settling = h.behavior.callRpc("evaluateAutoSettle", {});
    await entered.promise;
    await h.behavior.callRpc("updateSidebarSettings", eligible
      ? { autoSettleAfterDays: 4 }
      : { autoSettleInactive: false, autoSettleOnMerge: false });
    gate.resolve();
    await settling;
    expect(stopped.includes("root5")).toBe(eligible);
    if (!eligible) await vi.waitFor(async () => expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] }));
  });

  it("does not resurrect an archived child from an older project response", async () => {
    const root = projectThread({ id: "root" });
    const staleChild = projectThread({ id: "archived", parentThreadId: "root" });
    const h = await host([root]);
    h.inspection.sdk.stub("projects.list", async () => projectsWith([root, staleChild]));
    await h.behavior.callRpc("settle", { threadId: "root" });
    expect(await h.behavior.callRpc("listLifecycle", {})).toMatchObject({ rows: [{ threadId: "root" }] });
    expect(h.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "root" }]]);
  });

  it("preserves unrelated settings across partial writes and rejects removed keys", async () => {
    const h = await host([]);
    await h.behavior.callRpc("updateSidebarSettings", { workingShelf: true });
    expect(await h.behavior.callRpc("updateSidebarSettings", { childSortDirection: "descending" })).toMatchObject({ workingShelf: true, childSortDirection: "descending" });
    await expect(h.behavior.callRpc("updateSidebarSettings", { archivedShelfEnabled: true })).rejects.toThrow("validation");
  });
});
