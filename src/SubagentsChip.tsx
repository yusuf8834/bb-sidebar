import { useEffect, useMemo, useState } from "react";
import {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { useSidebarSettings } from "./useSidebarSettings";
import {
  ChildThreadDots,
  ChildThreadList,
  childThreadsByParent,
  childNeedsYouCount,
  childrenOf,
} from "./ChildThreadList";
import {
  ChildThreadDisplayContext,
  useChildThreadDisplayValue,
} from "./ChildThreadDisplay";
import { cn } from "./lib/utils";
import { Tooltip } from "./components/Tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { useArchivedThreadFamily, useHeaderThread } from "./useArchivedThreadFamily";

/**
 * The home for child threads the flat list hides: a chip in the thread header
 * that opens the list of this thread's children.
 *
 * These are bb CHILD THREADS — forks, side chats, and plugin-spawned threads.
 * bb's in-turn subagents are activity counters on the parent, not threads, so
 * the label deliberately says "children".
 */
export function SubagentsChip({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const parent = useHeaderThread(threadId, threads);
  const includeArchived = parent?.isArchived === true;
  const archivedFamily = useArchivedThreadFamily(includeArchived ? threadId : null, threads, open);
  const family = includeArchived ? archivedFamily.threads : threads;
  const sidebarSettings = useSidebarSettings();

  const { providers } = useProviders();
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const childDisplay = useChildThreadDisplayValue(
    sidebarSettings,
    providerById,
  );
  const children = childrenOf(family, threadId, childDisplay.sort, includeArchived);
  const childrenByParent = useMemo(
    () => childThreadsByParent(family, childDisplay.sort, includeArchived),
    [family, childDisplay.sort, includeArchived],
  );
  useEffect(() => {
    setOpen(false);
  }, [threadId]);
  useEffect(() => {
    if (children.length === 0 && archivedFamily.status === "ready") setOpen(false);
  }, [children.length, archivedFamily.status]);
  if (children.length === 0 && archivedFamily.status === "ready") return null;

  const needsYou = childNeedsYouCount(children) > 0;
  const threadCountLabel = children.length === 0 ? "Child threads" : `${children.length} child thread${
    children.length === 1 ? "" : "s"
  }`;
  const label = needsYou
    ? "Needs you"
    : children.length === 0 ? "Children" : `${children.length} ${children.length === 1 ? "child" : "children"}`;

  return (
    <ChildThreadDisplayContext.Provider value={childDisplay}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip label={threadCountLabel} side="bottom">
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={threadCountLabel}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-2xs text-muted-foreground",
                "hover:bg-accent hover:text-foreground",
                open && "bg-accent text-foreground",
              )}
            >
              <ChildThreadDots threads={children} includeArchived={includeArchived} />
              {isCompactViewport ? null : (
                <span className="truncate">{label}</span>
              )}
            </button>
          </PopoverTrigger>
        </Tooltip>
        {/* Portaled and collision-aware, so a long list scrolls inside the
            viewport instead of running off it. */}
        <PopoverContent
          role="region"
          aria-label="Child threads"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // An inline rename owns Escape; it cancels the edit, not the popup.
            if (event.target instanceof HTMLInputElement) event.preventDefault();
          }}
          className="flex max-h-[var(--radix-popover-content-available-height)] w-80 flex-col overflow-hidden rounded-xl border-border p-0 shadow-lg"
        >
          <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
            <span className="text-xs font-semibold">Children</span>
            <span className="ml-auto text-2xs text-muted-foreground">
              {children.length > 0 ? children.length : null}
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto">
            {archivedFamily.status === "loading" ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading child threads…</p> : null}
            {archivedFamily.status === "error" ? (
              <div className="px-3 py-2 text-xs">
                <p role="alert">Could not load archived child threads.</p>
                <button type="button" onClick={archivedFamily.retry} className="mt-1 underline">Retry</button>
              </div>
            ) : null}
            <ChildThreadList
              threads={children}
              childrenByParent={childrenByParent}
              parentProjectId={parent?.projectId}
              includeArchived={includeArchived}
              variant="header"
              onOpenThread={(childId) => {
                setOpen(false);
                if (family.find((thread) => thread.id === childId)?.isArchived) navigate.toThread(childId);
                else actions.open(childId);
              }}
            />
          </div>
        </PopoverContent>
      </Popover>
    </ChildThreadDisplayContext.Provider>
  );
}
