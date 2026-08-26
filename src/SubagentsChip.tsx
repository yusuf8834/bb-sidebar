import { useMemo, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  ChildThreadDots,
  ChildThreadList,
  childThreadsByParent,
  childNeedsYouCount,
  childrenOf,
} from "./ChildThreadList";
import { cn } from "./lib/utils";
import { Tooltip } from "./components/Tooltip";

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
  const [open, setOpen] = useState(false);

  const children = childrenOf(threads, threadId);
  const childrenByParent = useMemo(
    () => childThreadsByParent(threads),
    [threads],
  );
  if (children.length === 0) return null;

  const needsYou = childNeedsYouCount(children) > 0;
  const threadCountLabel = `${children.length} child thread${
    children.length === 1 ? "" : "s"
  }`;
  const label = needsYou
    ? "Needs you"
    : `${children.length} ${children.length === 1 ? "child" : "children"}`;

  return (
    <span className="relative">
      <Tooltip label={threadCountLabel} side="bottom">
        <button
          type="button"
          aria-expanded={open}
          aria-label={threadCountLabel}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-2xs text-muted-foreground",
            "hover:bg-accent hover:text-foreground",
            open && "bg-accent text-foreground",
          )}
        >
          <ChildThreadDots threads={children} />
          {isCompactViewport ? null : (
            <span className="truncate">{label}</span>
          )}
        </button>
      </Tooltip>
      {open ? (
        <>
          {/* Click-away. The header is a short row, so the list itself is
              absolutely positioned rather than inline. */}
          <span
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            aria-label="Child threads"
            className="absolute right-0 top-9 z-50 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
          >
            <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
              <span className="text-xs font-semibold">Children</span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {children.length}
              </span>
            </div>
            <ChildThreadList
              threads={children}
              childrenByParent={childrenByParent}
              variant="header"
              onOpenThread={(childId) => {
                setOpen(false);
                actions.open(childId);
              }}
            />
          </div>
        </>
      ) : null}
    </span>
  );
}
