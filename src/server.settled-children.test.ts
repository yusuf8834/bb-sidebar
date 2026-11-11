import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  loadPlugin,
  projectThread,
  projectsWith,
  pullRequestStatus,
  terminalSession,
  type LifecycleListResult,
  type ProjectThread,
} from "./test-server";

const insertRow = (bb: ReturnType<typeof createFakePluginHost>["bb"], threadId: string) =>
  bb.storage
    .database()
    .prepare(
      `INSERT INTO thread_lifecycle
      (thread_id, settled_at, settled_override, parked_at, snoozed_until, snoozed_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(threadId, 100, "settled", null, null, null);

// Automatic settling would give these quiet threads rows of its own.
const manualOnly = {
  getSettings: async () => ({
    ok: true as const,
    schema: {},
    values: { autoSettleInactive: false, autoSettleOnMerge: false },
  }),
};

async function loadWith(threads: () => ProjectThread[]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      plugins: { ...manualOnly, callRpc: pullRequestStatus(() => ({ outcome: "absent" })) },
      projects: { list: async () => projectsWith(threads()) },
      threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  return { bb, harness };
}

const rowsOf = async (harness: Awaited<ReturnType<typeof loadWith>>["harness"]) =>
  ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows;

describe("children of older parent-only settles", () => {
  it("gives quiet children their settled ancestor's row once", async () => {
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 50 }),
      projectThread({ id: "quiet", parentThreadId: "parent", latestAttentionAt: 90 }),
      projectThread({ id: "grandchild", parentThreadId: "quiet", latestAttentionAt: 90 }),
      projectThread({ id: "hidden", parentThreadId: "parent", visibility: "hidden", latestAttentionAt: 90 }),
      projectThread({ id: "newer", parentThreadId: "parent", latestAttentionAt: 150 }),
      projectThread({ id: "working", parentThreadId: "parent", status: "active", latestAttentionAt: 90 }),
      projectThread({ id: "asking", parentThreadId: "parent", hasPendingInteraction: true, latestAttentionAt: 90 }),
      projectThread({ id: "unrelated", latestAttentionAt: 90 }),
    ];
    const { bb, harness } = await loadWith(() => threads);
    insertRow(bb, "parent");

    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: expect.arrayContaining(["quiet", "grandchild", "hidden"]),
    });
    const inherited = {
      parkedAt: null,
      settledAt: 100,
      settledOverride: "settled",
      snoozedUntil: null,
      snoozedAt: null,
    };
    expect(await rowsOf(harness)).toEqual([
      { threadId: "parent", ...inherited },
      { threadId: "quiet", ...inherited },
      { threadId: "grandchild", ...inherited },
      { threadId: "hidden", ...inherited },
    ]);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "lifecycle",
      payload: { threadIds: ["quiet", "grandchild", "hidden"] },
    });

    // A later rowless child is not legacy data. The repair does not run again.
    bb.storage.database().prepare("DELETE FROM thread_lifecycle WHERE thread_id = 'quiet'").run();
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    expect((await rowsOf(harness)).map((row) => row.threadId)).toEqual(["parent", "grandchild", "hidden"]);
  });

  it("leaves children alone when the ancestor no longer shows as settled", async () => {
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 200 }),
      projectThread({ id: "child", parentThreadId: "parent", latestAttentionAt: 90 }),
    ];
    const { bb, harness } = await loadWith(() => threads);
    insertRow(bb, "parent");
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    expect((await rowsOf(harness)).map((row) => row.threadId)).toEqual(["parent"]);
  });

  it("stops protecting the shared workspace once the child has its row", async () => {
    const shared = { environmentId: "env_shared", environmentHostId: "host_1", environmentPath: "/workspace/shared" };
    const threads = [
      projectThread({ id: "parent", title: "Parent", latestAttentionAt: 50, ...shared }),
      projectThread({ id: "child", title: "Child", parentThreadId: "parent", latestAttentionAt: 90, ...shared }),
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots")
          return {
            roots: (input as { roots: Array<{ environmentId: string }> }).roots.map((root) => ({
              environmentId: root.environmentId,
              path: "/workspace/shared",
            })),
          };
        if (method === "scan") return { ports: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        plugins: { ...manualOnly, callRpc: pullRequestStatus(() => ({ outcome: "absent" })) },
        projects: { list: async () => projectsWith(threads) },
        threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env_shared" }) },
        environments: {
          get: async () =>
            ({ id: "env_shared", hostId: "host_1", path: "/workspace/shared", status: "ready" }) as Awaited<
              ReturnType<typeof bb.sdk.environments.get>
            >,
        },
        terminals: {
          list: async ({ scope }) => ({
            sessions:
              scope.threadId === "parent"
                ? [{ ...terminalSession({ id: "term_dev", environmentId: "env_shared" }), threadId: "parent" }]
                : [],
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    insertRow(bb, "parent");

    const before = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["parent"] })) as {
      threads: unknown[];
      skipped: unknown[];
    };
    expect(before.threads).toEqual([]);
    expect(before.skipped).toEqual([
      {
        threadId: "parent",
        resource: "terminal",
        message: 'Kept 1 terminal open: shares a workspace with "Child", which is not settled',
      },
    ]);

    await harness.behavior.callRpc("evaluateAutoSettle", {});
    const after = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["parent"] })) as {
      threads: unknown[];
      skipped: unknown[];
    };
    expect(after.threads).toEqual([expect.objectContaining({ threadId: "parent", terminalCount: 1 })]);
    expect(after.skipped).toEqual([]);
  });
});

const insertLifecycle = (
  bb: ReturnType<typeof createFakePluginHost>["bb"],
  threadId: string,
  row: { settledAt?: number; settledOverride?: string; parkedAt?: number; snoozedUntil?: number; snoozedAt?: number },
) =>
  bb.storage
    .database()
    .prepare(
      `INSERT INTO thread_lifecycle
      (thread_id, settled_at, settled_override, parked_at, snoozed_until, snoozed_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      threadId,
      row.settledAt ?? null,
      row.settledOverride ?? null,
      row.parkedAt ?? null,
      row.snoozedUntil ?? null,
      row.snoozedAt ?? null,
    );

describe("children whose own row leaves them Active inside a settled tree", () => {
  const settledRow = {
    parkedAt: null,
    settledAt: 100,
    settledOverride: "settled",
    snoozedUntil: null,
    snoozedAt: null,
  };

  it("files them with the tree once, even after the first repair ran", async () => {
    const future = Date.now() + 60 * 60_000;
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 50 }),
      projectThread({ id: "woken", parentThreadId: "parent", latestAttentionAt: 30 }),
      projectThread({ id: "returned", parentThreadId: "parent", latestAttentionAt: 20 }),
      projectThread({ id: "snoozed", parentThreadId: "parent", latestAttentionAt: 20 }),
      projectThread({ id: "parked", parentThreadId: "parent", latestAttentionAt: 20 }),
    ];
    const { bb, harness } = await loadWith(() => threads);
    bb.storage.database().prepare("INSERT INTO lifecycle_backfills (name) VALUES ('settled-child-rows')").run();
    insertRow(bb, "parent");
    insertLifecycle(bb, "woken", { snoozedUntil: 60, snoozedAt: 25 });
    insertLifecycle(bb, "returned", { settledOverride: "active" });
    insertLifecycle(bb, "snoozed", { snoozedUntil: future, snoozedAt: 40 });
    insertLifecycle(bb, "parked", { parkedAt: 40 });

    await harness.behavior.callRpc("evaluateAutoSettle", {});
    const rows = new Map((await rowsOf(harness)).map((row) => [row.threadId, row]));
    expect(rows.get("woken")).toEqual({ threadId: "woken", ...settledRow });
    expect(rows.get("returned")).toEqual({ threadId: "returned", ...settledRow });
    expect(rows.get("snoozed")).toMatchObject({ snoozedUntil: future, settledAt: null });
    expect(rows.get("parked")).toMatchObject({ parkedAt: 40, settledAt: null });
  });

  it("follows the tree's top row, not a settled thread in the middle", async () => {
    const threads = [
      projectThread({ id: "root", latestAttentionAt: 50 }),
      projectThread({ id: "middle", parentThreadId: "root", latestAttentionAt: 50 }),
      projectThread({ id: "leaf", parentThreadId: "middle", latestAttentionAt: 50 }),
    ];
    const { bb, harness } = await loadWith(() => threads);
    insertRow(bb, "middle");
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    expect((await rowsOf(harness)).map((row) => row.threadId)).toEqual(["middle"]);
  });
});

describe("a thread back from the archive", () => {
  it("is settled with the settled tree it returns to, with its subtree", async () => {
    let archived = true;
    const threads = () => [
      projectThread({ id: "parent", latestAttentionAt: 50 }),
      ...(archived
        ? []
        : [
            projectThread({ id: "child", parentThreadId: "parent", latestAttentionAt: 40 }),
            projectThread({ id: "grandchild", parentThreadId: "child", latestAttentionAt: 40 }),
          ]),
      projectThread({ id: "other", latestAttentionAt: 40 }),
      projectThread({ id: "other-child", parentThreadId: "other", latestAttentionAt: 40 }),
    ];
    const { bb, harness } = await loadWith(threads);
    // The first policy pass runs the one-time repair before the child returns.
    await harness.behavior.callRpc("evaluateAutoSettle", {});
    insertRow(bb, "parent");
    archived = false;

    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "child", parentThreadId: "parent" }),
    });
    await harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "other-child", parentThreadId: "other" }),
    });
    const inherited = {
      parkedAt: null,
      settledAt: 100,
      settledOverride: "settled",
      snoozedUntil: null,
      snoozedAt: null,
    };
    expect(await rowsOf(harness)).toEqual([
      { threadId: "parent", ...inherited },
      { threadId: "child", ...inherited },
      { threadId: "grandchild", ...inherited },
    ]);
  });
});

describe("moving a thread under a settled parent", () => {
  async function setup(moved: { settled: boolean }) {
    const harness = await loadPlugin();
    let parentOf: string | null = null;
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith([projectThread({ id: "parent" }), projectThread({ id: "moved", parentThreadId: parentOf })]),
    );
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: threadId === "moved" ? parentOf : null }),
    );
    harness.inspection.sdk.stub("threads.update", async ({ threadId, parentThreadId }) => {
      parentOf = parentThreadId ?? null;
      return makeThreadResponse({ id: threadId, parentThreadId: parentOf });
    });
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    if (moved.settled) await harness.behavior.callRpc("settle", { threadId: "moved" });
    await harness.behavior.callRpc("setThreadParent", { threadId: "moved", parentThreadId: "parent" });
    return ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows;
  }

  it("returns the parent to Active when the moved thread is not settled", async () => {
    expect(await setup({ settled: false })).toEqual([]);
  });

  it("keeps the parent settled when the moved thread is settled too", async () => {
    expect((await setup({ settled: true })).map((row) => row.threadId)).toEqual(["parent", "moved"]);
  });
});
