import { useEffect } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { BROWSER_EVENTS } from "./lib/browser-events";
import type { SnoozeCommandRequest } from "./lib/snooze-commands";
import { toast } from "./lib/toast";
import type { LifecycleApi } from "./useLifecycle";

/** Run palette snooze commands through the same actions as the row menu. */
export function useSnoozeCommands(
  threads: readonly PluginSidebarThread[],
  lifecycle: LifecycleApi,
  snoozeThread: (thread: PluginSidebarThread, until: number) => void,
) {
  useEffect(() => {
    const onRequest = (event: Event) => {
      event.preventDefault();
      const request = (event as CustomEvent<SnoozeCommandRequest>).detail;
      const thread = threads.find((candidate) => candidate.id === request.threadId);
      if (!thread) {
        toast.error("This thread is not in the BB Sidebar");
      } else if (request.kind === "unsnooze") {
        if (lifecycle.shelfFor(thread) === "snoozed") void lifecycle.unsnooze(thread.id);
        else toast.message("This thread is not snoozed");
      } else if (!lifecycle.canPark(thread)) {
        toast.error("Wait until this thread stops working to snooze it");
      } else {
        snoozeThread(thread, request.snoozedUntil);
      }
    };
    window.addEventListener(BROWSER_EVENTS.snoozeCommand, onRequest);
    return () => window.removeEventListener(BROWSER_EVENTS.snoozeCommand, onRequest);
  }, [threads, lifecycle, snoozeThread]);
}
