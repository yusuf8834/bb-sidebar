import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { Disc } from "./Disc";
import { cn } from "./lib/utils";
import { relativeTimeLabel } from "./relative-time";
import { StatusGlyph } from "./StatusGlyph";
import { threadDisplayTitle } from "./inbox";

const MAX_CHILD_DOTS = 3;

export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function childThreadsByParent(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, readonly PluginSidebarThread[]> {
  const result = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = result.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    result.set(thread.parentThreadId, siblings);
  }
  for (const siblings of result.values()) {
    siblings.sort((left, right) => left.createdAt - right.createdAt);
  }
  return result;
}

export function childNeedsYouCount(
  threads: readonly PluginSidebarThread[],
): number {
  return threads.filter((thread) => thread.hasPendingInteraction).length;
}

export function isChildRunning(thread: PluginSidebarThread): boolean {
  switch (thread.indicator) {
    case "runtime":
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
    case "goal":
    case "working-draft":
      return true;
    default:
      return false;
  }
}

export function ChildThreadDots({
  threads,
  compact = false,
}: {
  threads: readonly PluginSidebarThread[];
  compact?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {threads.slice(0, MAX_CHILD_DOTS).map((thread, index) => (
        <span
          key={thread.id}
          data-child-thread-dot=""
          className={cn(index > 0 && (compact ? "-ml-1" : "-ml-1.5"))}
        >
          <Disc
            thread={thread}
            className={
              compact
                ? "size-[9px] border-[1.5px] border-sidebar"
                : undefined
            }
          />
        </span>
      ))}
    </span>
  );
}

export function ChildThreadBadge({
  threads,
  expanded,
  controls,
  onToggle,
}: {
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const needsYou = childNeedsYouCount(threads);
  const count = threads.length;
  const tooltip = `${count} child thread${count === 1 ? "" : "s"}${
    needsYou > 0 ? `, ${needsYou} need you` : ""
  }`;

  return (
    <Tooltip label={tooltip} side="bottom">
      <button
        type="button"
        aria-label={tooltip}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        className={cn(
        "pointer-events-auto flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium",
          "outline-none focus-visible:ring-1 focus-visible:ring-ring",
          needsYou > 0
            ? "bg-[#fbf0dd] text-[#c9791b] dark:bg-amber-950/60 dark:text-amber-300"
            : "bg-[#ececee] text-[#3a3a3c] dark:bg-muted dark:text-foreground",
        )}
      >
        <ChildThreadDots threads={threads} compact />
        <span className="tabular-nums">{count}</span>
        <Icon
          name={expanded ? "ChevronUp" : "ChevronDown"}
          className="size-3"
          aria-hidden
        />
      </button>
    </Tooltip>
  );
}

export function ChildThreadList({
  threads,
  variant,
  now,
  id,
  onOpenThread,
}: {
  threads: readonly PluginSidebarThread[];
  variant: "header" | "sidebar";
  now?: number;
  id?: string;
  onOpenThread: (threadId: string) => void;
}) {
  return (
    <ul
      id={id}
      aria-label="Child threads"
      data-child-thread-list={variant}
      className={cn(
        "flex flex-col",
        variant === "header"
          ? "gap-px p-1.5 pt-0.5"
          : "ml-[21px] mt-1 border-l-[1.5px] border-[#d6d6d8] pl-3 dark:border-border",
      )}
    >
      {threads.map((child) => {
        const title = threadDisplayTitle(child);
        const needsYou = child.hasPendingInteraction;
        const running = !needsYou && isChildRunning(child);
        return (
          <li key={child.id} className="list-none">
            <button
              type="button"
              role={variant === "header" ? "menuitem" : undefined}
              aria-label={`Open child thread: ${title}`}
              onClick={() => onOpenThread(child.id)}
              className={cn(
                "flex w-full items-center text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
                variant === "header"
                  ? "gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                  : "h-7 gap-2 rounded-md px-2 hover:bg-sidebar-accent/60",
                variant === "sidebar" && needsYou &&
                  "bg-[#fdf6ea] hover:bg-[#fdf6ea] dark:bg-amber-950/30 dark:hover:bg-amber-950/40",
              )}
            >
              <Disc
                thread={child}
                className={
                  variant === "header" ? undefined : "size-2 border-0"
                }
              />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  variant === "header" ? "flex flex-col" : "truncate text-xs",
                )}
              >
                <span className="truncate">{title}</span>
                {variant === "header" ? (
                  <span className="truncate text-2xs text-muted-foreground">
                    {child.originKind ?? "thread"}
                  </span>
                ) : null}
              </span>
              {variant === "header" ? (
                <StatusGlyph
                  indicator={child.indicator}
                  label={child.indicatorLabel}
                />
              ) : (
                <>
                  {needsYou ? <ChildStatusFlag kind="needs-you" /> : null}
                  {running ? <ChildStatusFlag kind="running" /> : null}
                <span className="text-2xs shrink-0 font-mono tabular-nums text-[#a0a0a4]">
                    {relativeTimeLabel(child.updatedAt, now ?? Date.now())}
                  </span>
                </>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ChildStatusFlag({ kind }: { kind: "needs-you" | "running" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em]",
        kind === "needs-you"
          ? "bg-[#fbf0dd] text-[#c9791b] dark:bg-amber-950/60 dark:text-amber-300"
          : "bg-[#e7eefa] text-[#3f6fc4] dark:bg-sky-950/60 dark:text-sky-300",
      )}
    >
      {kind === "needs-you" ? "Needs you" : "Running"}
    </span>
  );
}
