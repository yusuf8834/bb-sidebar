import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createFakePluginHost, disposers, loadPlugin, type Environment } from "./test-server";
import plugin from "./server";
import { rateLimitDetails } from "./server-rate-limit-details";
import { RATE_LIMITS_CHANNEL } from "./realtime-channels";
import type { ThreadLimitState } from "./contract";

type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
const failedAt = Date.parse("2026-10-26T19:49:00Z");
const resetsAt = Date.parse("2026-10-26T22:00:00Z");
const message = "You've hit your session limit · resets 5pm (America/Chicago)";
const base = { threadId: "thr_1", createdAt: failedAt, scope: { kind: "thread" as const }, id: "event", seq: 2 };
const failure: Event = {
  ...base,
  type: "provider/error",
  data: {
    providerThreadId: "provider_1",
    message,
    errorInfo: { category: "rate-limit", httpStatusCode: null, providerCode: "rate_limit" },
  },
};
const systemFailure: Event = { ...base, seq: 3, type: "system/error", data: { message: "Provider error" } };
const started: Event = { ...base, seq: 1, type: "turn/started", data: { providerThreadId: "provider_1" } };
const codexMessage = "You've hit your usage limit. Upgrade to Pro or try again at Oct 27th, 2026 1:40 AM.";
const codexFailure: Event = {
  ...failure,
  data: {
    providerThreadId: "provider_1",
    message: "Provider error",
    detail: `Internal error: ${JSON.stringify({ message: codexMessage, codexErrorInfo: "usageLimitExceeded" })}`,
  },
};

afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(failedAt);
  const harness = await loadPlugin();
  let status: "error" | "idle" | "active" = "error";
  let events = [failure, started];
  let queue: ReturnType<typeof makeQueueEntry>[] = [];
  harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_1", status }));
  harness.inspection.sdk.stub("threads.events.list", async () => events);
  harness.inspection.sdk.stub("threads.queuedMessages.list", async () => queue);
  harness.inspection.sdk.stub("threads.send", async (args: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]) => {
    const entry = makeQueueEntry({
      id: "continue_1",
      threadId: args.threadId,
      content: args.input,
      sendAt: args.sendAt!,
      originPluginId: args.originPluginId!,
      state: "scheduled",
      waitingOn: { kind: "time" },
    });
    queue.push(entry);
    return { ok: true as const, delivery: "queued" as const, queuedMessage: entry };
  });
  harness.inspection.sdk.stub(
    "threads.queuedMessages.delete",
    async ({ queuedMessageId }: { queuedMessageId: string }) => {
      queue = queue.filter((entry) => entry.id !== queuedMessageId);
      return { ok: true as const };
    },
  );
  return {
    harness,
    call: harness.behavior.callRpc,
    setEvents: (next: Event[]) => {
      events = next;
    },
    setStatus: (next: typeof status) => {
      status = next;
    },
    setQueue: (next: typeof queue) => {
      queue = next;
    },
  };
}

describe("provider limit detection", () => {
  it.each([
    ["America/Chicago", "2026-10-27T06:40:00Z"],
    ["Europe/London", "2026-10-27T01:40:00Z"],
    ["Asia/Tokyo", "2026-10-26T16:40:00Z"],
  ])("reads Codex's dated reset in the provider host timezone (%s)", (timeZone, expected) => {
    expect(rateLimitDetails([codexFailure, started], timeZone)).toMatchObject({
      resetsAt: Date.parse(expected),
      timeZone,
    });
    expect(rateLimitDetails([codexFailure, started])?.resetsAt).toBeNull();
  });

  it.each(["Feb 30th, 2026 1:40 AM", "Oct 27th, 2026 13:40 AM", "Oct 27th, 2026 1:99 AM"])(
    "refuses an invalid dated reset (%s)",
    (timestamp) => {
      const event: Event = {
        ...failure,
        data: { ...failure.data, message: `Usage limit reached. Try again at ${timestamp}.` },
      };
      expect(rateLimitDetails([event], "America/Chicago")?.resetsAt).toBeNull();
    },
  );
  it("reads the screenshot's reset time in the provider's timezone", () => {
    expect(rateLimitDetails([failure, started])).toEqual({
      message,
      resetsAt,
      timeZone: "America/Chicago",
      scheduled: null,
    });
  });

  it("keeps a classified provider failure when core appends its generic error", () => {
    expect(rateLimitDetails([systemFailure, failure, started])?.resetsAt).toBe(resetsAt);
  });

  it("supports legacy rate_limit text and refuses an unrelated error", () => {
    const legacy: Event = {
      ...failure,
      data: {
        providerThreadId: "provider_1",
        message: `Internal error: ${message}: {"errorKind":"rate_limit"}`,
      },
    };
    expect(rateLimitDetails([legacy])?.resetsAt).toBe(resetsAt);
    expect(
      rateLimitDetails([
        {
          ...legacy,
          data: {
            ...legacy.data,
            errorInfo: {
              category: "internal",
              httpStatusCode: null,
              providerCode: null,
            },
          },
        },
      ])?.resetsAt,
    ).toBe(resetsAt);
    expect(rateLimitDetails([{ ...legacy, data: { ...legacy.data, message: "Network disconnected" } }])).toBeNull();
  });

  it("uses the latest blocked window and never inherits a prior turn's limit", () => {
    const limits: Event = {
      ...base,
      seq: 3,
      type: "provider/rateLimits/updated",
      data: {
        providerThreadId: "provider_1",
        rateLimits: {
          providerId: "claude",
          kind: "subscription-window",
          status: "blocked",
          overageReason: null,
          overageStatus: null,
          reachedReason: null,
          windows: [
            { label: "Session", providerKey: null, status: "blocked", resetsAtMs: resetsAt },
            { label: "Week", providerKey: null, status: "blocked", resetsAtMs: resetsAt + 86_400_000 },
          ],
        },
      },
    };
    expect(rateLimitDetails([limits, failure, started])?.resetsAt).toBe(resetsAt + 86_400_000);
    expect(rateLimitDetails([{ ...started, seq: 4 }, failure])).toBeNull();
    expect(rateLimitDetails([{ ...failure, data: { ...failure.data, willRetry: true } }])).toBeNull();
  });

  it("leaves the time unknown when the provider gives no usable reset", () => {
    const event: Event = { ...failure, data: { ...failure.data, message: "Session limit reached" } };
    expect(rateLimitDetails([event])?.resetsAt).toBeNull();
    expect(
      rateLimitDetails([
        { ...event, data: { ...event.data, message: "Session limit reached · resets 5pm (Invalid/Zone)" } },
      ])?.resetsAt,
    ).toBeNull();
  });

  it("reads limit details carried separately from the provider's error summary", () => {
    const event: Event = { ...failure, data: { ...failure.data, message: "Provider error", detail: message } };
    expect(rateLimitDetails([event])?.resetsAt).toBe(resetsAt);
  });
});

describe("scheduled Continue RPC", () => {
  it.each([
    ["Asia/Tokyo", "2026-10-26T16:40:00Z", false],
    ["America/Chicago", "2026-10-27T06:40:00Z", false],
    ["America/Chicago", "2026-10-27T06:40:00Z", true],
  ] as const)(
    "uses the thread machine's timezone and preserves manual fallback when unavailable (%s)",
    async (timeZone, resetTime, offline) => {
      vi.useFakeTimers();
      vi.setSystemTime(failedAt);
      const hostCall = vi.fn(async () => {
        if (offline) throw new Error("Host offline");
        return { timeZone };
      });
      const { bb, harness } = createFakePluginHost({
        pluginId: "bb-sidebar",
        experimental_callHostRpc: hostCall,
        sdk: {
          threads: {
            get: async () => makeThreadResponse({ id: "thr_1", status: "error", environmentId: "env_remote" }),
            events: { list: async () => [codexFailure, started] },
            queuedMessages: { list: async () => [] },
            send: async (args) => ({
              ok: true,
              delivery: "queued",
              queuedMessage: makeQueueEntry({ id: "continue_remote", sendAt: args.sendAt!, content: args.input }),
            }),
          },
          environments: { get: async () => ({ id: "env_remote", hostId: "host_remote" }) as Environment },
        },
      });
      disposers.push(() => harness.lifecycle.dispose());
      await plugin(bb);
      const result = (await harness.behavior.callRpc("getThreadLimits", { keys: ["thr_1"] })) as Record<
        string,
        ThreadLimitState | null
      >;
      expect(harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
        hostId: "host_remote",
        method: "timeZone",
        input: {},
      });
      expect(result.thr_1?.resetsAt).toBe(offline ? null : Date.parse(resetTime));
      if (offline) {
        await expect(harness.behavior.callRpc("scheduleLimitContinue", { threadId: "thr_1" })).rejects.toThrow(
          /Choose a time/,
        );
        expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      } else {
        expect(
          ((await harness.behavior.callRpc("scheduleLimitContinue", { threadId: "thr_1" })) as ThreadLimitState)
            .scheduled?.sendAt,
        ).toBe(Math.max(failedAt + 1000, Date.parse(resetTime) + 30_000));
      }
    },
  );
  it("discovers existing read failures and clears the warning once work resumes", async () => {
    const { call, setStatus } = await setup();
    expect(await call("getThreadLimits", { keys: ["thr_1"] })).toEqual({
      thr_1: { message, resetsAt, timeZone: "America/Chicago", scheduled: null },
    });
    setStatus("active");
    expect(await call("getThreadLimits", { keys: ["thr_1"] })).toEqual({ thr_1: null });
  });

  it("queues exactly one Continue after reset across simultaneous clicks and can cancel it", async () => {
    const { call, harness } = await setup();
    const [first, second] = (await Promise.all([
      call("scheduleLimitContinue", { threadId: "thr_1" }),
      call("scheduleLimitContinue", { threadId: "thr_1" }),
    ])) as ThreadLimitState[];
    expect(first.scheduled).toEqual({ id: "continue_1", sendAt: resetsAt + 30_000, failed: false });
    expect(await call("listLifecycle", {})).toMatchObject({
      rows: [{ threadId: "thr_1", snoozedUntil: resetsAt + 30_000, snoozedAt: failedAt }],
    });
    expect(second.scheduled).toEqual(first.scheduled);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.send")[0]?.[0]).toEqual({
      threadId: "thr_1",
      input: [{ type: "text", text: "Continue", mentions: [] }],
      mode: "queue-if-active",
      sendAt: resetsAt + 30_000,
      originPluginId: "bb-sidebar",
    });
    expect(
      ((await call("getThreadLimits", { keys: ["thr_1"] })) as Record<string, ThreadLimitState>).thr_1?.scheduled,
    ).toEqual(first.scheduled);
    await call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "continue_1" });
    expect(await call("listLifecycle", {})).toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(
      ((await call("getThreadLimits", { keys: ["thr_1"] })) as Record<string, ThreadLimitState>).thr_1?.scheduled,
    ).toBeNull();
    expect(harness.inspection.realtimeSignals.some((signal) => signal.channel === RATE_LIMITS_CHANNEL)).toBe(true);
  });

  it("coalesces thread-event bursts into one immediate and one trailing ping per second", async () => {
    const { call, harness } = await setup();
    const pings = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === RATE_LIMITS_CHANNEL);
    const thread = makeThreadResponse({ id: "thr_other" });
    const burst = async () => {
      await harness.behavior.emitThreadEvent("thread.active", { thread });
      await harness.behavior.emitThreadEvent("thread.failed", { thread, error: null });
      await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
      await harness.behavior.emitThreadEvent("thread.deleted", { thread });
    };
    await burst();
    expect(pings()).toHaveLength(1);
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    expect(pings()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(pings()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings()).toHaveLength(3);
    await burst();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings()).toHaveLength(4);
    await burst();
    expect(pings()).toHaveLength(5);
    await burst();
    await harness.lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings()).toHaveLength(5);
  });

  it("files an existing schedule in Snoozed without sending again or resetting its wake history", async () => {
    const { call, setQueue, harness } = await setup();
    setQueue([
      makeQueueEntry({
        id: "already_scheduled",
        sendAt: resetsAt,
        originPluginId: "bb-sidebar",
        content: [{ type: "text", text: "Continue", mentions: [] }],
        state: "scheduled",
      }),
    ]);
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    const first = await call("listLifecycle", {});
    vi.setSystemTime(failedAt + 60_000);
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    expect(await call("listLifecycle", {})).toEqual(first);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("preserves a later manual snooze when cancelling Continue", async () => {
    const { call } = await setup();
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    await call("snooze", { threadId: "thr_1", snoozedUntil: resetsAt + 3_600_000 });
    await call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "continue_1" });
    expect(await call("listLifecycle", {})).toMatchObject({ rows: [{ snoozedUntil: resetsAt + 3_600_000 }] });
  });

  it("keeps the thread Active if scheduling fails", async () => {
    const { call, harness } = await setup();
    harness.inspection.sdk.stub("threads.send", async () => {
      throw new Error("Offline");
    });
    await expect(call("scheduleLimitContinue", { threadId: "thr_1" })).rejects.toThrow("Offline");
    expect(await call("listLifecycle", {})).toEqual({ rows: [] });
  });

  it("allows a chosen future time for unknown resets and refuses past times", async () => {
    const { call, setEvents } = await setup();
    setEvents([{ ...failure, data: { ...failure.data, message: "Session limit reached" } }]);
    await expect(call("scheduleLimitContinue", { threadId: "thr_1" })).rejects.toThrow(/Choose a time/);
    await expect(call("scheduleLimitContinue", { threadId: "thr_1", sendAt: failedAt - 1 })).rejects.toThrow(/future/);
    const result = (await call("scheduleLimitContinue", { threadId: "thr_1", sendAt: resetsAt })) as ThreadLimitState;
    expect(result.scheduled?.sendAt).toBe(resetsAt);
  });

  it("does not schedule stale failures or delete another sender's queued message", async () => {
    const { call, setStatus, setQueue, harness } = await setup();
    setStatus("idle");
    await expect(call("scheduleLimitContinue", { threadId: "thr_1" })).rejects.toThrow(/no longer/);
    setQueue([
      makeQueueEntry({
        id: "other",
        sendAt: resetsAt,
        originPluginId: "another-plugin",
        content: [{ type: "text", text: "Continue", mentions: [] }],
      }),
    ]);
    await expect(call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "other" })).rejects.toThrow(
      /no longer queued/,
    );
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(0);
  });
});
