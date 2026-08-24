import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { type StoredLifecycleRow } from "./server";

interface LifecycleListResult {
  rows: StoredLifecycleRow[];
}

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
      threads: {
        list: async () => [],
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
  it("registers the configurable snooze preset setting", async () => {
    const harness = await loadPlugin();
    expect(
      harness.inspection.registrations.settingsDescriptors.snoozePresets,
    ).toMatchObject({
      type: "string",
      default: "30m, 2h, 1d, 1w",
    });
    await expect(
      harness.behavior.setSettings({ snoozePresets: "10m, 4h" }),
    ).resolves.toBeUndefined();
    expect(
      harness.inspection.registrations.settingsDescriptors,
    ).toMatchObject({
      autoSettleInactive: { type: "boolean", default: true },
      autoSettleAfterDays: { type: "string", default: "3" },
      autoSettleOnMerge: { type: "boolean", default: true },
    });
    expect(harness.inspection.registrations.schedules).toContainEqual(
      expect.objectContaining({ name: "auto-settle", cron: "*/5 * * * *" }),
    );
  });

  it("settles and restores a thread", async () => {
    const harness = await loadPlugin();

    await harness.behavior.callRpc("settle", { threadId: "thr_1" });
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toEqual([
      [{ threadId: "thr_1" }],
    ]);
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

  it("bulk settles successful rows and reports unpin failures", async () => {
    const harness = await loadPlugin(async ({ threadId }) => {
      if (threadId === "blocked") throw new Error("cannot unpin");
      return makeThreadResponse({ id: threadId });
    });

    await expect(
      harness.behavior.callRpc("bulkSettle", {
        threadIds: ["first", "blocked", "third"],
      }),
    ).resolves.toEqual({
      succeededThreadIds: ["first", "third"],
      failures: [{ threadId: "blocked", error: "cannot unpin" }],
    });
    const lifecycle = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    expect(lifecycle.rows.map((row) => row.threadId).sort()).toEqual([
      "first",
      "third",
    ]);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "lifecycle",
      payload: { threadIds: ["first", "third"] },
    });
  });

  it("bulk snoozes rows with one lifecycle invalidation", async () => {
    const harness = await loadPlugin();
    const snoozedUntil = Date.now() + 60_000;

    await expect(
      harness.behavior.callRpc("bulkSnooze", {
        threadIds: ["first", "second"],
        snoozedUntil,
      }),
    ).resolves.toEqual({
      succeededThreadIds: ["first", "second"],
      failures: [],
    });
    const lifecycle = (await harness.behavior.callRpc(
      "listLifecycle",
      {},
    )) as LifecycleListResult;
    expect(lifecycle.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: "first", snoozedUntil }),
        expect.objectContaining({ threadId: "second", snoozedUntil }),
      ]),
    );
    expect(
      harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "lifecycle",
      ),
    ).toEqual([
      {
        channel: "lifecycle",
        payload: { threadIds: ["first", "second"] },
      },
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

  it("does not settle when native unpinning fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
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
      harness.behavior.callRpc("settle", { threadId: "thr_1" }),
    ).rejects.toThrow("pin update failed");
    await expect(
      harness.behavior.callRpc("listLifecycle", {}),
    ).resolves.toEqual({ rows: [] });
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
        { id: "proj_1", name: "Sidebar", customPath: null },
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
    ).resolves.toEqual({ customPath: "public/brand.svg" });
    await expect(
      harness.behavior.callRpc("listProjectIconSettings", {}),
    ).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: "public/brand.svg",
        },
      ],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "project-icons",
      payload: { projectId: "proj_1" },
    });
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
          path: "t3.json",
        },
      ],
      [
        {
          projectId: "proj_1",
          hostId: "host_1",
          path: "favicon.svg",
        },
      ],
    ]);
  });
});

describe("automatic settle evaluation", () => {
  it("settles inactive threads and publishes one batched refresh", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        threads: {
          list: async () => [
            makeThreadResponse({
              id: "thr_old",
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "idle",
            }),
          ],
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

  it("keeps manual un-settle active until real work clears the override", async () => {
    const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const thread = makeThreadResponse({
      id: "thr_override",
      createdAt: old,
      updatedAt: old,
      latestAttentionAt: old,
      status: "idle",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        threads: {
          list: async () => [thread],
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

    await harness.behavior.emitThreadEvent("thread.active", { thread });
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
        threads: {
          list: async () => [
            makeThreadResponse({
              id: "thr_a",
              environmentId,
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "idle",
            }),
            makeThreadResponse({
              id: "thr_b",
              environmentId,
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              status: "idle",
            }),
          ],
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

  it("returns a policy-settled thread when its PR reopens", async () => {
    const recent = Date.now() - 60_000;
    let pullRequestState: "merged" | "open" = "merged";
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        threads: {
          list: async () => [
            makeThreadResponse({
              id: "thr_pr",
              environmentId: "env_pr",
              createdAt: recent,
              updatedAt: recent,
              latestAttentionAt: recent,
              status: "idle",
            }),
          ],
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
        threads: {
          list: async () => [
            makeThreadResponse({
              id: "thr_pin",
              createdAt: old,
              updatedAt: old,
              latestAttentionAt: old,
              pinnedAt,
              status: "idle",
            }),
          ],
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
