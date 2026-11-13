import { useCallback, useRef } from "react";
import { useBbNavigate, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { LifecycleApi } from "./useLifecycle";
import { useSnoozeCommands } from "./useSnoozeCommands";

/**
 * The row actions that file a thread away, plus the palette commands that run
 * through them. Leaving the open thread for a shelf lands on New thread.
 */
export function useShelveActions({
  threads,
  lifecycle,
  activeThreadId,
  onNavigate,
}: {
  threads: readonly PluginSidebarThread[];
  lifecycle: LifecycleApi;
  activeThreadId: string | null;
  onNavigate: () => void;
}) {
  const navigate = useBbNavigate();
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  const parkActiveThread = useCallback(
    async (thread: PluginSidebarThread, mutation: () => Promise<boolean>) => {
      const parked = await mutation();
      if (!parked || activeThreadIdRef.current !== thread.id) return;

      // Never land on a thread the user did not pick.
      navigate.toCompose({ projectId: thread.projectId, focusPrompt: true });
      onNavigate();
    },
    [navigate, onNavigate],
  );

  const parkThread = useCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.park(thread.id)),
    [parkActiveThread, lifecycle],
  );
  const settleThread = useCallback(
    (thread: PluginSidebarThread) => void parkActiveThread(thread, () => lifecycle.settle(thread.id)),
    [parkActiveThread, lifecycle],
  );
  const snoozeThread = useCallback(
    (thread: PluginSidebarThread, until: number) =>
      void parkActiveThread(thread, () => lifecycle.snooze(thread.id, until)),
    [parkActiveThread, lifecycle],
  );
  useSnoozeCommands(threads, lifecycle, snoozeThread);

  return { parkThread, settleThread, snoozeThread };
}
