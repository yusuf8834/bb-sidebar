import type { ServerContext } from "./server-context";
import { RATE_LIMITS_CHANNEL, type ThreadLimitState } from "./contract";
import { rateLimitDetails } from "./server-rate-limit-details";
import { runThreadTasks } from "./thread-tasks";
import { portScanContract } from "./port-scan-contract";
import type { createServerLifecycle } from "./server-lifecycle";

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

  async function scheduledContinue(threadId: string) {
    const queue = await bb.sdk.threads.queuedMessages.list({ threadId });
    return queue.find(
      (entry) =>
        entry.originPluginId === bb.pluginId &&
        entry.sendAt !== null &&
        entry.content.length === 1 &&
        entry.content[0]?.type === "text" &&
        entry.content[0].text === "Continue",
    );
  }

  async function read(threadId: string): Promise<ThreadLimitState | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
    const scheduled = await scheduledContinue(threadId);
    let limit: ThreadLimitState | null = null;
    if (thread.status === "error" || scheduled) {
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
    if (!scheduled) return limit;
    return {
      message: limit?.message ?? "Continue scheduled after the provider limit resets",
      resetsAt: limit?.resetsAt ?? null,
      timeZone: limit?.timeZone ?? null,
      scheduled: {
        id: scheduled.id,
        sendAt: scheduled.sendAt!,
        failed: scheduled.state === "failed_exhausted" || scheduled.state === "failed_retrying",
      },
    };
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
          if (existing.state !== "failed_exhausted" && existing.state !== "failed_retrying")
            await snoozeScheduled(threadId, existing.sendAt!);
          return {
            ...limit,
            scheduled: {
              id: existing.id,
              sendAt: existing.sendAt!,
              failed: existing.state === "failed_exhausted" || existing.state === "failed_retrying",
            },
          };
        }
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
    cancelLimitContinue({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) {
      return withLock(threadId, async () => {
        const entry = await scheduledContinue(threadId);
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
