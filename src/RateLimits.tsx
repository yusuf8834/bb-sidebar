import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract, ThreadRecoveryState } from "./contract";
import { RATE_LIMITS_CHANNEL } from "./realtime-channels";
import { errorDetail, toast } from "./lib/toast";
import { useOnDemandLookups } from "./useOnDemandLookups";
import { limitOf } from "./rate-limit-labels";

type LimitRows = Record<string, ThreadRecoveryState | null>;
const RateLimitsContext = createContext<{
  rows: LimitRows;
  pending: ReadonlySet<string>;
  schedule: (threadId: string, sendAt?: number) => Promise<boolean>;
  /** `retry` names bb's queued retry, which the server cancels the same way. */
  cancel: (threadId: string, queuedMessageId: string, retry?: boolean) => Promise<boolean>;
  /** Looks up a settled thread, which the recurring refresh skips. */
  lookUp: (threadId: string) => void;
} | null>(null);

function mayHaveLimit(thread: PluginSidebarThread) {
  return !thread.isArchived && (thread.status === "error" || thread.queuedWork !== "none");
}

/**
 * Provider limits, and bb's queued retries of failed turns, for threads that
 * are errored or have queued work. The 30s
 * poll, realtime pings and reconnects cover live threads only; a settled one
 * is looked up when the user looks at it. `settledThreadIds` is null until
 * the lifecycle rows are known, and nothing recurs before then, because every
 * thread would otherwise count as live for one full lookup.
 */
export function RateLimitsProvider({
  threads,
  settledThreadIds,
  children,
}: {
  threads: readonly PluginSidebarThread[];
  settledThreadIds: ReadonlySet<string> | null;
  children: ReactNode;
}) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const connection = useRealtimeConnectionState();
  const [rows, setRows] = useState<LimitRows>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const mutations = useRef(new Set<string>());
  const request = useRef(0);
  const signature = JSON.stringify(
    settledThreadIds === null
      ? []
      : threads
          .filter((thread) => mayHaveLimit(thread) && !settledThreadIds.has(thread.id))
          .map((thread) => [
            thread.id,
            thread.status,
            thread.queuedWork,
            thread.status === "error" ? thread.updatedAt : 0,
          ]),
  );
  const keys = useMemo(() => (JSON.parse(signature) as [string, ...unknown[]][]).map(([id]) => id), [signature]);
  const settledKey = threads
    .filter((thread) => mayHaveLimit(thread) && settledThreadIds?.has(thread.id))
    .map((thread) => thread.id)
    .join("\n");
  const settledKeys = useMemo(() => new Set(settledKey === "" ? [] : settledKey.split("\n")), [settledKey]);
  const fetchOne = useCallback(
    async (threadId: string) => (await rpc.call("getThreadLimits", { keys: [threadId] }))[threadId] ?? null,
    [rpc],
  );
  const onDemand = useOnDemandLookups(fetchOne, settledKeys);
  // A ping during a refresh waits for it and then runs one more, instead of adding a concurrent request.
  const inFlight = useRef(0);
  const pingQueued = useRef(false);
  const latestRefresh = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    const seq = ++request.current;
    if (keys.length === 0) {
      setRows({});
      return;
    }
    inFlight.current += 1;
    try {
      const result: LimitRows = {};
      for (let offset = 0; offset < keys.length; offset += 1000) {
        Object.assign(result, await rpc.call("getThreadLimits", { keys: keys.slice(offset, offset + 1000) }));
      }
      if (seq === request.current)
        setRows((previous) =>
          Object.fromEntries(keys.map((id) => [id, id in result ? result[id] : (previous[id] ?? null)])),
        );
    } catch {
      // Preserve the last known warning through a plugin reload or transient disconnect.
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0 && pingQueued.current) {
        pingQueued.current = false;
        void latestRefresh.current();
      }
    }
  }, [rpc, keys]);
  useEffect(() => {
    latestRefresh.current = refresh;
    void refresh();
    const timer =
      keys.length > 0
        ? window.setInterval(() => {
            if (document.visibilityState !== "hidden") void refresh();
          }, 30_000)
        : undefined;
    return () => {
      request.current += 1;
      pingQueued.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, keys]);
  useRealtime(RATE_LIMITS_CHANNEL, () => {
    if (inFlight.current > 0) pingQueued.current = true;
    else void refresh();
  });
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  const mutate = useCallback(
    async (threadId: string, action: () => Promise<void>, failure = "Could not update scheduled Continue") => {
      if (mutations.current.has(threadId)) return false;
      mutations.current.add(threadId);
      setPending(new Set(mutations.current));
      request.current += 1;
      try {
        await action();
        return true;
      } catch (error) {
        toast.error(failure, { description: errorDetail(error) });
        return false;
      } finally {
        mutations.current.delete(threadId);
        setPending(new Set(mutations.current));
      }
    },
    [],
  );
  const schedule = useCallback(
    (threadId: string, sendAt?: number) =>
      mutate(threadId, async () => {
        const limit = await rpc.call("scheduleLimitContinue", {
          threadId,
          ...(sendAt === undefined ? {} : { sendAt }),
        });
        request.current += 1;
        setRows((previous) => ({ ...previous, [threadId]: limit }));
      }),
    [rpc, mutate],
  );
  const cancel = useCallback(
    (threadId: string, queuedMessageId: string, retry = false) =>
      mutate(
        threadId,
        async () => {
          await rpc.call("cancelLimitContinue", { threadId, queuedMessageId });
          request.current += 1;
          setRows((previous) => {
            const limit = limitOf(previous[threadId]);
            const next =
              limit?.retry?.id === queuedMessageId ? { ...limit, retry: null } : limit && { ...limit, scheduled: null };
            return { ...previous, [threadId]: next ?? null };
          });
          await refresh();
        },
        retry ? "Could not cancel bb's retry" : undefined,
      ),
    [rpc, mutate, refresh],
  );
  const merged = useMemo(
    () => (onDemand.values.size === 0 ? rows : { ...Object.fromEntries(onDemand.values), ...rows }),
    [onDemand.values, rows],
  );
  const { lookUp } = onDemand;
  const value = useMemo(
    () => ({ rows: merged, pending, schedule, cancel, lookUp }),
    [merged, pending, schedule, cancel, lookUp],
  );
  return <RateLimitsContext.Provider value={value}>{children}</RateLimitsContext.Provider>;
}

export function useThreadLimit(thread: PluginSidebarThread) {
  const context = useContext(RateLimitsContext);
  const limit = limitOf(context?.rows[thread.id]);
  if (!mayHaveLimit(thread)) return null;
  return limit;
}

/**
 * bb's queued retry of the thread's failed turn, limit or not. The row reads
 * it only through `retryingStatus`, which checks it against the thread itself.
 */
export function useThreadRetry(thread: PluginSidebarThread) {
  const context = useContext(RateLimitsContext);
  if (!mayHaveLimit(thread)) return null;
  return context?.rows[thread.id]?.retry ?? null;
}

export function useLimitActions() {
  return useContext(RateLimitsContext);
}
