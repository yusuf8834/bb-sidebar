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

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "t3chat-sidebar",
    sdk: {
      threads: {
        unpin: async ({ threadId }) =>
          makeThreadResponse({ id: threadId }),
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
    ).resolves.toEqual({ rows: [] });
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

  it("does not settle when native unpinning fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "t3chat-sidebar",
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
