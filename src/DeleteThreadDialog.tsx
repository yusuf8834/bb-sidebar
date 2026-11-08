import { countDeleteCascade, useSidebarThreads } from "./bb-sdk";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useBbContext, useBbNavigate, useRpc, useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { threadDisplayTitle } from "./inbox";
import { usePortalScopeProps } from "./lib/portal-scope";

/**
 * The sidebar's own delete confirmation. bb's generic one says only "Delete
 * thread?", which is easy to misread across a busy list; this one names the
 * thread and its project, and counts the children that go with it.
 */
export function DeleteThreadDialog({
  thread,
  open,
  onOpenChange,
}: {
  thread: PluginSidebarThread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { projects } = useSidebarThreads();
  const sdk = useSdk();
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const portalScope = usePortalScopeProps();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const projectName = project && !project.isPersonal ? project.name : "Personal";
  const title = threadDisplayTitle(thread);
  // null while bb counts. bb also deletes archived descendants and lifecycle
  // dependents, which the sidebar's thread list does not hold.
  const [childCount, setChildCount] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setChildCount(null);
    countDeleteCascade(sdk, thread.id, controller.signal).then(
      (count) => {
        if (!controller.signal.aborted) setChildCount(count);
      },
      (error) => {
        if (controller.signal.aborted) return;
        toast.error("Could not check which threads would be deleted", {
          description: error instanceof Error ? error.message : undefined,
        });
        onOpenChange(false);
      },
    );
    return () => controller.abort();
  }, [open, sdk, thread.id, onOpenChange]);

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await rpc.call("deleteThread", { threadId: thread.id, childThreadsConfirmed: true });
      toast.success("Thread deleted", { description: title });
      if (context.threadId === thread.id) navigate.toCompose({ projectId: thread.projectId, focusPrompt: true });
      onOpenChange(false);
    } catch (error) {
      toast.error("Could not delete thread", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...portalScope}
          className="fixed left-1/2 top-1/2 z-50 box-border w-[calc(100%_-_2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
        >
          <Dialog.Title className="text-sm font-semibold leading-5">Delete thread?</Dialog.Title>
          <div className="mt-3 rounded-md border border-border bg-background px-3 py-2">
            <div className="truncate text-sm font-medium" title={title}>
              {title}
            </div>
            <div className="truncate text-xs text-muted-foreground" title={projectName}>
              {projectName}
            </div>
          </div>
          <Dialog.Description className="mb-4 mt-3 text-xs leading-5 text-muted-foreground">
            {childCount
              ? `This also deletes ${childCount === 1 ? "its 1 child thread" : `its ${childCount} child threads`}. This action cannot be undone.`
              : "This action cannot be undone."}
          </Dialog.Description>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={busy || childCount === null}
              onClick={() => void submit()}
              className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy ? "Deleting..." : "Delete thread"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
