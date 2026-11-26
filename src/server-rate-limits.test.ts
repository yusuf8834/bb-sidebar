import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createFakePluginHost, disposers, loadPlugin, type Environment } from "./test-server";
import plugin from "./server";
import { rateLimitDetails } from "./server-rate-limit-details";
import { RATE_LIMITS_CHANNEL } from "./realtime-channels";
import type { ThreadLimitState, ThreadRecoveryState } from "./contract";
import { limitOf } from "./rate-limit-labels";

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
    queue: () => queue,
  };
}

describe("provider limit detection", () => {
  const poolerError = "API Error: Request rejected (429) · No Account Pooler account is currently eligible.";
  it.each([
    ["at 2026-11-26T19:40:00.000Z (in 5768 seconds).", Date.UTC(2026, 10, 26, 19, 40)],
    ["at 2026-11-26T13:40:00-06:00.", Date.UTC(2026, 10, 26, 19, 40)],
    ["in 5768 seconds.", failedAt + 5_768_000],
    ["at an-unknown-time (in 10 seconds).", failedAt + 10_000],
    ["at 2026-02-30T19:40:00Z.", null],
    ["at 2026-11-26T19:40:00.", null],
    ["later. Request logged at 2026-11-26T19:40:00Z.", null],
  ])("reads Account Pooler availability %s", (availability, expected) => {
    const event: Event = {
      ...failure,
      data: {
        providerThreadId: "provider_1",
        message: "Provider error",
        detail: `${poolerError} Next account is expected to be available ${availability}`,
      },
    };
    expect(rateLimitDetails([event])).toMatchObject({ resetsAt: expected, timeZone: null });
  });

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
      retry: null,
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
      thr_1: { message, resetsAt, timeZone: "America/Chicago", scheduled: null, retry: null },
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

  it("keeps a scheduled Continue's snooze when the same limit fails another turn", async () => {
    const { call, harness, setEvents } = await setup();
    const thread = makeThreadResponse({ id: "thr_1", status: "error" });
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    for (const at of [failedAt + 10_000, failedAt + 20_000]) {
      vi.setSystemTime(at);
      await harness.behavior.emitThreadEvent("thread.failed", { thread, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(await call("listLifecycle", {})).toMatchObject({
        rows: [{ threadId: "thr_1", snoozedUntil: resetsAt + 30_000, snoozedAt: at }],
      });
    }
    // Any other failure is news, so it wakes the thread as before.
    setEvents([{ ...systemFailure, data: { message: "Tool crashed" } }, started]);
    vi.setSystemTime(failedAt + 30_000);
    await harness.behavior.emitThreadEvent("thread.failed", { thread, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(await call("listLifecycle", {})).toMatchObject({ rows: [{ snoozedAt: failedAt + 20_000 }] });
  });

  it("leaves an acknowledged wake in Active when the limit fails again", async () => {
    const { call, harness } = await setup();
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    await call("acknowledgeWake", { threadId: "thr_1" });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_1", status: "error" }),
      error: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await call("listLifecycle", {})).toEqual({ rows: [] });
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

describe("bb's queued provider retry", () => {
  const retryAt = resetsAt + 20_000;
  const retryRow = (overrides: Partial<ReturnType<typeof makeQueueEntry>> = {}) =>
    makeQueueEntry({
      id: "retry_1",
      threadId: "thr_1",
      initiator: "system",
      content: [{ type: "text", text: "Fix the build", mentions: [] }],
      sendAt: retryAt,
      state: "scheduled",
      waitingOn: { kind: "time" },
      payload: { kind: "retry", attempt: 1, reason: "Rate limited", retryOfTurnRequestId: "turn_1" },
      ...overrides,
    });
  const recovery = async (call: (method: string, input: unknown) => Promise<unknown>) =>
    ((await call("getThreadLimits", { keys: ["thr_1"] })) as Record<string, ThreadRecoveryState | null>).thr_1;
  const limits = async (call: (method: string, input: unknown) => Promise<unknown>) => limitOf(await recovery(call));

  it("reports bb's retry with the limit and refuses to queue a Continue on top of it", async () => {
    const { call, setQueue, harness } = await setup();
    setQueue([retryRow()]);
    expect(await limits(call)).toEqual({
      message,
      resetsAt,
      timeZone: "America/Chicago",
      scheduled: null,
      retry: { id: "retry_1", sendAt: retryAt, failed: false },
    });
    const result = (await call("scheduleLimitContinue", { threadId: "thr_1" })) as ThreadLimitState;
    expect(result.retry).toEqual({ id: "retry_1", sendAt: retryAt, failed: false });
    expect(result.scheduled).toBeNull();
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    // Display only: bb's retry does not snooze the thread.
    expect(await call("listLifecycle", {})).toEqual({ rows: [] });
  });

  it("reports no retry when none is queued", async () => {
    const { call } = await setup();
    expect((await limits(call))?.retry).toBeNull();
  });

  it("reports a retry of a failure that is not a provider limit on its own, not as a limit", async () => {
    const { call, setQueue, setEvents, harness } = await setup();
    setEvents([{ ...systemFailure, data: { message: "Provider unavailable" } }, started]);
    setQueue([
      retryRow({
        payload: { kind: "retry", attempt: 1, reason: "Provider unavailable", retryOfTurnRequestId: "turn_1" },
      }),
    ]);
    expect(await recovery(call)).toEqual({ retry: { id: "retry_1", sendAt: retryAt, failed: false } });
    await expect(call("scheduleLimitContinue", { threadId: "thr_1" })).rejects.toThrow(/no longer stopped/);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("reports nothing once bb gives up: no retry queued and no limit", async () => {
    const { call, setEvents } = await setup();
    setEvents([{ ...systemFailure, data: { message: "Provider unavailable" } }, started]);
    expect(await recovery(call)).toBeNull();
  });

  it("reports no retry while the only queued item is the sidebar's own Continue", async () => {
    const { call } = await setup();
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    expect(await limits(call)).toMatchObject({ scheduled: { id: "continue_1" }, retry: null });
  });

  it("cancels bb's retry, after which Continue is offered and can be scheduled", async () => {
    const { call, setQueue, harness } = await setup();
    setQueue([retryRow()]);
    const pings = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === RATE_LIMITS_CHANNEL);
    const before = pings().length;
    expect(await call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "retry_1" })).toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.delete")[0]?.[0]).toEqual({
      threadId: "thr_1",
      queuedMessageId: "retry_1",
    });
    expect(pings().length).toBeGreaterThan(before);
    expect(await limits(call)).toEqual({
      message,
      resetsAt,
      timeZone: "America/Chicago",
      scheduled: null,
      retry: null,
    });
    const scheduled = (await call("scheduleLimitContinue", { threadId: "thr_1" })) as ThreadLimitState;
    expect(scheduled.scheduled?.sendAt).toBe(resetsAt + 30_000);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("refuses to cancel a retry bb is already sending", async () => {
    const { call, setQueue, harness } = await setup();
    setQueue([retryRow({ state: "claimed" })]);
    await expect(call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "retry_1" })).rejects.toThrow(
      /already being sent/,
    );
    setQueue([]);
    await expect(call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "retry_1" })).rejects.toThrow(
      /no longer queued/,
    );
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(0);
  });

  it("keeps the sidebar's own Continue and its snooze when bb's retry is cancelled", async () => {
    const { call, setQueue, queue } = await setup();
    await call("scheduleLimitContinue", { threadId: "thr_1" });
    const snoozed = await call("listLifecycle", {});
    setQueue([...queue(), retryRow()]);
    const both = await limits(call);
    expect(both?.scheduled?.id).toBe("continue_1");
    expect(both?.retry?.id).toBe("retry_1");
    await call("cancelLimitContinue", { threadId: "thr_1", queuedMessageId: "retry_1" });
    expect(await call("listLifecycle", {})).toEqual(snoozed);
    expect((await limits(call))?.scheduled?.id).toBe("continue_1");
  });

  it("pings open sidebars when bb queues, sends or cancels a retry", async () => {
    const { harness } = await setup();
    const pings = () => harness.inspection.realtimeSignals.filter((signal) => signal.channel === RATE_LIMITS_CHANNEL);
    await harness.behavior.emitThreadEvent("message.queued", { entry: makeQueueEntry({ id: "plain" }) });
    expect(pings()).toHaveLength(0);
    await harness.behavior.emitThreadEvent("message.queued", { entry: retryRow() });
    expect(pings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: retryRow() });
    expect(pings()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await harness.behavior.emitThreadEvent("message.cancelled", { entry: retryRow() });
    expect(pings()).toHaveLength(3);
  });
});
