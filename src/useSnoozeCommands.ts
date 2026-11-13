import { useEffect } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { filterByProjects, shelfRowIds, threadDisplayTitle, visibleInboxThreads } from "./inbox";
import { BROWSER_EVENTS } from "./lib/browser-events";
import type { SnoozeCommandRequest } from "./lib/snooze-commands";
import { toast } from "./lib/toast";
import type { ParkBlocker } from "./lifecycle";
import type { LifecycleApi } from "./useLifecycle";

// The live work that keeps the row menu from offering Snooze, in the
// sidebar's own words for it.
const BLOCKED: Record<ParkBlocker, string> = {
  working: "is still working",
  question: "needs you",
  queued: "has a queued message",
};

/** Run palette snooze commands through the same actions as the row menu. */
export function useSnoozeCommands(
  threads: readonly PluginSidebarThread[],
  scope: readonly string[],
  lifecycle: LifecycleApi,
  snoozeThread: (thread: PluginSidebarThread, until: number) => void,
) {
  useEffect(() => {
    const onRequest = (event: Event) => {
      event.preventDefault();
      const request = (event as CustomEvent<SnoozeCommandRequest>).detail;
      // The threads the sidebar shows, placed into rows as it places them.
      const shown = filterByProjects(visibleInboxThreads(threads), scope);
      const thread = shown.find((candidate) => candidate.id === request.threadId);
      if (!thread) {
        toast.error("This thread is not in the BB Sidebar");
        return;
      }
      // A child has no shelf of its own while its parent's row carries it, so
      // it goes wherever that row goes and its menu offers no Snooze. Name the
      // row, as `bb sidebar resume` does.
      const rowId = shelfRowIds(shown).get(thread.id) ?? thread.id;
      const row = shown.find((candidate) => candidate.id === rowId) ?? thread;
      const title = threadDisplayTitle(thread);
      const rowTitle = threadDisplayTitle(row);
      if (request.kind === "unsnooze") {
        if (lifecycle.shelfFor(row) !== "snoozed") toast.message("This thread is not snoozed");
        else if (row !== thread) {
          toast.error("Could not wake thread", {
            description: `${title} is snoozed with ${rowTitle}, the thread it is nested under. Wake ${rowTitle} to wake the whole tree.`,
          });
        } else void lifecycle.unsnooze(thread.id);
      } else if (row !== thread) {
        toast.error("Could not snooze thread", {
          description: `${title} is nested under ${rowTitle}. Snooze ${rowTitle} to snooze the whole tree.`,
        });
      } else if (lifecycle.shelfFor(thread) === "snoozed") {
        // The Snoozed row's menu offers only the way back.
        toast.message("This thread is already snoozed");
      } else {
        const blocker = lifecycle.parkBlocker(thread);
        if (blocker) toast.error("Could not snooze thread", { description: `${title} ${BLOCKED[blocker]}` });
        else snoozeThread(thread, request.snoozedUntil);
      }
    };
    window.addEventListener(BROWSER_EVENTS.snoozeCommand, onRequest);
    return () => window.removeEventListener(BROWSER_EVENTS.snoozeCommand, onRequest);
  }, [threads, scope, lifecycle, snoozeThread]);
}
