import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { AUTO_TITLE_RECOVERY_MIGRATION, createAutoTitleRecovery } from "./auto-title";
import { createTitleRegenerator, PermanentTitleError } from "./regenerate-title";

const disposers: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
});

function setup(useRealGenerator = false) {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [AUTO_TITLE_RECOVERY_MIGRATION]);
  let thread = makeThreadResponse({
    id: "target",
    title: null,
    visibility: "visible",
    environmentId: "workspace",
  });
  let off = false;
  const sdk = harness.inspection.sdk;
  sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ ...thread, id: threadId }));
  sdk.stub("system.aiServices", async () => ({
    selections: {
      "thread-title": off
        ? { mode: "off" }
        : {
            mode: "service",
            pluginId: "provider-codex",
            serviceId: "codex",
          },
    },
    services: [
      {
        id: "codex",
        pluginId: "provider-codex",
        displayName: "Codex",
        tasks: ["thread-title"],
        status: { ready: true },
      },
    ],
  }));
  const regenerate = vi.fn(async () => ({ title: "Review sidebar pull request", changed: true }));
  createAutoTitleRecovery(bb, useRealGenerator ? createTitleRegenerator(bb) : regenerate);
  disposers.push(() => harness.lifecycle.dispose());
  return {
    bb,
    harness,
    sdk,
    db,
    regenerate,
    setThread: (changes: Partial<typeof thread>) => {
      thread = { ...thread, ...changes };
    },
    setOff: () => {
      off = true;
    },
    active: () => harness.behavior.emitThreadEvent("thread.active", { thread }),
    attempt: async () => {
      await harness.behavior.emitThreadEvent("thread.active", { thread });
      await vi.advanceTimersByTimeAsync(10_000);
    },
    claims: () => db.prepare("SELECT thread_id FROM title_recovery_attempts").all(),
    idle: () => harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null }),
  };
}

describe("automatic title recovery", () => {
  it("waits for BB, recovers once, and remembers the attempt after reload", async () => {
    const state = setup();
    await state.active();
    await state.idle();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.regenerate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.regenerate).toHaveBeenCalledExactlyOnceWith("target", { onlyIfUntitled: true });
    await state.active();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).toHaveBeenCalledTimes(1);
    const replacement = await state.harness.lifecycle.reload((bb) => createAutoTitleRecovery(bb, state.regenerate));
    disposers.push(() => replacement.harness.lifecycle.dispose());
    await replacement.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "target", title: null, visibility: "visible" }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).toHaveBeenCalledTimes(1);
  });

  it("lets BB's successful title win before recovery starts", async () => {
    const state = setup();
    await state.active();
    state.setThread({ title: "BB generated title" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).not.toHaveBeenCalled();
    expect(state.sdk.callsTo("system.aiServices")).toHaveLength(0);
  });

  it("does no generation when thread titles are off", async () => {
    const state = setup();
    await state.active();
    state.setOff();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).not.toHaveBeenCalled();
    expect(state.db.prepare("SELECT * FROM title_recovery_attempts").all()).toEqual([]);
  });

  it.each([{ title: "Manual title" }, { visibility: "hidden" as const }, { archivedAt: 1 }, { deletedAt: 1 }])(
    "skips threads that already have a title or are unavailable: %j",
    async (changes) => {
      const state = setup();
      state.setThread(changes);
      await state.active();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.regenerate).not.toHaveBeenCalled();
      expect(state.sdk.callsTo("threads.get")).toHaveLength(0);
    },
  );

  it("retries a transient failure on later thread events, at most three attempts in total", async () => {
    const state = setup();
    state.regenerate.mockRejectedValue(new Error("Timed out"));
    await state.attempt();
    expect(state.regenerate).toHaveBeenCalledTimes(1);
    expect(state.claims()).toEqual([]);
    await state.idle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) await state.attempt();
    expect(state.regenerate).toHaveBeenCalledTimes(3);
    expect(state.claims()).toEqual([{ thread_id: "target" }]);
  });

  it("keeps the claim after a transient failure is followed by success", async () => {
    const state = setup();
    state.regenerate.mockRejectedValueOnce(new Error("Cloud timeout"));
    await state.attempt();
    await state.attempt();
    await state.attempt();
    expect(state.regenerate).toHaveBeenCalledTimes(2);
    expect(state.claims()).toEqual([{ thread_id: "target" }]);
  });

  it("stops after one permanent failure", async () => {
    const state = setup();
    state.regenerate.mockRejectedValue(new PermanentTitleError("This thread has no user-message text"));
    await state.attempt();
    await state.attempt();
    expect(state.regenerate).toHaveBeenCalledTimes(1);
    expect(state.claims()).toEqual([{ thread_id: "target" }]);
  });

  it("starts a fresh attempt budget after a thread is deleted", async () => {
    const state = setup();
    state.regenerate.mockRejectedValue(new Error("Timed out"));
    await state.attempt();
    await state.attempt();
    await state.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "target" }) });
    for (let i = 0; i < 4; i++) await state.attempt();
    expect(state.regenerate).toHaveBeenCalledTimes(5);
  });

  it("asks bb at most three times for a thread whose generation always fails", async () => {
    const state = setupCore();
    state.sdk.stub("threads.experimental_regenerateTitle", async () => {
      throw new Error("The title service timed out");
    });
    for (let i = 0; i < 5; i++) await state.attempt();
    expect(state.sdk.callsTo("threads.experimental_regenerateTitle")).toHaveLength(3);
    expect(state.claims()).toEqual([{ thread_id: "target" }]);
  });

  it("keeps the claim when a reload aborts an attempt in flight", async () => {
    const state = setupCore();
    state.sdk.stub("threads.experimental_regenerateTitle", async ({ signal }: { signal: AbortSignal }) => {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    await state.attempt();
    expect(state.sdk.callsTo("threads.experimental_regenerateTitle")).toHaveLength(1);
    let db!: ReturnType<typeof state.bb.storage.database>;
    const replacement = await state.harness.lifecycle.reload((bb) => {
      db = bb.storage.database();
      createAutoTitleRecovery(bb, state.regenerate);
    });
    disposers.push(() => replacement.harness.lifecycle.dispose());
    expect(db.prepare("SELECT thread_id FROM title_recovery_attempts").all()).toEqual([{ thread_id: "target" }]);
    await replacement.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "target", title: null, visibility: "visible" }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).not.toHaveBeenCalled();
  });

  it("cancels pending work and removes the attempt when a thread is deleted", async () => {
    const state = setup();
    await state.active();
    await state.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "target" }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).not.toHaveBeenCalled();
    await state.active();
    await vi.advanceTimersByTimeAsync(10_000);
    await state.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "target" }) });
    expect(state.db.prepare("SELECT * FROM title_recovery_attempts").all()).toEqual([]);
  });

  it("cancels timers when the plugin is disposed", async () => {
    const state = setup();
    await state.active();
    await state.harness.lifecycle.dispose();
    disposers.pop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).not.toHaveBeenCalled();
  });

  it("does not start recovery or leave an attempt for a thread deleted during the service check", async () => {
    const state = setup();
    let finish!: () => void;
    const serviceCheck = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.sdk.stub("system.aiServices", async () => {
      await serviceCheck;
      return { selections: { "thread-title": { mode: "automatic" } }, services: [] };
    });
    await state.active();
    await vi.advanceTimersByTimeAsync(10_000);
    await state.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "target" }),
    });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.regenerate).not.toHaveBeenCalled();
    expect(state.db.prepare("SELECT * FROM title_recovery_attempts").all()).toEqual([]);
  });

  it("limits simultaneous recoveries and drains queued threads", async () => {
    const state = setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.regenerate.mockImplementation(async () => {
      await pending;
      return { title: "Recovered title", changed: true };
    });
    for (const id of ["one", "two", "three"]) {
      state.setThread({ id });
      await state.active();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.regenerate).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.regenerate).toHaveBeenCalledTimes(3);
  });

  it("names an untitled thread through bb with the selected service", async () => {
    const state = setupCore();
    await state.active();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.harness.logEntries).toEqual([]);
    expect(state.sdk.callsTo("threads.experimental_regenerateTitle")[0]![0]).toMatchObject({ threadId: "target" });
    expect(state.sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("does not ask bb when the thread got a title just before recovery", async () => {
    const state = setupCore();
    state.sdk.stub("system.aiServices", async () => {
      state.setThread({ title: "My title" });
      return { selections: { "thread-title": { mode: "automatic" } }, services: [] };
    });
    await state.active();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.sdk.callsTo("threads.experimental_regenerateTitle")).toHaveLength(0);
  });
});

function setupCore() {
  const state = setup(true);
  state.sdk.stub("threads.experimental_regenerateTitle", async () =>
    makeThreadResponse({ title: "Review sidebar pull request" }),
  );
  return state;
}
