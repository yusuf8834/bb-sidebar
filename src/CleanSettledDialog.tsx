import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { experimental_useSidebarThreadActions as useSidebarThreadActions, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { usePortalScopeProps } from "./lib/portal-scope";
import type { bbSidebarRpcContract, SettledCleanupPreview, SettledCleanupResult } from "./server";

export function CleanSettledDialog({ threadIds, onNavigate }: { threadIds: string[]; onNavigate: () => void }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const threadActions = useSidebarThreadActions();
  const portalScope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SettledCleanupPreview | null>(null);
  const [result, setResult] = useState<SettledCleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const latestThreadIds = useRef(threadIds);
  latestThreadIds.current = threadIds;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setResult(null);
    setError(null);
    setBusy(true);
    void rpc.call("previewSettledCleanup", { threadIds: latestThreadIds.current }).then(
      (next) => { if (!cancelled) setPreview(next); },
      (reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); },
    ).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, rpc, refreshKey]);

  const clean = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await rpc.call("cleanSettled", { token: preview.token }));
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const terminalCount = preview?.threads.reduce((sum, thread) => sum + thread.terminalCount, 0) ?? 0;
  const portCount = preview?.threads.reduce((sum, thread) => sum + thread.ports.length, 0) ?? 0;
  const previewCounts = [
    terminalCount > 0 ? `${terminalCount} ${terminalCount === 1 ? "terminal" : "terminals"} to close` : null,
    portCount > 0 ? `${portCount} listening ${portCount === 1 ? "port" : "ports"} to stop` : null,
  ].filter(Boolean).join(" · ");
  const resultCounts = result ? [
    result.closedTerminals > 0 ? `${result.closedTerminals} ${result.closedTerminals === 1 ? "terminal" : "terminals"} closed` : null,
    result.signalledPorts.length > 0 ? `${result.signalledPorts.length} port shutdown ${result.signalledPorts.length === 1 ? "request" : "requests"} sent` : null,
  ].filter(Boolean).join(" · ") : "";
  const issues = result ? [...result.failed, ...result.skipped] : preview?.skipped ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && busy && result === null) return; setOpen(next); }}>
      <button
        type="button"
        aria-label="Close terminals and ports of settled threads"
        title="Close terminals and ports of settled threads (threads stay in Settled)"
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        className="absolute bottom-1 right-[1.875rem] z-10 flex size-4 items-center justify-center rounded text-muted-foreground/40 hover:bg-sidebar-accent hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="Clean" className="size-3" aria-hidden />
      </button>
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...portalScope}
          className="fixed left-1/2 top-1/2 z-50 box-border w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
        >
          <Dialog.Title className="text-sm font-semibold leading-5">Clean settled resources?</Dialog.Title>
          <Dialog.Description className="mt-2 text-xs leading-5 text-muted-foreground">
            {result
              ? "Cleanup finished. Threads stayed in Settled."
              : "Review the live resources found on settled threads before closing them."}
          </Dialog.Description>
          {busy && !preview ? <p className="mt-4 text-xs">Checking settled threads...</p> : null}
          {preview && !result ? (
            <div className="mt-4 text-xs">
              {preview.threads.length > 0 ? (
                <>
                  <p className="font-medium">{previewCounts}</p>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
                    {preview.threads.map((thread) => (
                      <li key={thread.threadId}>
                        <span className="font-medium">{thread.title}</span>
                        <button
                          type="button"
                          aria-label={`Open thread: ${thread.title}`}
                          disabled={busy}
                          onClick={() => { if (busy) return; threadActions.open(thread.threadId); onNavigate(); setOpen(false); }}
                          className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                        >
                          Open
                        </button>
                        <span className="text-muted-foreground">
                          {thread.terminalCount > 0 ? ` · ${thread.terminalCount} ${thread.terminalCount === 1 ? "terminal" : "terminals"}` : ""}
                          {thread.ports.length > 0 ? ` · ${thread.ports.map((port) => `:${port}`).join(", ")}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {terminalCount > 0 ? <p className="mt-2 text-muted-foreground">This closes terminals even if you typed into them.</p> : null}
                  {portCount > 0 ? <p className="mt-2 text-muted-foreground">A port process may need time to exit after its shutdown request.</p> : null}
                </>
              ) : <p className="text-muted-foreground">No live terminals or thread-owned listening ports found.</p>}
            </div>
          ) : null}
          {result ? (
            <div className="mt-4 text-xs">
              <p>{resultCounts || "No resources were closed."}</p>
              {result.remainingPorts.length ? <p className="mt-2">Still listening after the request: {result.remainingPorts.map(({ port }) => `:${port}`).join(", ")}</p> : null}
            </div>
          ) : null}
          {issues.length > 0 ? (
            <div className="mt-3 max-h-28 overflow-y-auto text-xs text-muted-foreground">
              <p className="font-medium">Skipped or could not complete:</p>
              <ul className="mt-1 list-inside list-disc">
                {issues.map((issue, index) => <li key={`${issue.threadId}:${issue.resource}:${index}`}>{issue.threadId}: {issue.message}</li>)}
              </ul>
            </div>
          ) : null}
          {error ? <p role="alert" className="mt-3 text-xs text-destructive">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" disabled={busy && result === null} className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50">
                {result ? "Done" : "Cancel"}
              </button>
            </Dialog.Close>
            {error && !busy && !result ? (
              <button type="button" onClick={() => setRefreshKey((key) => key + 1)} className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent">
                Refresh preview
              </button>
            ) : null}
            {preview && !result && preview.threads.length > 0 ? (
              <button type="button" disabled={busy} onClick={() => void clean()} className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50">
                {busy ? "Cleaning..." : "Clean resources"}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
