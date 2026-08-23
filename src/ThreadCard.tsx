import {
  useState,
  type DragEventHandler,
  type KeyboardEventHandler,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon, type IconName } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";
import { RowContextMenu } from "./RowContextMenu";
import { ProviderGlyph } from "./ProviderGlyph";
import { STATUS_SLOT_CLASS, StatusOrTime } from "./StatusSlot";
import { threadDisplayTitle } from "./inbox";
import { InlineThreadTitle } from "./InlineThreadTitle";
import type { ConfiguredSnoozePreset } from "./lifecycle";

export interface ThreadReorderControls {
  disabled: boolean;
  isDragging: boolean;
  onDragStart: DragEventHandler<HTMLButtonElement>;
  onDragEnd: DragEventHandler<HTMLButtonElement>;
  onDragOver: DragEventHandler<HTMLLIElement>;
  onDrop: DragEventHandler<HTMLLIElement>;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}

/**
 * One thread as a three-line card: project and status, title, then branch and
 * activity. The card is the whole point of this sidebar — status lives in the
 * row instead of in its position, which is what lets the list stay still.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
export function ThreadCard({
  thread,
  projectName,
  isActive,
  isSelected,
  isWoke,
  canPark,
  snoozePresets,
  onNavigate,
  onSettle,
  onSnooze,
  onAcknowledgeWake,
  onSelectionClick,
  reorder,
  now,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  isActive: boolean;
  isSelected: boolean;
  /** A snooze ended and has not yet been acknowledged. */
  isWoke: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  onNavigate: () => void;
  onSettle: () => void;
  onSnooze: (snoozedUntil: number) => void;
  onAcknowledgeWake: () => void;
  onSelectionClick: (event: ReactMouseEvent<HTMLAnchorElement>) => boolean;
  reorder?: ThreadReorderControls;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
}) {
  const actions = useSidebarThreadActions();
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);
  // Opt-in per row: this costs a git-host lookup, and threads sharing a
  // worktree share one.
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);
  const [isRenaming, setIsRenaming] = useState(false);

  const quickSnooze = snoozePresets[0];

  return (
    <RowContextMenu
      thread={thread}
      canSnooze={canPark}
      canArchive={canPark}
      snoozePresets={snoozePresets}
      onSnooze={onSnooze}
      onSettle={canPark ? onSettle : undefined}
      onRename={() => setIsRenaming(true)}
    >
      <li
        className={cn("list-none", reorder?.isDragging && "opacity-50")}
        onDragOver={reorder?.onDragOver}
        onDrop={reorder?.onDrop}
      >
        <div
          className={cn(
            "group/card relative rounded-md px-2.5 py-2 transition-colors",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            isSelected &&
              "bg-sidebar-accent ring-1 ring-inset ring-primary/60",
            // A thread open in another pane gets a weaker tint than the active
            // row, so the two states stay distinguishable.
            !isActive && layout !== null && "bg-sidebar-accent/30",
          )}
        >
          <a
            // Both attributes, or bb's nine thread shortcuts stop finding rows.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={`${isSelected ? "Selected, " : ""}${threadDisplayTitle(thread)}`}
            aria-current={isActive ? "page" : undefined}
            data-selected={isSelected ? "true" : undefined}
            {...splitProps}
            onClick={(event) => {
              event.preventDefault();
              if (isRenaming || event.detail > 1) return;
              if (onSelectionClick(event)) return;
              if (isWoke) onAcknowledgeWake();
              actions.open(thread.id, { split: false });
              onNavigate();
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsRenaming(true);
            }}
            className="absolute inset-0 cursor-pointer rounded-md"
          />
          <div className="pointer-events-none relative flex h-5 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground">
              {projectName ?? " "}
            </span>
            {reorder ? (
              <Tooltip label="Drag to reorder · Arrow keys also work">
                <button
                  type="button"
                  draggable={!reorder.disabled}
                  disabled={reorder.disabled}
                  aria-label={`Reorder ${threadDisplayTitle(thread)}. Use Arrow Up or Arrow Down.`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onDragStart={reorder.onDragStart}
                  onDragEnd={reorder.onDragEnd}
                  onKeyDown={reorder.onKeyDown}
                  className="pointer-events-auto rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed group-hover/card:opacity-100"
                >
                  <Icon name="GripVertical" className="size-3.5" />
                </button>
              </Tooltip>
            ) : null}
            {thread.isPinned ? (
              <Tooltip label="Unpin thread">
                <button
                  type="button"
                  aria-label={`Unpin ${threadDisplayTitle(thread)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void actions.setPinned(thread.id, false).catch((error) => {
                      toast.error("Could not unpin thread", {
                        description:
                          error instanceof Error ? error.message : undefined,
                      });
                    });
                  }}
                  className="pointer-events-auto rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100"
                >
                  <Icon name="PinOff" className="size-3.5" />
                </button>
              </Tooltip>
            ) : null}
            {/* Status at rest, park actions on hover. Only the status yields,
                so the project name never shifts. */}
            {canPark && quickSnooze && !isWoke ? (
              <span className="pointer-events-auto hidden items-center gap-0.5 group-hover/card:flex">
                <ParkButton
                  label={`Snooze for ${quickSnooze.label}`}
                  icon="Clock"
                  onActivate={() => onSnooze(Date.now() + quickSnooze.durationMs)}
                />
                <ParkButton
                  label="Settle thread"
                  icon="Check"
                  onActivate={onSettle}
                />
              </span>
            ) : null}
            {isWoke ? (
              <Tooltip label="Dismiss Woke marker">
                <button
                  type="button"
                  aria-label="Dismiss Woke marker"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onAcknowledgeWake();
                  }}
                  className={cn(
                    STATUS_SLOT_CLASS,
                    "pointer-events-auto justify-end text-2xs font-medium text-primary hover:underline",
                  )}
                >
                  Woke
                </button>
              </Tooltip>
            ) : (
              <span
                className={cn(
                  STATUS_SLOT_CLASS,
                  canPark && "group-hover/card:hidden",
                )}
              >
                <StatusOrTime thread={thread} now={now} />
              </span>
            )}
          </div>
          <div
            className={cn(
              // Weight alone carries unread. Fading the title — or the whole
              // card — makes a thread at rest read as disabled, and at rest is
              // what most of the list is most of the time.
              "pointer-events-none relative mt-0.5 truncate text-sm text-foreground",
              isRenaming && "pointer-events-auto",
              thread.isUnread && "font-medium",
            )}
          >
            <InlineThreadTitle
              thread={thread}
              editing={isRenaming}
              onEditingChange={setIsRenaming}
            />
          </div>
          <div className="pointer-events-none relative mt-0.5 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground">
            {/* A thread without a worktree still runs somewhere, so the
                machine takes the branch's place rather than leaving the line
                blank. */}
            {thread.environment?.branchName ? (
              <span className="min-w-0 flex-1 truncate font-mono">
                {thread.environment.branchName}
              </span>
            ) : thread.host ? (
              <span className="min-w-0 flex-1 truncate">
                {thread.host.name}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {thread.activity.workflows > 0 ? (
              <ActivityCount
                label="workflows"
                count={thread.activity.workflows}
              />
            ) : null}
            {thread.activity.backgroundAgents > 0 ? (
              <ActivityCount
                label="background agents"
                count={thread.activity.backgroundAgents}
              />
            ) : null}
            {pullRequest ? (
              <a
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                title={pullRequest.title}
                className={cn(
                  "relative shrink-0 font-mono hover:underline",
                  pullRequest.state === "merged"
                    ? "text-[color:var(--pr-merged)]"
                    : pullRequest.attention === "checks_failed" ||
                        pullRequest.attention === "conflicts"
                      ? "text-destructive-text"
                      : pullRequest.attention === "ready_to_merge"
                        ? "text-success-foreground"
                        : "text-muted-foreground",
                )}
              >
                #{pullRequest.number}
              </a>
            ) : null}
            {/* Always drawn, so the line has a fixed right edge. */}
            <ProviderGlyph providerId={thread.providerId} />
          </div>
        </div>
      </li>
    </RowContextMenu>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
}: {
  label: string;
  icon: Extract<IconName, "Clock" | "Check">;
  onActivate: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        }}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <Icon name={icon} className="size-3.5" />
      </button>
    </Tooltip>
  );
}

function ActivityCount({ label, count }: { label: string; count: number }) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className="shrink-0 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground"
    >
      {count}
    </span>
  );
}
