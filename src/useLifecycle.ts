import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRpc,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  type PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { describeReclaim } from "./reclaim";
import { promptToCloseSettledPorts } from "./settled-port-prompt";
import { announcePortsClosed } from "./OpenPorts";
import {
  canPark,
  parkBlocker,
  type ParkBlocker,
  formatSnoozeWakeTime,
  nextWakeDelayMs,
  resolveRowShelf,
  resolveWakeReason,
  sidebarThreadSignals,
  type ThreadShelf,
  waitsForScheduledContinue,
} from "./lifecycle";
import { threadsWithAskingDescendants } from "./child-status";
import { resolveThreadTitlesIn, threadDisplayTitle } from "./inbox";
import { threadTreeIds } from "./thread-tree";
import { useLimitActions } from "./RateLimits";
import type { LifecycleRows } from "./useLifecycleRows";

export interface LifecycleApi {
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  canPark(thread: PluginSidebarThread): boolean;
  parkBlocker(thread: PluginSidebarThread): ParkBlocker | null;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  settledAtFor(thread: PluginSidebarThread): number | null;
  wokeFor(thread: PluginSidebarThread): boolean;
  acknowledgeWake(threadId: string): Promise<boolean>;
  parkedAtFor(thread: PluginSidebarThread): number | null;
  park(threadId: string): Promise<boolean>;
  resume(threadId: string): Promise<boolean>;
  settle(threadId: string): Promise<boolean>;
  unsettle(threadId: string): Promise<boolean>;
  snooze(threadId: string, snoozedUntil: number): Promise<boolean>;
  unsnooze(threadId: string): Promise<boolean>;
}

type LifecycleMutation = "park" | "resume" | "settle" | "unsettle" | "snooze" | "unsnooze" | "acknowledgeWake";
type LifecycleMutationRequest =
  | { method: "snooze"; threadId: string; snoozedUntil: number }
  | { method: "unsettle"; threadId: string; undoToken?: string }
  | {
      method: Exclude<LifecycleMutation, "snooze" | "unsettle">;
      threadId: string;
    };

const SUCCESS_MESSAGE: Record<Exclude<LifecycleMutation, "snooze" | "acknowledgeWake">, string> = {
  park: "Thread parked",
  resume: "Thread returned to the inbox",
  settle: "Thread settled",
  unsettle: "Thread returned to the inbox",
  unsnooze: "Thread woke up",
};

/**
 * How long a parking toast that carries a reclaim reminder stays up.
 *
 * Sonner's four-second default is sized for a confirmation nobody needs to
 * read. "2 terminals left running" is the opposite: it is the one line worth
 * acting on, and it can sit behind a wake time and a session clause. Toasts
 * without a reminder keep the default, so a bare confirmation still gets out
 * of the way.
 */
const PARK_REMINDER_TOAST_MS = 10_000;

const ERROR_MESSAGE: Record<LifecycleMutation, string> = {
  park: "Could not park thread",
  resume: "Could not resume thread",
  settle: "Could not settle thread",
  unsettle: "Could not un-settle thread",
  snooze: "Could not snooze thread",
  unsnooze: "Could not wake thread",
  acknowledgeWake: "Could not dismiss Woke marker",
};

/**
 * Whether another plugin's status on the thread's row runs, such as "Waiting
 * for CI". Rows then offer no Park, Snooze or Settle for it, as for a thread
 * that is working. This guard is the UI's alone: the server, automatic settle
 * and `bb sidebar` never see row statuses, and shelves do not move for it.
 */
export function useRowStatusRuns(threadId: string): boolean {
  return useSidebarThreadRowStatus(threadId)?.tone === "running";
}

/**
 * The thread whose running row status stops a park, snooze or settle, if any.
 * A park or a snooze files one thread, so only its own status counts, as the
 * working guard reads only the thread. A settle files the whole tree, which
 * the server refuses while any thread in it is working.
 */
function runningRowStatusThread(
  threadId: string,
  wholeTree: boolean,
  threads: readonly PluginSidebarThread[],
  rowStatuses: ReadonlyMap<string, PluginSidebarThreadRowStatus>,
): PluginSidebarThread | undefined {
  const live = threads.filter((thread) => !thread.isArchived);
  const ids = new Set(wholeTree ? threadTreeIds(live, threadId) : [threadId]);
  return live.find((thread) => ids.has(thread.id) && rowStatuses.get(thread.id)?.tone === "running");
}

function errorDescription(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  return message.length > 0 ? message : undefined;
}

/**
 * Classifies threads onto shelves from the plugin's own lifecycle rows.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 */
export function useLifecycle(threads: readonly PluginSidebarThread[], lifecycleRows: LifecycleRows): LifecycleApi {
  const recovery = useLimitActions();
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const { rows } = lifecycleRows;
  const [now, setNow] = useState(() => Date.now());
  // Keyed by membership, so the API below keeps its identity across the
  // thread updates that do not change who is waiting on a child.
  const askingParentKey = [...threadsWithAskingDescendants(threads)].sort().join("\n");
  const askingParentIds = useMemo(
    () => new Set(askingParentKey === "" ? [] : askingParentKey.split("\n")),
    [askingParentKey],
  );

  const inFlightThreadIds = useRef(new Set<string>());
  // Read at error time, so the API below keeps its identity across thread updates.
  const latestThreads = useRef(threads);
  latestThreads.current = threads;
  const rowStatuses = useSidebarThreadRowStatuses();
  const latestRowStatuses = useRef(rowStatuses);
  latestRowStatuses.current = rowStatuses;
  const portPromptVersions = useRef(new Map<string, number>());

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const delay = nextWakeDelayMs(
      [...rows.values()].flatMap((row) => (row.snoozedUntil === null ? [] : [row.snoozedUntil])),
      armedAt,
    );
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, rows]);

  return useMemo<LifecycleApi>(() => {
    // A descendant's question counts as the parent's own: it brings the tree
    // back from any shelf, ends a snooze, and blocks parking it again.
    const signalsFor = (thread: PluginSidebarThread) => {
      const signals = sidebarThreadSignals(thread);
      const scheduled = recovery?.rows[thread.id]?.scheduled;
      if (waitsForScheduledContinue(rows.get(thread.id), scheduled, thread.queuedWork, now)) {
        signals.hasQueuedWork = false;
      }
      return askingParentIds.has(thread.id) ? { ...signals, hasPendingInteraction: true } : signals;
    };
    // One mutation per thread at a time. The write publishes on the realtime
    // channel, and that subscription refreshes every client after success.
    const mutate = async (request: LifecycleMutationRequest): Promise<boolean> => {
      const { method, threadId } = request;
      // Every way to shelve a thread ends here, Undo included.
      const running =
        method === "park" || method === "snooze" || method === "settle"
          ? runningRowStatusThread(threadId, method === "settle", latestThreads.current, latestRowStatuses.current)
          : undefined;
      if (running) {
        const status = latestRowStatuses.current.get(running.id)?.label;
        toast.error(ERROR_MESSAGE[method], {
          description: `${threadDisplayTitle(running)} is still running: ${status}`,
        });
        return false;
      }
      if (inFlightThreadIds.current.has(threadId)) return false;
      inFlightThreadIds.current.add(threadId);
      const portPromptVersion = (portPromptVersions.current.get(threadId) ?? 0) + 1;
      portPromptVersions.current.set(threadId, portPromptVersion);
      toast.dismiss(`settled-ports:${threadId}`);
      let parkReminder: string | undefined;
      let settleUndoToken: string | undefined;
      // An unsnooze clears the row server-side, so its wake time has to be
      // captured before the RPC; Undo re-snoozes with this absolute time to
      // restore the exact schedule that was cancelled.
      const unsnoozeWakeAt = method === "unsnooze" ? (rows.get(threadId)?.snoozedUntil ?? null) : null;
      try {
        if (method === "snooze") {
          const { reclaim } = await rpc.call("snooze", {
            threadId,
            snoozedUntil: request.snoozedUntil,
          });
          parkReminder = describeReclaim(reclaim);
        } else if (method === "settle") {
          const { reclaim, undoToken } = await rpc.call("settle", { threadId });
          settleUndoToken = undoToken;
          parkReminder = describeReclaim(reclaim);
        } else if (method === "park") {
          const { reclaim } = await rpc.call("park", { threadId });
          parkReminder = describeReclaim(reclaim);
        } else if (method === "unsettle") {
          await rpc.call("unsettle", { threadId, ...(request.undoToken ? { undoToken: request.undoToken } : {}) });
        } else {
          await rpc.call(method, { threadId });
        }
      } catch (error) {
        const description = errorDescription(error);
        toast.error(ERROR_MESSAGE[method], {
          // The server names threads by their stored titles.
          description: description && resolveThreadTitlesIn(description, latestThreads.current),
        });
        return false;
      } finally {
        inFlightThreadIds.current.delete(threadId);
      }

      if (method === "park" || method === "resume") {
        toast.success(SUCCESS_MESSAGE[method], {
          description: parkReminder,
          duration: parkReminder === undefined ? undefined : PARK_REMINDER_TOAST_MS,
          action: {
            label: "Undo",
            onClick: () =>
              void mutate({
                method: method === "park" ? "resume" : "park",
                threadId,
              }),
          },
        });
      } else if (method === "snooze") {
        // The wake time is the headline; the reminder follows it, because a
        // snooze releases the same resources a settle does.
        const wakes = `Wakes ${formatSnoozeWakeTime(request.snoozedUntil)}`;
        toast.success("Thread snoozed", {
          description: parkReminder === undefined ? wakes : `${wakes} · ${parkReminder}`,
          duration: parkReminder === undefined ? undefined : PARK_REMINDER_TOAST_MS,
          action: {
            label: "Undo",
            onClick: () => void mutate({ method: "unsnooze", threadId }),
          },
        });
      } else if (method === "settle") {
        void promptToCloseSettledPorts(
          threadId,
          () => rpc.call("getThreadPorts", { threadId }),
          // Whatever the answer, the row's plug may now be stale.
          (ports) =>
            rpc.call("closeThreadPorts", { threadId, ports }).finally(() => {
              const environmentId = latestThreads.current.find((thread) => thread.id === threadId)?.environment?.id;
              if (environmentId) announcePortsClosed([environmentId]);
            }),
          () => portPromptVersions.current.get(threadId) === portPromptVersion,
        );
        // Undo restores lifecycle rows captured by this action, including the
        // children's previous shelves. Released resources and pins stay released.
        toast.success(SUCCESS_MESSAGE.settle, {
          description: parkReminder,
          duration: parkReminder === undefined ? undefined : PARK_REMINDER_TOAST_MS,
          action: settleUndoToken
            ? {
                label: "Undo",
                onClick: () => void mutate({ method: "unsettle", threadId, undoToken: settleUndoToken }),
              }
            : undefined,
        });
      } else if (method === "unsettle") {
        // A snapshot Undo is final: a generic redo would overwrite children
        // deliberately preserved by the selective restore.
        toast.success(request.undoToken ? "Settling undone" : SUCCESS_MESSAGE.unsettle, {
          action: request.undoToken
            ? undefined
            : {
                label: "Undo",
                onClick: () => void mutate({ method: "settle", threadId }),
              },
        });
      } else if (method === "unsnooze") {
        // Undo is only offered while the captured wake time is still ahead;
        // a row whose snooze already elapsed has no schedule left to restore.
        const undoWakeAt = unsnoozeWakeAt !== null && unsnoozeWakeAt > Date.now() ? unsnoozeWakeAt : null;
        toast.success(SUCCESS_MESSAGE.unsnooze, {
          action:
            undoWakeAt === null
              ? undefined
              : {
                  label: "Undo",
                  onClick: () =>
                    void mutate({
                      method: "snooze",
                      threadId,
                      snoozedUntil: undoWakeAt,
                    }),
                },
        });
      }
      return true;
    };
    return {
      shelfFor: (thread) => resolveRowShelf(rows.get(thread.id), signalsFor(thread), now, thread.isPinned),
      canPark: (thread) => canPark(signalsFor(thread)),
      parkBlocker: (thread) => parkBlocker(signalsFor(thread)),
      wakeAtFor: (thread) => rows.get(thread.id)?.snoozedUntil ?? null,
      parkedAtFor: (thread) => rows.get(thread.id)?.parkedAt ?? null,
      park: (threadId) => mutate({ method: "park", threadId }),
      resume: (threadId) => mutate({ method: "resume", threadId }),
      settledAtFor: (thread) => rows.get(thread.id)?.settledAt ?? null,
      wokeFor: (thread) => resolveWakeReason(rows.get(thread.id), signalsFor(thread), now) !== null,
      acknowledgeWake: (threadId) => mutate({ method: "acknowledgeWake", threadId }),
      settle: (threadId) => mutate({ method: "settle", threadId }),
      unsettle: (threadId) => mutate({ method: "unsettle", threadId }),
      unsnooze: (threadId) => mutate({ method: "unsnooze", threadId }),
      snooze: (threadId, snoozedUntil) => mutate({ method: "snooze", threadId, snoozedUntil }),
    };
  }, [askingParentIds, now, rows, rpc, recovery]);
}
