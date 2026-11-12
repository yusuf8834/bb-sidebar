import { useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { portScanEnvironments, settledThreadIds } from "./live-threads";
import type { PortScanScope } from "./OpenPorts";
import type { LifecycleRows } from "./useLifecycleRows";

/**
 * Which threads the recurring lookups cover: null until the lifecycle rows
 * are known, since every thread would count as live before then. The port
 * scope keeps its identity until its workspaces change, so a thread update
 * does not rerender every port consumer.
 */
export function useLiveThreads(
  threads: readonly PluginSidebarThread[],
  { loaded, rows }: LifecycleRows,
): { settled: ReadonlySet<string> | null; portScope: PortScanScope } {
  const settled = useMemo(() => (loaded ? settledThreadIds(threads, rows, Date.now()) : null), [loaded, rows, threads]);
  const portKey = useMemo(() => {
    if (settled === null) return null;
    const { live, settledOnly } = portScanEnvironments(threads, settled);
    return JSON.stringify([live, [...settledOnly].sort()]);
  }, [settled, threads]);
  const portScope = useMemo(() => {
    if (portKey === null) return null;
    const [live, settledOnly] = JSON.parse(portKey) as [string[], string[]];
    return { live, settledOnly: new Set(settledOnly) };
  }, [portKey]);
  return { settled, portScope };
}
