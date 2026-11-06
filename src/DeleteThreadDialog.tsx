import { useSidebarThreads } from "./bb-sdk";
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
 * thread and its project, and counts the threads that go with it.
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
  const [cascade, setCascade] = useState<CascadeCount>({ status: "counting" });

  // bb deletes archived descendants and lifecycle dependents too, which the
  // sidebar's thread list does not include, so ask bb what goes with it.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCascade({ status: "counting" });
    sdk.threads.experimental_listCascade({ threadIds: [thread.id], action: "delete", signal: controller.signal }).then(
      ({ threads }) => {
        if (controller.signal.aborted) return;
        const row = threads.find((candidate) => candidate.threadId === thread.id);
        setCascade({ status: "counted", count: row?.cascadeThreadIds.length ?? 0 });
      },
      () => {
        if (!controller.signal.aborted) setCascade({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [open, sdk, thread.id]);

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await rpc.call("deleteThread", { threadId: thread.id, childThreadsConfirmed: true });
      toast.success("Thread deleted", { description: title });
      if (context.threadId === thread.id) navigate.toCompose();
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
            {describeCascade(cascade)}
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
              disabled={busy || cascade.status === "counting"}
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

type CascadeCount = { status: "counting" } | { status: "counted"; count: number } | { status: "failed" };

function describeCascade(cascade: CascadeCount): string {
  if (cascade.status === "counting") return "Counting the threads deleted with it…";
  if (cascade.status === "failed") return "Any child threads are deleted too. This action cannot be undone.";
  if (cascade.count === 0) return "This action cannot be undone.";
  const children = cascade.count === 1 ? "its 1 child thread" : `its ${cascade.count} child threads`;
  return `This also deletes ${children}. This action cannot be undone.`;
}
