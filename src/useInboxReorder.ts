import { STORAGE_KEYS } from "./lib/storage-keys";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PluginSidebarThread, useRpc } from "@get-bb/plugin-sdk/app";
import { errorDetail, toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { useSidebarRead } from "./bb-sdk";
import { orderInboxThreads } from "./pinned-order";
import { createCachedRpcState } from "./lib/cached-rpc-state";
import { inboxOrderCodec } from "./lib/inbox-order-codec";

const orderCache = createCachedRpcState(STORAGE_KEYS.inboxOrder.key, inboxOrderCodec);

interface InboxReorderApi {
  threads: PluginSidebarThread[];
  ids: string[];
  // False until a saved order, cached or fetched, is known.
  loaded: boolean;
  isReordering: boolean;
  reorder(nextIds: readonly string[]): Promise<boolean>;
}

function orderKey(ids: readonly string[]): string {
  return ids.join("\0");
}

/** Durable, optimistic inbox ordering backed by the plugin database. */
export function useInboxReorder(inboxThreads: readonly PluginSidebarThread[]): InboxReorderApi {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [saved] = useState(() => orderCache.read(rpc));
  const { data, error, refresh } = useSidebarRead("listInboxOrder");
  const serverIds = data?.inboxThreadIds;
  // The order this client wrote. A read already in flight when the write
  // lands may predate it, so the written order stands until a read started
  // after the write answers (`reread`), or for good if that read fails.
  const [written, setWritten] = useState<{ ids: readonly string[]; reread: boolean } | null>(null);
  const [optimisticIds, setOptimisticIds] = useState<readonly string[] | null>(null);
  const [isReordering, setIsReordering] = useState(false);
  const inFlight = useRef(false);
  const loaded = useRef(false);
  loaded.current = serverIds !== undefined;
  const storedIds = written?.ids ?? serverIds ?? saved;

  useEffect(() => {
    if (written?.reread && error === null) setWritten(null);
  }, [written, error, serverIds]);

  useEffect(() => {
    const current = written?.ids ?? serverIds;
    if (current) orderCache.write(rpc, [...current]);
  }, [written, serverIds, rpc]);

  const confirmWrite = useCallback(
    async (ids: readonly string[], firstLoad: boolean) => {
      // With data loaded, a refetch cancels a read in flight and starts anew.
      // A first load in flight is joined instead, so read once more after it.
      await refresh();
      if (firstLoad) await refresh();
      setWritten((current) => (current?.ids === ids ? { ids, reread: true } : current));
    },
    [refresh],
  );

  const threads = useMemo(
    () => orderInboxThreads(inboxThreads, optimisticIds ?? storedIds),
    [inboxThreads, optimisticIds, storedIds],
  );
  const ids = threads.map((thread) => thread.id);

  const reorder = useCallback(
    async (nextIds: readonly string[]): Promise<boolean> => {
      if (inFlight.current || orderKey(nextIds) === orderKey(ids)) return false;
      inFlight.current = true;
      setIsReordering(true);
      setOptimisticIds([...nextIds]);

      try {
        const result = await rpc.call("reorderInbox", {
          inboxThreadIds: [...nextIds],
        });
        const ids = result.inboxThreadIds;
        setWritten({ ids, reread: false });
        setOptimisticIds(null);
        void confirmWrite(ids, !loaded.current);
        return true;
      } catch (error) {
        setOptimisticIds(null);
        void refresh();
        toast.error("Could not reorder inbox thread", { description: errorDetail(error) });
        return false;
      } finally {
        inFlight.current = false;
        setIsReordering(false);
      }
    },
    [confirmWrite, ids, refresh, rpc],
  );

  return { threads, ids, loaded: storedIds !== null, isReordering, reorder };
}
