import { STORAGE_KEYS } from "./lib/storage-keys";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./contract";
import { LIFECYCLE_CHANNEL } from "./realtime-channels";
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
// A cold start whose first read failed retries on this beat until one lands.
const UNLOADED_RETRY_MS = 30_000;

/**
 * The plugin's lifecycle rows, read above everything that classifies threads.
 * The rate-limit provider needs them to skip settled threads, and the inbox
 * needs its limit rows to place snoozed ones, so neither can own this read.
 */
export function useLifecycleRows(): LifecycleRows {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [state, setState] = useState(() => {
    const cached = lifecycleCache.read(rpc);
    return { rows: cached ?? new Map<string, ThreadLifecycleRow>(), loaded: cached !== null };
  });
  // Responses can land out of order (a mutation's refresh racing a realtime
  // one), and an older list would silently restore state the user just
  // changed. Only the newest request may write.
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listLifecycle", {});
      if (seq !== requestSeq.current) return;
      const rows = new Map(result.rows.map((row) => [row.threadId, row] as const));
      lifecycleCache.write(rpc, rows);
      setState({ rows, loaded: true });
    } catch {
      void 0; // Keep the last known rows during a backend reload or transient RPC
      // failure. The next realtime signal, mount, or unloaded retry tries again.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        // The scheduled evaluator and realtime refresh will reconcile later.
      });
  }, [refresh, rpc]);

  useRealtime(LIFECYCLE_CHANNEL, () => {
    void refresh();
  });

  useEffect(() => {
    if (state.loaded) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, UNLOADED_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [refresh, state.loaded]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
