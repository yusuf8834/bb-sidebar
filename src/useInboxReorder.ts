import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type PluginSidebarThread,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import { orderInboxThreads } from "./pinned-order";

export interface InboxReorderApi {
  threads: PluginSidebarThread[];
  ids: string[];
  isReordering: boolean;
  reorder(nextIds: readonly string[]): Promise<boolean>;
}

function orderKey(ids: readonly string[]): string {
  return ids.join("\0");
}

/** Durable, optimistic inbox ordering backed by the plugin database. */
export function useInboxReorder(
  inboxThreads: readonly PluginSidebarThread[],
): InboxReorderApi {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [storedIds, setStoredIds] = useState<readonly string[] | null>(null);
  const [optimisticIds, setOptimisticIds] = useState<
    readonly string[] | null
  >(null);
  const [isReordering, setIsReordering] = useState(false);
  const inFlight = useRef(false);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listInboxOrder", {});
      if (seq === requestSeq.current) {
        setStoredIds(result.inboxThreadIds);
      }
    } catch {
      // The default newest-first list remains fully usable if a backend reload
      // briefly races this frontend generation.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("inbox-order", () => {
    void refresh();
  });

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
        setStoredIds(result.inboxThreadIds);
        setOptimisticIds(null);
        return true;
      } catch (error) {
        setOptimisticIds(null);
        toast.error("Could not reorder inbox thread", {
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      } finally {
        inFlight.current = false;
        setIsReordering(false);
      }
    },
    [ids, rpc],
  );

  return { threads, ids, isReordering, reorder };
}
