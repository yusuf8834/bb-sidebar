import { STORAGE_KEYS } from "./lib/storage-keys";
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./contract";
import { useSidebarRead } from "./bb-sdk";
import type { ThreadLifecycleRow } from "./lifecycle";
import { createCachedRpcState } from "./lib/cached-rpc-state";
import { lifecycleRowsCodec } from "./lib/lifecycle-cache-codec";

export interface LifecycleRows {
  rows: ReadonlyMap<string, ThreadLifecycleRow>;
  /**
   * Whether the rows came from the server or its cache. Until then every
   * thread resolves as Active, so work that skips settled threads waits.
   */
  loaded: boolean;
  refresh(): Promise<void>;
}

const lifecycleCache = createCachedRpcState(STORAGE_KEYS.lifecycle.key, lifecycleRowsCodec);
const NO_ROWS: ReadonlyMap<string, ThreadLifecycleRow> = new Map();
// A cold start whose first read failed retries on this beat until one lands.
// bb's cache retries network failures only, and not an HTTP refusal from a
// backend that is still reloading.
const UNLOADED_RETRY_MS = 30_000;

/**
 * The plugin's lifecycle rows, read above everything that classifies threads.
 * The rate-limit provider needs them to skip settled threads, and the inbox
 * needs its limit rows to place snoozed ones, so neither can own this read.
 *
 * bb's query cache rereads them when the server invalidates the lifecycle tag
 * and after a reconnect. The saved copy stands in until the first answer.
 */
export function useLifecycleRows(): LifecycleRows {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [saved] = useState(() => lifecycleCache.read(rpc));
  const { data, refresh } = useSidebarRead("listLifecycle");
  const fresh = useMemo(() => (data ? new Map(data.rows.map((row) => [row.threadId, row] as const)) : null), [data]);
  useEffect(() => {
    if (fresh) lifecycleCache.write(rpc, fresh);
  }, [fresh, rpc]);
  const rows = fresh ?? saved ?? NO_ROWS;
  const loaded = fresh !== null || saved !== null;

  // One policy pass per mounted sidebar gives a freshly opened client current
  // state immediately. The backend coalesces concurrent clients and does the
  // thread and PR work in one batch.
  useEffect(() => {
    void rpc
      .call("evaluateAutoSettle", {})
      .then(({ changedThreadIds }) => {
        if (changedThreadIds.length > 0) void refresh();
      })
      .catch(() => {
        void 0; // A backend generation can briefly lag the app bundle during reload.
        // The scheduled evaluator and its invalidation will reconcile later.
      });
  }, [refresh, rpc]);

  useEffect(() => {
    if (loaded) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, UNLOADED_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [refresh, loaded]);

  return useMemo(() => ({ rows, loaded, refresh }), [rows, loaded, refresh]);
}
