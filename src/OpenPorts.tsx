import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { UrlLink, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { toast } from "./lib/toast";
import type { bbSidebarRpcContract, OpenPort } from "./contract";
import { portsByEnvironment } from "./open-ports";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { portBrowserUrl } from "./port-links";
import { usePortLinkHost } from "./PortLinkSettings";

const OpenPortsContext = createContext<ReadonlyMap<string, readonly OpenPort[]>>(new Map());
// Separate from the ports, so a consumer that only asks for a rescan never
// rerenders when the list changes.
const RefreshOpenPortsContext = createContext<() => void>(() => {});

function samePorts(left: ReadonlyMap<string, readonly OpenPort[]>, right: ReadonlyMap<string, readonly OpenPort[]>) {
  if (left.size !== right.size) return false;
  return [...left].every(([environmentId, ports]) => {
    const other = right.get(environmentId);
    return (
      other?.length === ports.length &&
      ports.every((port, index) => {
        const candidate = other[index];
        return (
          Object.keys(port).length === Object.keys(candidate).length &&
          Object.entries(port).every(([key, value]) => candidate[key as keyof OpenPort] === value)
        );
      })
    );
  });
}

export function OpenPortsProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [ports, setPorts] = useState<ReadonlyMap<string, readonly OpenPort[]>>(new Map());
  const refreshRef = useRef<() => void>(() => {});
  const refreshNow = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const isHidden = () => document.visibilityState === "hidden";
    let timer: ReturnType<typeof setTimeout> | undefined;
    function publish(next: ReadonlyMap<string, readonly OpenPort[]>) {
      if (!disposed) setPorts((previous) => (samePorts(previous, next) ? previous : next));
    }
    async function refresh() {
      if (disposed || inFlight || isHidden()) return;
      inFlight = true;
      try {
        const snapshot = await rpc.call("getOpenPorts", {});
        publish(portsByEnvironment(snapshot));
      } catch {
        // An unavailable scanner must not leave stale indicators behind.
        publish(new Map());
      } finally {
        inFlight = false;
        if (!disposed && !isHidden()) timer = setTimeout(refresh, 10_000);
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (!isHidden()) void refresh();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    refreshRef.current = () => {
      clearTimeout(timer);
      void refresh();
    };
    void refresh();
    return () => {
      disposed = true;
      refreshRef.current = () => {};
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [rpc]);

  return (
    <RefreshOpenPortsContext.Provider value={refreshNow}>
      <OpenPortsContext.Provider value={ports}>{children}</OpenPortsContext.Provider>
    </RefreshOpenPortsContext.Provider>
  );
}

function useThreadPorts(thread: PluginSidebarThread) {
  const byEnvironment = useContext(OpenPortsContext);
  return thread.environment?.id ? byEnvironment.get(thread.environment.id) : undefined;
}

export function OpenPortDetails({ thread }: { thread: PluginSidebarThread }) {
  const ports = useThreadPorts(thread);
  const localHostId = usePortLinkHost();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!ports?.length) return null;
  const scrolls = ports.length > 4;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs font-normal leading-4 text-muted-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((current) => !current);
        }}
        className="pointer-events-auto flex items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="Plug" className="size-3.5 shrink-0" aria-hidden />
        <span>Workspace ports ({ports.length})</span>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="ml-auto size-3 shrink-0" aria-hidden />
      </button>
      {expanded ? (
        <div
          id={listId}
          role={scrolls ? "region" : undefined}
          aria-label={scrolls ? "Workspace port list" : undefined}
          tabIndex={scrolls ? 0 : undefined}
          data-port-scroll={scrolls ? "" : undefined}
          className={
            scrolls
              ? "pointer-events-auto flex max-h-[min(12rem,30dvh)] flex-col gap-1.5 overflow-y-auto rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              : "flex flex-col gap-1.5"
          }
        >
          {ports.map((port) => {
            const url = portBrowserUrl(port, thread.host?.id, localHostId);
            return (
              <div key={port.port} className="flex min-w-0 items-start gap-1.5 pl-5 text-xs leading-4">
                <div className="min-w-0 flex-1">
                  <div className="break-words">
                    {url ? (
                      <UrlLink
                        href={url}
                        aria-label={`Open port ${port.port}`}
                        onClick={(event) => event.stopPropagation()}
                        className="pointer-events-auto rounded-sm underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        :{port.port}
                      </UrlLink>
                    ) : (
                      <span>:{port.port}</span>
                    )}{" "}
                    {port.service ?? port.container ?? port.processName ?? "TCP listener"}
                  </div>
                  <div className="break-all text-[11px] text-muted-foreground">
                    {port.address ? `${port.address} · ` : ""}
                    {port.source === "docker"
                      ? `Docker${port.container ? ` · ${port.container}` : ""}`
                      : port.pid
                        ? `PID ${port.pid}`
                        : "TCP"}
                  </div>
                </div>
                {port.source === "process" && port.pid && port.pid > 1 ? (
                  <StopPortButton threadId={thread.id} port={port.port} pid={port.pid} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const CONFIRM_WINDOW_MS = 4_000;

/**
 * Stopping a process is not undoable, so the first press only arms the button
 * and a second press within a few seconds sends the shutdown request.
 */
function StopPortButton({ threadId, port, pid }: { threadId: string; port: number; pid: number }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const refreshPorts = useContext(RefreshOpenPortsContext);
  const [state, setState] = useState<"idle" | "confirm" | "stopping">("idle");
  useEffect(() => {
    if (state !== "confirm") return;
    const timer = setTimeout(() => setState("idle"), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function stop() {
    setState("stopping");
    try {
      const result = await rpc.call("stopWorkspacePort", { threadId, port: { port, pid } });
      if (result.failed.length) {
        toast.error(`Could not stop the process on :${port}`, {
          description: `PID ${pid} refused the shutdown request.`,
        });
      } else if (result.signalled.length) {
        toast.success(`Stop requested for :${port}`, {
          description: `PID ${pid} received a graceful shutdown request. Any other ports it serves close too.`,
        });
      } else {
        toast.message(`Nothing is listening on :${port} as PID ${pid} anymore`);
      }
    } catch (error) {
      toast.error(`Could not stop the process on :${port}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setState("idle");
      refreshPorts();
    }
  }

  const confirming = state === "confirm";
  return (
    <button
      type="button"
      aria-label={confirming ? `Confirm stopping PID ${pid} on port ${port}` : `Stop process on port ${port}`}
      title={confirming ? "Click again to stop" : `Stop PID ${pid}`}
      disabled={state === "stopping"}
      onClick={(event) => {
        event.stopPropagation();
        if (state === "idle") setState("confirm");
        else if (confirming) void stop();
      }}
      className={cn(
        "pointer-events-auto flex h-4 shrink-0 items-center gap-1 rounded-sm px-0.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
        confirming ? "text-destructive" : "text-muted-foreground/70 hover:text-destructive",
      )}
    >
      <Icon
        name={state === "stopping" ? "Loading" : "StopCircle"}
        className={cn("size-3", state === "stopping" && "animate-spin")}
        aria-hidden
      />
      {confirming ? "Stop" : null}
    </button>
  );
}

export function OpenPortsIndicator({ thread }: { thread: PluginSidebarThread }) {
  const ports = useThreadPorts(thread);
  if (!ports?.some((port) => port.ownerThreadId === thread.id)) return null;
  return (
    <span
      role="img"
      aria-label="Open ports started by this thread"
      className="pointer-events-none relative flex shrink-0 items-center text-muted-foreground/60"
    >
      <Icon name="Plug" aria-hidden className="size-3" />
    </span>
  );
}
