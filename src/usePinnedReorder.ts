import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PluginSidebarThread, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { orderPinnedThreads, pinnedNeighbors, sortPinnedThreads } from "./pinned-order";

interface OptimisticOrder {
  ids: readonly string[];
  /** Host order when this request began. Any later host order wins. */
  baseKey: string;
}

interface PinnedReorderApi {
  threads: PluginSidebarThread[];
  ids: string[];
  isReordering: boolean;
  reorder(nextIds: readonly string[], movingId: string): Promise<boolean>;
}

function orderKey(ids: readonly string[]): string {
  return ids.join("\0");
}

/** Optimistic pinned order with one in-flight write and host-truth rollback. */
export function usePinnedReorder(pinnedThreads: readonly PluginSidebarThread[]): PinnedReorderApi {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const baseThreads = useMemo(() => sortPinnedThreads(pinnedThreads), [pinnedThreads]);
  const baseIds = useMemo(() => baseThreads.map((thread) => thread.id), [baseThreads]);
  const baseKey = orderKey(baseIds);
  const [optimistic, setOptimistic] = useState<OptimisticOrder | null>(null);
  const [isReordering, setIsReordering] = useState(false);
  const inFlight = useRef(false);

  // The sidebar hook is live. Once it reports any newer pinned order, stop
  // masking it with our last RPC result and trust the host again.
  useEffect(() => {
    if (!inFlight.current && optimistic && optimistic.baseKey !== baseKey) {
      setOptimistic(null);
    }
  }, [baseKey, optimistic]);

  const orderedThreads = useMemo(
    () => orderPinnedThreads(baseThreads, optimistic?.ids ?? null),
    [optimistic, baseThreads],
  );
  const ids = orderedThreads.map((thread) => thread.id);
  // Optimistic host pins can have no key yet; core cannot reorder against them.
  const eligiblePinnedIds = useMemo(
    () => new Set(baseThreads.filter((thread) => thread.pinSortKey != null).map((thread) => thread.id)),
    [baseThreads],
  );
  // Match bb's pinned roots: a child is excluded only while its parent is pinned.
  const childIds = useMemo(() => {
    return new Set(
      pinnedThreads
        .filter((thread) => thread.parentThreadId !== null && eligiblePinnedIds.has(thread.parentThreadId))
        .map((thread) => thread.id),
    );
  }, [eligiblePinnedIds, pinnedThreads]);

  const reorder = useCallback(
    async (nextIds: readonly string[], movingId: string): Promise<boolean> => {
      if (inFlight.current || !eligiblePinnedIds.has(movingId) || orderKey(nextIds) === orderKey(ids)) return false;
      const neighbors = pinnedNeighbors(
        nextIds.filter((id) => id === movingId || (eligiblePinnedIds.has(id) && !childIds.has(id))),
        movingId,
      );
      inFlight.current = true;
      setIsReordering(true);
      setOptimistic({ ids: [...nextIds], baseKey });

      try {
        const result = await rpc.call("reorderPinned", {
          threadId: movingId,
          ...neighbors,
        });
        setOptimistic({ ids: result.pinnedThreadIds, baseKey });
        return true;
      } catch (error) {
        setOptimistic(null);
        toast.error("Could not reorder pinned thread", {
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      } finally {
        inFlight.current = false;
        setIsReordering(false);
      }
    },
    [baseKey, childIds, eligiblePinnedIds, ids, rpc],
  );

  return { threads: orderedThreads, ids, isReordering, reorder };
}
