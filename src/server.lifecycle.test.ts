import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  projectThread,
  projectsWith,
  terminalSession,
  loadPlugin,
  type LifecycleListResult,
} from "./test-server";

describe("lifecycle RPC", () => {
  it("settles and restores a thread", async () => {
    const harness = await loadPlugin();

    await harness.behavior.callRpc("settle", { threadId: "thr_1" });
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toEqual([]);
    const settled = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(settled.rows).toEqual([
      expect.objectContaining({
        threadId: "thr_1",
        settledAt: expect.any(Number),
        snoozedUntil: null,
      }),
    ]);

    await harness.behavior.callRpc("unsettle", { threadId: "thr_1" });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({
      rows: [
        expect.objectContaining({
          threadId: "thr_1",
          settledAt: null,
          settledOverride: "active",
        }),
      ],
    });
  });

  it.each(["settle", "snooze", "park"])("makes pin and %s mutually exclusive in both directions", async (method) => {
    const harness = await loadPlugin();
    let pinned = false;
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith([projectThread({ id: "thr_1", pinnedAt: pinned ? 1 : null })]),
    );
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
    const shelfField = method === "park" ? "parkedAt" : method === "snooze" ? "snoozedUntil" : "settledAt";
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toMatchObject({
      rows: [{ [shelfField]: expect.any(Number) }],
    });

    await expect(harness.behavior.callRpc("pin", { threadId: "thr_1" })).resolves.toEqual({ ok: true });
    expect(pinned).toBe(true);
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({
      rows: [
        {
          threadId: "thr_1",
          parkedAt: null,
          settledAt: null,
          settledOverride: "active",
          snoozedUntil: null,
          snoozedAt: null,
        },
      ],
    });
    expect(harness.inspection.realtimeSignals.at(-1)).toEqual({
      channel: "lifecycle",
      payload: { threadId: "thr_1" },
    });
  });

  it.each(["settle", "snooze", "park"])("preserves %s when native pinning fails", async (method) => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc(method, {
      threadId: "thr_1",
      ...(method === "snooze" ? { snoozedUntil: Date.now() + 60_000 } : {}),
    });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    harness.inspection.sdk.stub("threads.pin", async () => {
      throw new Error("pin update failed");
    });

    await expect(harness.behavior.callRpc("pin", { threadId: "thr_1" })).rejects.toThrow("pin update failed");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it("releases the agent session and only the terminals nobody used", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([projectThread({ id: "thr_1" })]) },
        threads: {
          unpin: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }),
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

    await expect(harness.behavior.callRpc("settle", { threadId: "thr_1" })).resolves.toEqual({
      ok: true,
      reclaim: { closedTerminals: 1, keptTerminals: 1, stoppedRuntime: true },
      undoToken: expect.any(String),
    });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_1" }]]);
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
          unpin: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }),
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

    await expect(harness.behavior.callRpc("settle", { threadId: "thr_1" })).resolves.toEqual({
      ok: true,
      reclaim: { closedTerminals: 0, keptTerminals: 0, stoppedRuntime: false },
      undoToken: expect.any(String),
    });
    const settled = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(settled.rows).toEqual([expect.objectContaining({ threadId: "thr_1", settledOverride: "settled" })]);
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

    const result = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
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

    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
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
    await expect(harness.behavior.callRpc("listInboxOrder", {})).resolves.toEqual({
      inboxThreadIds: ["thr_2", "thr_1"],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "inbox-order",
      payload: {},
    });

    const reloaded = await harness.lifecycle.reload(plugin);
    disposers.push(() => reloaded.harness.lifecycle.dispose());
    await expect(reloaded.harness.behavior.callRpc("listInboxOrder", {})).resolves.toEqual({
      inboxThreadIds: ["thr_2", "thr_1"],
    });
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
    await expect(harness.behavior.callRpc("listInboxOrder", {})).resolves.toEqual({
      inboxThreadIds: ["thr_1", "thr_2"],
    });
  });

  it("removes lifecycle state when bb deletes the thread", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("settle", { threadId: "thr_1" });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
  });

  it("forgets a deleted thread's pull request scan", async () => {
    const harness = await loadPlugin();
    const message = { seq: 1, type: "item/completed", data: { item: { type: "agentMessage", text: "done" } } };
    harness.inspection.sdk.stub("threads.events.list", async () => [message]);
    const reads = () => harness.inspection.sdk.callsTo("threads.events.list") as Array<[{ afterSeq?: string }]>;
    await harness.behavior.callRpc("getThreadPullRequests", { threadId: "thr_1" });
    await harness.behavior.callRpc("getThreadPullRequests", { threadId: "thr_1" });
    expect(reads().at(-1)?.[0].afterSeq).toBe("1");

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    await harness.behavior.callRpc("getThreadPullRequests", { threadId: "thr_1" });
    expect(reads().at(-1)?.[0].afterSeq).toBeUndefined();
  });

  it("removes a deleted thread from the saved inbox order", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callRpc("reorderInbox", {
      inboxThreadIds: ["thr_1", "thr_2"],
    });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    await expect(harness.behavior.callRpc("listInboxOrder", {})).resolves.toEqual({ inboxThreadIds: ["thr_2"] });
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
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  });
});
