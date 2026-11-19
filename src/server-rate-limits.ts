import type { ServerContext } from "./server-context";
import { RATE_LIMITS_CHANNEL, type ThreadLimitState } from "./contract";
import { rateLimitDetails } from "./server-rate-limit-details";
import { runThreadTasks } from "./thread-tasks";
import { portScanContract } from "./port-scan-contract";
import type { createServerLifecycle } from "./server-lifecycle";

type QueueState = Awaited<ReturnType<ServerContext["bb"]["sdk"]["threads"]["queuedMessages"]["list"]>>[number]["state"];
const failedState = (state: QueueState) => state === "failed_exhausted" || state === "failed_retrying";

export function createServerRateLimits({ bb }: ServerContext, lifecycle: ReturnType<typeof createServerLifecycle>) {
  const host = bb.hosts.experimental_client({ contract: portScanContract });
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  const locks = new Map<string, Promise<unknown>>();
  const changed = () => bb.realtime.publish(RATE_LIMITS_CHANNEL, {});
  // Thread events arrive in bursts and every open sidebar refetches on each ping, so publish the first event at
  // once and fold the rest of each one-second window into a single trailing ping.
  let burst: ReturnType<typeof setTimeout> | undefined;
  let trailing = false;
  const closeBurst = () => {
    burst = undefined;
    if (!trailing || controller.signal.aborted) return;
    trailing = false;
    changed();
    openBurst();
  };
  const openBurst = () => {
    burst = setTimeout(closeBurst, 1000);
    burst.unref();
  };
  const threadChanged = () => {
    if (controller.signal.aborted) return;
    if (burst) {
      trailing = true;
      return;
    }
    changed();
    openBurst();
  };
  bb.onDispose(() => clearTimeout(burst));
  for (const event of ["thread.failed", "thread.active", "thread.idle", "thread.deleted"] as const) {
    bb.events.on(event, threadChanged);
  }
  // bb queues its retry of a failed turn (provider-retry does it for a provider limit) a moment after
  // `thread.failed`, so its own queue events refresh the warning.
  for (const event of ["message.queued", "message.dispatched", "message.cancelled"] as const) {
    bb.events.on(event, ({ entry }) => {
      if (entry.payload.kind === "retry") threadChanged();
    });
  }
  bb.events.on("thread.failed", ({ thread }) => keepWaitingOnContinue(thread.id));

  async function queued(threadId: string) {
    const queue = await bb.sdk.threads.queuedMessages.list({ threadId });
    return {
      scheduled: queue.find(
        (entry) =>
          entry.originPluginId === bb.pluginId &&
          entry.sendAt !== null &&
          entry.content.length === 1 &&
          entry.content[0]?.type === "text" &&
          entry.content[0].text === "Continue",
      ),
      retry: queue.find((entry) => entry.payload.kind === "retry"),
    };
  }

  async function scheduledContinue(threadId: string) {
    return (await queued(threadId)).scheduled;
  }

  async function read(threadId: string): Promise<ThreadLimitState | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
    const { scheduled, retry } = await queued(threadId);
    let limit: ThreadLimitState | null = null;
    if (thread.status === "error" || scheduled || retry) {
      const events = await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "100",
        types: ["provider/error", "system/error", "provider/rateLimits/updated", "turn/started", "turn/completed"],
      });
      limit = rateLimitDetails(events);
      if (limit?.resetsAt === null && /try again at/i.test(limit.message) && thread.environmentId) {
        try {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          const { timeZone } = await host.call(
            "timeZone",
            {},
            {
              hostId: environment.hostId,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
            },
          );
          limit = rateLimitDetails(events, timeZone);
        } catch {
          // Without the provider machine's timezone, keep the manual time picker.
        }
      }
    }
    // bb's retry shows only with a provider limit; retries of other failures are not this warning's business.
    const retryState = retry && limit ? { id: retry.id, sendAt: retry.sendAt, failed: failedState(retry.state) } : null;
    if (!scheduled) return limit && { ...limit, retry: retryState };
    return {
      message: limit?.message ?? "Continue scheduled after the provider limit resets",
      resetsAt: limit?.resetsAt ?? null,
      timeZone: limit?.timeZone ?? null,
      scheduled: { id: scheduled.id, sendAt: scheduled.sendAt!, failed: failedState(scheduled.state) },
      retry: retryState,
    };
  }

  /**
   * A turn that hits the same provider limit while the thread waits on its
   * scheduled Continue, such as a child-completed message bb delivers to a
   * limited parent, says nothing new. Its attention would wake the snooze, so
   * restart the snooze's wake history instead. Only a snooze still matching
   * a pending Continue is kept: a cleared, changed, or failed one is left alone.
   */
  async function keepWaitingOnContinue(threadId: string) {
    if (controller.signal.aborted || lifecycle.readOne(threadId)?.snoozedUntil == null) return;
    try {
      await withLock(threadId, async () => {
        const entry = await scheduledContinue(threadId);
        if (!entry?.sendAt || entry.sendAt <= Date.now() || entry.state !== "scheduled") return;
        const events = await bb.sdk.threads.events.list({
          threadId,
          order: "desc",
          limit: "100",
          types: ["provider/error", "system/error", "provider/rateLimits/updated", "turn/started", "turn/completed"],
        });
        if (!rateLimitDetails(events)) return;
        await lifecycle.withPinParentChange(threadId, async () => {
          const row = lifecycle.readOne(threadId);
          if (row?.snoozedUntil !== entry.sendAt) return;
          lifecycle.write({ ...row, snoozedAt: Date.now() });
        });
      });
    } catch {
      // The thread shows as woken, as it would without this; nothing to undo.
    }
  }

  async function withLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(threadId);
    const pending = (async () => {
      await previous?.catch(() => {});
      return action();
    })();
    locks.set(threadId, pending);
    try {
      return await pending;
    } finally {
      if (locks.get(threadId) === pending) locks.delete(threadId);
    }
  }

  async function snoozeScheduled(threadId: string, sendAt: number) {
    if (sendAt <= Date.now() + 1000) return;
    await lifecycle.withPinParentChange(threadId, async () => {
      if (lifecycle.readOne(threadId)?.snoozedUntil === sendAt) return;
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.pinnedAt !== null) await bb.sdk.threads.unpin({ threadId });
      lifecycle.write({
        threadId,
        settledAt: null,
        settledOverride: null,
        snoozedUntil: sendAt,
        snoozedAt: Date.now(),
      });
    });
  }

  return {
    async getThreadLimits({ keys }: { keys: string[] }) {
      const result: Record<string, ThreadLimitState | null> = {};
      await runThreadTasks([...new Set(keys)], async (threadId) => {
        result[threadId] = await read(threadId);
      });
      return result;
    },
    scheduleLimitContinue({ threadId, sendAt }: { threadId: string; sendAt?: number }) {
      return withLock(threadId, async () => {
        const limit = await read(threadId);
        if (!limit) throw new Error("This thread is no longer stopped by a provider limit");
        const existing = await scheduledContinue(threadId);
        if (existing) {
          if (!failedState(existing.state)) await snoozeScheduled(threadId, existing.sendAt!);
          return {
            ...limit,
            scheduled: { id: existing.id, sendAt: existing.sendAt!, failed: failedState(existing.state) },
          };
        }
        // bb already resends the failed turn; a Continue on top of it would start a second turn.
        if (limit.retry) return limit;
        const now = Date.now();
        const at = sendAt ?? (limit.resetsAt === null ? null : Math.max(now + 1000, limit.resetsAt + 30_000));
        if (at === null) throw new Error("Choose a time because the provider did not report its reset time");
        if (at <= now) throw new Error("Choose a future time");
        if (limit.resetsAt !== null && at < limit.resetsAt) throw new Error("Choose a time after the limit resets");
        const result = await bb.sdk.threads.send({
          threadId,
          input: [{ type: "text", text: "Continue", mentions: [] }],
          mode: "queue-if-active",
          sendAt: at,
          originPluginId: bb.pluginId,
        });
        if (result.delivery !== "queued") throw new Error("BB did not queue the scheduled message");
        try {
          await snoozeScheduled(threadId, at);
        } finally {
          changed();
        }
        return { ...limit, scheduled: { id: result.queuedMessage.id, sendAt: at, failed: false } };
      });
    },
    /** Cancels the sidebar's own scheduled Continue, or bb's queued retry of the limited turn. */
    cancelLimitContinue({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) {
      return withLock(threadId, async () => {
        const { scheduled: entry, retry } = await queued(threadId);
        if (retry?.id === queuedMessageId) {
          if (retry.state === "claimed") throw new Error("bb's retry is already being sent");
          await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId });
          changed();
          return { ok: true as const };
        }
        if (!entry || entry.id !== queuedMessageId) throw new Error("This scheduled Continue is no longer queued");
        if (entry.state === "claimed") throw new Error("The scheduled Continue is already being sent");
        await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId });
        await lifecycle.withPinParentChange(threadId, async () => {
          if (lifecycle.readOne(threadId)?.snoozedUntil === entry.sendAt) lifecycle.clear(threadId);
        });
        changed();
        return { ok: true as const };
      });
    },
  };
}
