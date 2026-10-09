import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { filterByProject, hideChildrenOfVisibleParents, threadDisplayTitle, visibleInboxThreads } from "./inbox";
import { ProjectFavicon, ProjectStripe } from "./ProjectFavicon";
import { useProjectColor } from "./ProjectColors";
import { relativeTimeLabel } from "./relative-time";
import { projectIconUrl } from "./project-icons";
import type { bbSidebarRpcContract } from "./server";
import { SettingRow, SettingsSection, SettingsSelect, secondaryButtonClass } from "./settings-ui";
import { useLifecycle } from "./useLifecycle";

export function ArchiveSettings() {
  const { status, threads, projects } = useSidebarThreads();
  const lifecycle = useLifecycle(threads);
  const [projectId, setProjectId] = useState("");
  const scoped = hideChildrenOfVisibleParents(filterByProject(visibleInboxThreads(threads), projectId || null));
  const settled = status === "ready" ? scoped.filter((thread) => lifecycle.shelfFor(thread) === "settled") : [];
  return (
    <SettingsSection title="Archiving">
      <SettingRow title="Project" description="Choose which project's settled threads to archive." control={
        <SettingsSelect aria-label="Archive project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className="w-48">
          <option value="">All projects</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </SettingsSelect>
      } />
      <SettingRow title="Archive settled threads" description={status === "loading" ? "Loading threads..." : status === "error" ? "Could not load threads." : `${settled.length} settled ${settled.length === 1 ? "thread" : "threads"}. Review the list before archiving.`} control={
        <ArchiveSettledDialog threads={settled} />
      } />
    </SettingsSection>
  );
}

/**
 * Archives every thread on the Settled shelf (already narrowed by the project
 * picker) after one confirmation. They land on the Archived shelf below.
 */
export function ArchiveSettledDialog({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const portalScope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = threads.length;

  const archiveAll = async () => {
    if (busy || count === 0) return;
    setBusy(true);
    try {
      const result = await rpc.call("archiveThreads", { threadIds: threads.map((thread) => thread.id) });
      if (result.failures.length > 0) {
        toast.error(`Archived ${result.archived} of ${count}`, {
          description: result.failures.map((failure) => failure.error).join("; "),
        });
      } else {
        toast.success(`Archived ${result.archived} ${result.archived === 1 ? "thread" : "threads"}`);
      }
      setOpen(false);
    } catch (error) {
      toast.error("Could not archive settled threads", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <button
        type="button"
        aria-label="Archive all settled threads"
        disabled={count === 0}
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        className={secondaryButtonClass}
      >
        Archive all…
      </button>
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...portalScope}
          className="fixed left-1/2 top-1/2 z-50 box-border w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
        >
          <Dialog.Title className="text-sm font-semibold leading-5">
            Archive {count} settled {count === 1 ? "thread" : "threads"}?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-xs leading-5 text-muted-foreground">
            This also archives their child threads. Enable the Archived shelf in settings to browse and restore archived threads.
          </Dialog.Description>
          <ul className="mt-4 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs">
            {threads.map((thread) => <li key={thread.id} className="truncate">{threadDisplayTitle(thread)}</li>)}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" disabled={busy} className="h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50">
                Cancel
              </button>
            </Dialog.Close>
            <button type="button" disabled={busy} onClick={() => void archiveAll()} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {busy ? "Archiving..." : "Archive all"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Archived threads in the current project scope, newest first. Mounted only
 * while the Archived shelf is open, so a closed shelf never pages the archive.
 * The filter matches title and project name over the pages loaded so far.
 */
export function ArchivedThreadList({
  scope,
  projectNameById,
  projectIconRevision,
  activeThreadId,
  now,
  onNavigate,
}: {
  scope: string | null;
  projectNameById: ReadonlyMap<string, string>;
  projectIconRevision: number;
  activeThreadId: string | null;
  now: number;
  onNavigate: () => void;
}) {
  const { status, threads, experimental_archived: archive } = useSidebarThreads({
    experimental_lifecycles: ["archived"],
  });
  const [query, setQuery] = useState("");
  const archived = useMemo(
    () =>
      hideChildrenOfVisibleParents(
        filterByProject(threads.filter((thread) => thread.isArchived), scope),
      ).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [threads, scope],
  );
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? archived.filter((thread) =>
        `${threadDisplayTitle(thread)} ${projectNameById.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(needle),
      )
    : archived;

  if (status === "loading") {
    return <p className="px-2.5 py-1 text-2xs text-muted-foreground">Loading archived threads…</p>;
  }
  if (status === "error" || archive?.status === "error") {
    return <p role="alert" className="px-2.5 py-1 text-2xs text-destructive">Could not load archived threads.</p>;
  }
  return (
    <>
      {archived.length > 0 ? (
        // Built like a row, so the icon sits in the favicon column and the
        // text starts where every archived title starts.
        <label className="flex h-7 cursor-text items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors duration-150 ease-out focus-within:bg-sidebar-accent/60 focus-within:ring-1 focus-within:ring-ring hover:bg-sidebar-accent/40 motion-reduce:transition-none">
          <Icon name="Search" className="size-3 shrink-0 opacity-60" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter archive"
            aria-label="Filter archived threads"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
              className="-mr-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="CircleX" className="size-3" />
            </button>
          ) : null}
        </label>
      ) : null}
      {archived.length === 0 ? (
        <p className="px-2.5 py-1 text-2xs text-muted-foreground">No archived threads{scope ? " in this project" : ""}.</p>
      ) : shown.length === 0 ? (
        <p className="px-2.5 py-1 text-2xs text-muted-foreground">No archived threads match.</p>
      ) : (
        <ul className="flex flex-col gap-px">
          {shown.map((thread) => (
            <ArchivedRow
              key={thread.id}
              thread={thread}
              projectName={projectNameById.get(thread.projectId) ?? null}
              projectIconUrl={projectIconUrl(thread.projectId, projectIconRevision)}
              isActive={thread.id === activeThreadId}
              now={now}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      {archive?.hasNextPage ? (
        <button
          type="button"
          disabled={archive.isFetchingNextPage}
          onClick={() => void archive.fetchNextPage()}
          className="ml-2.5 mt-1 rounded px-1.5 py-1 text-2xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
        >
          {archive.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}

function ArchivedRow({
  thread,
  projectName,
  projectIconUrl,
  isActive,
  now,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  projectIconUrl: string | null;
  isActive: boolean;
  now: number;
  onNavigate: () => void;
}) {
  const actions = useSidebarThreadActions();
  const projectColor = useProjectColor(thread.projectId, "collapsed");
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [busy, setBusy] = useState(false);
  const title = threadDisplayTitle(thread);
  const dates = `Started ${new Date(thread.createdAt).toLocaleDateString()}${
    thread.archivedAt ? ` · Archived ${new Date(thread.archivedAt).toLocaleDateString()}` : ""
  }`;

  const unarchive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call("unarchiveThread", { threadId: thread.id });
      toast.success("Thread restored", { description: title });
    } catch (error) {
      toast.error("Could not restore thread", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="list-none">
      <div
        className={cn(
          "group/slim relative flex h-8 items-center gap-2 rounded-md px-2.5 text-xs transition-colors duration-150 ease-out motion-reduce:transition-none",
          isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
        )}
      >
        {projectName ? <ProjectStripe projectId={thread.projectId} colorView="collapsed" className="opacity-60" /> : null}
        <a
          href="#"
          title={dates}
          aria-label={projectName ? `${projectName} · ${title}` : title}
          onClick={(event) => {
            event.preventDefault();
            actions.open(thread.id, { split: false });
            onNavigate();
          }}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
        <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1 text-muted-foreground/60 group-hover/slim:text-foreground">
          {projectName ? (
            <>
              <ProjectFavicon projectId={thread.projectId} colorView="collapsed" src={projectIconUrl} name={projectName} className="size-3" />
              <span style={projectColor} className={cn("max-w-[40%] shrink truncate", projectColor && "bb-sidebar-project-name")}>
                {projectName}
              </span>
              <span aria-hidden="true" className="shrink-0 text-sm leading-none text-muted-foreground/45">·</span>
            </>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </span>
        {thread.archivedAt ? (
          <span
            aria-label={`Archived ${relativeTimeLabel(thread.archivedAt, now)} ago`}
            className="pointer-events-none relative shrink-0 tabular-nums text-2xs text-muted-foreground/60 group-hover/slim:hidden"
          >
            {relativeTimeLabel(thread.archivedAt, now)}
          </span>
        ) : null}
        <Tooltip label="Restore from archive">
          <button
            type="button"
            aria-label="Restore from archive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void unarchive();
            }}
            className="relative rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:text-foreground focus-visible:opacity-100 disabled:opacity-50 group-hover/slim:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none"
          >
            <Icon name="Unarchive" className="size-3.5" />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}
