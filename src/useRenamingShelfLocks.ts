import { useEffect, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { threadNeedsAttention } from "./child-status";
import type { LifecycleApi } from "./useLifecycle";

export function useRenamingShelfLocks(threads: readonly PluginSidebarThread[], lifecycle: LifecycleApi) {
  const [renamingShelfLocks, setRenamingShelfLocks] = useState<Map<string, "active" | "working" | "inactive">>(
    () => new Map(),
  );
  useEffect(() => {
    const activeIds = new Set(
      threads
        .filter(
          (thread) => !thread.isArchived && lifecycle.shelfFor(thread) === "active" && !threadNeedsAttention(thread),
        )
        .map((thread) => thread.id),
    );
    setRenamingShelfLocks((current) => {
      const next = new Map([...current].filter(([threadId]) => activeIds.has(threadId)));
      return next.size === current.size ? current : next;
    });
  }, [lifecycle, threads]);
  return [renamingShelfLocks, setRenamingShelfLocks] as const;
}
