import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  projectThread,
  projectsWith,
  availablePullRequest,
  pullRequestStatus,
  loadPlugin,
  deferred,
  type LifecycleListResult,
} from "./test-server";

describe("automatic settle evaluation", () => {
  it.each(
    (["autoSettleInactive", "autoSettleOnMerge"] as const).flatMap((setting) =>
      (["settled", "parked", "snoozed"] as const).map((shelf) => ({ setting, shelf })),
    ),
  )("preserves a manually $shelf parent after trying $setting on and off", async ({ setting, shelf }) => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        plugins: {
          callRpc: pullRequestStatus(() =>
            setting === "autoSettleOnMerge" ? availablePullRequest("merged") : { outcome: "absent" },
          ),
          getSettings: async () => ({
            ok: true as const,
            schema: {},
            values: {
              inactiveThreadsEnabled: false,
              autoSettleInactive: false,
              autoSettleOnMerge: false,
            },
          }),
        },
        projects: {
          list: async () =>
            projectsWith([
              projectThread({ id: "parent", ...quiet }),
              projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
            ]),
        },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    // Existing manual shelves can have quiet children without lifecycle
    // rows, including settles made before settling applied to whole trees.
    bb.storage
      .database()
      .prepare(
        `INSERT INTO thread_lifecycle
        (thread_id, settled_at, settled_override, parked_at, snoozed_until, snoozed_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "parent",
        shelf === "settled" ? old + 1000 : null,
        shelf === "settled" ? "settled" : null,
        shelf === "parked" ? old + 1000 : null,
        shelf === "snoozed" ? Date.now() + 86400000 : null,
        shelf === "snoozed" ? old + 1000 : null,
      );
    const before = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    // The first pass gives a quiet child of an older parent-only settle the
    // parent's manual row. Parked and snoozed parents leave children alone.
    const inherited = {
      threadId: "child",
      parkedAt: null,
      settledAt: old + 1000,
      settledOverride: "settled",
      snoozedUntil: null,
      snoozedAt: null,
    };
    const after = shelf === "settled" ? { rows: [...before.rows, inherited] } : before;
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, [setting]: true });
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    expect(((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows).toEqual(
      expect.arrayContaining([
        shelf === "settled"
          ? inherited
          : expect.objectContaining({ threadId: "child", settledAt: expect.any(Number), settledOverride: null }),
      ]),
    );
    await harness.behavior.callRpc("updateSidebarSettings", settings);
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(after);
    // Real child activity must still reopen the parent.
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "child", parentThreadId: "parent", status: "active" }),
    });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("does not run settling when only appearance or layout settings change", async () => {
    const harness = await loadPlugin();
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", {
      ...settings,
      projectColorsEnabled: true,
      workingShelf: true,
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
          plugins: {
            callRpc: pullRequestStatus(async () => {
              entered.resolve();
              await release.promise;
              return { outcome: "absent" };
            }),
          },
        },
      });
      await plugin(bb);
      disposers.push(() => harness.lifecycle.dispose());
      const evaluation = harness.behavior.callRpc("evaluateAutoSettle", {});
      await entered.promise;
      threads = [
        threads[0]!,
        projectThread({
          id: "child",
          parentThreadId: "parent",
          updatedAt: Date.now(),
          status: event === "thread.active" ? "active" : "idle",
        }),
      ];
      await harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: "child", parentThreadId: "parent" }),
      });
      release.resolve();
      await expect(evaluation).resolves.toEqual({ changedThreadIds: [] });
      await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
      expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    },
  );

  it("reopens an already settled parent when its child's PR reopens, on the first pass after a restart", async () => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    let prOpen = false;
    const batches: string[][] = [];
    const threads = [
      projectThread({ id: "parent", ...quiet }),
      projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
    ];
    // A reload keeps only these options, so the thread listing is passed here.
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith(threads) },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }), list: async () => threads },
        plugins: { callRpc: pullRequestStatus(() => availablePullRequest(prOpen ? "open" : "merged"), batches) },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["parent", "child"],
    });
    prOpen = true;
    // A settled tree is done: an ordinary pass does not look its PR up again.
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    expect(batches).toEqual([["env_child"]]);
    const reloaded = (await harness.lifecycle.reload(plugin)).harness;
    disposers.push(() => reloaded.lifecycle.dispose());
    await expect(reloaded.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["child", "parent"],
    });
    await expect(reloaded.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    await expect(reloaded.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("does not settle a parent while a child's PR is reopening after a settings change", async () => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    let parentPinned = true;
    let prOpen = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
              projectThread({ id: "parent", ...quiet, pinnedAt: parentPinned ? 1 : null }),
              projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
            ]),
        },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
        plugins: {
          callRpc: pullRequestStatus(async () => {
            await held?.promise;
            return availablePullRequest(prOpen ? "open" : "merged");
          }),
        },
      },
    });
    let held: ReturnType<typeof deferred<void>> | null = null;
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: ["child"] });
    parentPinned = false;
    prOpen = true;
    // The settings change starts a full pass; holding its lookup makes this
    // call join it.
    held = deferred<void>();
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, autoSettleAfterDays: 2 });
    const full = harness.behavior.callRpc("evaluateAutoSettle", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    held.resolve();
    await expect(full).resolves.toEqual({ changedThreadIds: ["child"] });
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("waits for active descendants before automatically settling their parent", async () => {
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    let child = projectThread({ id: "child", parentThreadId: "parent", projectId: "other", updatedAt: Date.now() });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: { projects: { list: async () => projectsWith([projectThread({ id: "parent", ...quiet }), child]) } },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    child = { ...child, ...quiet, hasPendingInteraction: true };
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    child = { ...child, hasPendingInteraction: false };
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["parent", "child"],
    });
    expect(((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows).toEqual(
      expect.arrayContaining(
        ["parent", "child"].map((threadId) => expect.objectContaining({ threadId, settledAt: expect.any(Number) })),
      ),
    );
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

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["thr_old"],
    });
    const result = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
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

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["thr_quiet"],
    });
    expect(harness.inspection.sdk.callsTo("projects.list")).toEqual([
      [{ include: "threads", includePersonal: true }],
      [{ include: "threads", includePersonal: true }],
      [{ include: "threads", includePersonal: true }],
    ]);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_quiet" }]]);
  });

  it("never settles a thread still serving a port, or one whose host cannot be scanned", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const inWorkspace = (id: string, environmentId: string, hostId = "host_1") =>
      projectThread({
        id,
        createdAt: old,
        updatedAt: old,
        latestAttentionAt: old,
        environmentId,
        environmentPath: `/workspace/${environmentId}`,
        environmentHostId: hostId,
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
              projectThread({
                id: "thr_gone",
                createdAt: old,
                updatedAt: old,
                latestAttentionAt: old,
                environmentId: "env_gone",
              }),
            ]),
        },
        plugins: { callRpc: pullRequestStatus(() => ({ outcome: "absent" })) },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
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
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse(fields),
    });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("looks up a shared environment once and settles merged PR threads together", async () => {
    const old = Date.now() - 60_000;
    const environmentId = "env_shared";
    const batches: string[][] = [];
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
        plugins: {
          callRpc: pullRequestStatus(() => availablePullRequest("merged"), batches),
          getSettings: async () => ({ ok: true as const, schema: {}, values: { autoSettleOnMerge: true } }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["thr_a", "thr_b"],
    });
    expect(batches).toEqual([[environmentId]]);
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
    const firstPullRequest = new Promise<ReturnType<typeof availablePullRequest>>((resolve) => {
      resolveFirstPullRequest = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([thread]) },
        plugins: {
          callRpc: pullRequestStatus(() => {
            pullRequestCalls += 1;
            return pullRequestCalls === 1 ? firstPullRequest : availablePullRequest("merged");
          }),
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
    // The queued pass runs with both rules off, so it never asks GitHub.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.resolve();
    }
    expect(pullRequestCalls).toBe(1);
    let lifecycle = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    for (let attempt = 0; attempt < 10 && lifecycle.rows.length > 0; attempt += 1) {
      await Promise.resolve();
      lifecycle = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    }
    expect(lifecycle).toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("asks GitHub nothing when both settle rules are off", async () => {
    const batches: string[][] = [];
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
              projectThread({
                id: "thr_closed",
                environmentId: "env_closed",
                createdAt: old,
                updatedAt: old,
                latestAttentionAt: old,
                status: "idle",
              }),
            ]),
        },
        plugins: {
          callRpc: pullRequestStatus(() => availablePullRequest("closed"), batches),
          getSettings: async () => ({
            ok: true as const,
            schema: {},
            values: { autoSettleInactive: false, autoSettleOnMerge: false },
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    expect(batches).toEqual([]);
  });

  it("returns a policy-settled thread whose PR reopened only once a rule changes", async () => {
    const recent = Date.now() - 60_000;
    let pullRequestState: "merged" | "open" = "merged";
    const batches: string[][] = [];
    let held: ReturnType<typeof deferred<void>> | null = null;
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
        plugins: {
          callRpc: pullRequestStatus(async () => {
            await held?.promise;
            return availablePullRequest(pullRequestState);
          }, batches),
          getSettings: async () => ({ ok: true as const, schema: {}, values: { autoSettleOnMerge: true } }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: ["thr_pr"] });
    pullRequestState = "open";
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
    expect(batches).toEqual([["env_pr"]]);
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    // Holding the settings change's lookup makes this call join that pass.
    held = deferred<void>();
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, autoSettleAfterDays: 4 });
    const full = harness.behavior.callRpc("evaluateAutoSettle", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    held.resolve();
    await expect(full).resolves.toEqual({ changedThreadIds: ["thr_pr"] });
    expect(batches[1]).toEqual(["env_pr"]);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
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
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["thr_pin"],
    });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });
});
