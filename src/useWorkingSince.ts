import { createContext, useContext, useEffect, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  EMPTY_WORKING_SINCE,
  readWorkingSince,
  reconcileWorkingSince,
  writeWorkingSince,
  type WorkingSince,
} from "./working-since";

/**
 * Handed down by context rather than props: the status slot sits under cards
 * and slim rows alike, and each would otherwise thread one more value through
 * three layers to reach it.
 */
export const WorkingSinceContext = createContext<WorkingSince>(EMPTY_WORKING_SINCE);

export function useWorkingSinceContext(): WorkingSince {
  return useContext(WorkingSinceContext);
}

/**
 * Track when each thread in the list started its current run of work.
 *
 * Only a loaded list is evidence that a thread stopped: while bb is still
 * loading, or after a failed load, the list is empty or stale, and
 * reconciling against it would clear every stamp, so a reload would restart
 * every "Working · 5m" from zero.
 */
export function useWorkingSince(
  threads: readonly PluginSidebarThread[],
  status: "error" | "loading" | "ready",
): WorkingSince {
  const [workingSince, setWorkingSince] = useState<WorkingSince>(readWorkingSince);
  useEffect(() => {
    if (status !== "ready") return;
    setWorkingSince((previous) => reconcileWorkingSince(previous, threads, Date.now()));
  }, [threads, status]);
  useEffect(() => {
    if (workingSince === EMPTY_WORKING_SINCE) return;
    writeWorkingSince(workingSince);
  }, [workingSince]);
  return workingSince;
}
