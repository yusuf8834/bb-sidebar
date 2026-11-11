import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  projectThread,
  projectsWith,
  terminalSession,
  loadPlugin,
  deferred,
  type LifecycleListResult,
  type ProjectThread,
} from "./test-server";

describe("release lifecycle safety", () => {
  async function host(threads: ProjectThread[]) {
    const harness = await loadPlugin();
    // Match the real host: projects hide helpers; the paged thread list does not.
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith(threads.filter((t) => t.visibility === "visible")),
    );
    harness.inspection.sdk.stub("threads.list", async (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => {
      const { offset = 0, limit = 100, threadIds } = args ?? {};
      const matching = threadIds ? threads.filter((t) => threadIds.includes(t.id)) : threads;
      return matching.slice(offset, offset + limit);
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse(threads.find((t) => t.id === threadId)!),
    );
    harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      const thread = threads.find((t) => t.id === threadId)!;
      thread.pinnedAt = null;
      return makeThreadResponse(thread);
    });
    harness.inspection.sdk.stub("threads.pin", async ({ threadId }) => {
      const thread = threads.find((t) => t.id === threadId)!;
      thread.pinnedAt = Date.now();
      return makeThreadResponse(thread);
    });
    harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
    return harness;
  }

  it.each(["activity", "return", "pin", "reparent"])("cancels queued reclaim after newer %s", async (change) => {
    const threads = [
      projectThread({ id: "root" }),
      ...Array.from({ length: 5 }, (_, i) => projectThread({ id: `child${i}`, parentThreadId: "root" })),
    ];
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

  it("looks up only the settling thread before stopping it", async () => {
    const threads = [
      projectThread({ id: "root" }),
      ...Array.from({ length: 150 }, (_, i) => projectThread({ id: `other${i}` })),
    ];
    const h = await host(threads);
    await h.behavior.callRpc("settle", { threadId: "root" });
    expect(h.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "root" }]]);
    // Each reclaim check is one id-filtered read, not a walk over every page.
    const reads = h.inspection.sdk.callsTo("threads.list") as Array<[{ threadIds?: string[] }]>;
    const reclaimReads = reads.filter(([args]) => args?.threadIds);
    expect(reclaimReads.length).toBeGreaterThan(0);
    expect(reclaimReads.every(([args]) => args.threadIds?.join() === "root")).toBe(true);
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
    const threads = [
      projectThread({ id: "root", createdAt: old, latestAttentionAt: old, updatedAt: old }),
      projectThread({ id: "child", parentThreadId: "root", createdAt: old, latestAttentionAt: old, updatedAt: old }),
    ];
    const h = await host(threads);
    await h.behavior.callRpc("settle", { threadId: "root" });
    await h.behavior.callRpc("unsettle", { threadId: "root" });
    expect(await h.behavior.callRpc("listLifecycle", {})).toMatchObject({
      rows: [{ threadId: "root", settledOverride: "active" }],
    });
    await h.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ ...threads[0]!, status: "active" }),
    });
    expect(await h.behavior.callRpc("evaluateAutoSettle", {})).toEqual({ changedThreadIds: ["root", "child"] });
  });

  it.each(["unpin fails", "child starts"])("restores native pins when Settle fails: %s", async (reason) => {
    const threads = [
      projectThread({ id: "root", pinnedAt: 1, pinSortKey: "B" }),
      projectThread({ id: "child", parentThreadId: "root", pinnedAt: 2 }),
      projectThread({ id: "other", pinnedAt: 1, pinSortKey: "A" }),
    ];
    const h = await host(threads);
    h.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      if (threadId === "child" && reason === "unpin fails") throw new Error("unpin failed");
      threads.find((t) => t.id === threadId)!.pinnedAt = null;
      if (reason === "child starts") threads[1]!.status = "active";
      return makeThreadResponse({ id: threadId });
    });
    await expect(h.behavior.callRpc("settle", { threadId: "root" })).rejects.toThrow();
    expect(threads[0]!.pinnedAt).not.toBeNull();
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
    expect(h.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    expect(h.inspection.sdk.callsTo("threads.reorderPinned")).toContainEqual([
      { threadId: "root", previousThreadId: "other", nextThreadId: null },
    ]);
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
    await expect(
      h.behavior.callRpc(method, {
        threadId: "root",
        ...(method === "setThreadParent" ? { parentThreadId: "other" } : {}),
      }),
    ).rejects.toThrow("already in progress");
    gate.resolve();
    await settling;
    expect(threads[0]!.pinnedAt).toBeNull();
    expect(await h.behavior.callRpc("listLifecycle", {})).toMatchObject({
      rows: [{ threadId: "root", settledOverride: "settled" }],
    });
  });

  it("loads hidden nodes beyond the first page and refuses busy subtrees", async () => {
    const threads = [
      projectThread({ id: "root" }),
      // A full first page of 500, so both hidden nodes arrive on the second.
      ...Array.from({ length: 499 }, (_, i) => projectThread({ id: `other${i}` })),
      projectThread({ id: "hidden", parentThreadId: "root", visibility: "hidden", queuedWork: "failed" }),
      projectThread({ id: "grandchild", parentThreadId: "hidden", status: "active" }),
    ];
    const byId = (id: string) => threads.find((thread) => thread.id === id)!;
    const h = await host(threads);
    await expect(h.behavior.callRpc("settle", { threadId: "root" })).rejects.toThrow("Cannot settle");
    expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] });
    expect(h.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    byId("hidden").queuedWork = "none";
    await expect(h.behavior.callRpc("settle", { threadId: "root" })).rejects.toThrow("Cannot settle");
    byId("grandchild").status = "idle";
    await h.behavior.callRpc("settle", { threadId: "root" });
    const result = (await h.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(result.rows.map((r) => r.threadId).sort()).toEqual(["grandchild", "hidden", "root"]);
  });

  it("pages the full thread list 500 at a time", async () => {
    const threads = [
      projectThread({ id: "root" }),
      ...Array.from({ length: 500 }, (_, i) => projectThread({ id: `other${i}` })),
      projectThread({ id: "hidden", parentThreadId: "root", visibility: "hidden" }),
    ];
    const h = await host(threads);
    await h.behavior.callRpc("settle", { threadId: "root" });
    const reads = h.inspection.sdk.callsTo("threads.list") as Array<[{ threadIds?: string[] }]>;
    const pages = reads.filter(([args]) => !args?.threadIds).map(([args]) => args);
    expect(pages.slice(0, 2)).toEqual([
      { archived: false, includeHidden: true, limit: 500, offset: 0 },
      { archived: false, includeHidden: true, limit: 500, offset: 500 },
    ]);
    const result = (await h.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(result.rows.map((r) => r.threadId).sort()).toEqual(["hidden", "root"]);
  });

  it.each([false, true])(
    "rechecks queued automatic cleanup under changed rules, still eligible=%s",
    async (eligible) => {
      const old = Date.now() - 8 * 86400000;
      const threads = Array.from({ length: 6 }, (_, i) =>
        projectThread({ id: `root${i}`, createdAt: old, updatedAt: old, latestAttentionAt: old }),
      );
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
      await h.behavior.callRpc(
        "updateSidebarSettings",
        eligible ? { autoSettleAfterDays: 4 } : { autoSettleInactive: false, autoSettleOnMerge: false },
      );
      gate.resolve();
      await settling;
      expect(stopped.includes("root5")).toBe(eligible);
      if (!eligible)
        await vi.waitFor(async () => expect(await h.behavior.callRpc("listLifecycle", {})).toEqual({ rows: [] }));
    },
  );

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
    expect(await h.behavior.callRpc("updateSidebarSettings", { childSortDirection: "descending" })).toMatchObject({
      workingShelf: true,
      childSortDirection: "descending",
    });
    await expect(h.behavior.callRpc("updateSidebarSettings", { archivedShelfEnabled: true })).rejects.toThrow(
      "validation",
    );
  });
});
