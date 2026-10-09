import {
  useId,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
} from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  ChildThreadBadge,
  ChildThreadList,
  collapsedChildThreads,
} from "./ChildThreadList";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { ThreadDetailsTooltip } from "./ThreadDetailsTooltip";
import { SnoozeSelect } from "./SnoozeSelect";
import { cn } from "./lib/utils";
import { pullRequestStatusLabel, pullRequestToneClass } from "./pull-request-display";
import { RowContextMenu } from "./RowContextMenu";
import { ProviderGlyph, type SidebarProvider } from "./ProviderGlyph";
import { STATUS_SLOT_CLASS, StatusOrTime, threadShortStatus } from "./StatusSlot";
import { CompactLiveStatus } from "./StatusGlyph";
import { threadDisplayTitle } from "./inbox";
import { InlineThreadTitle } from "./InlineThreadTitle";
import type { ConfiguredSnoozePreset } from "./lifecycle";
import { isWorkingTree } from "./working-tree";
import { ProjectFavicon, ProjectStripe } from "./ProjectFavicon";
import { useProjectColor } from "./ProjectColors";
import { OpenPortsIndicator } from "./OpenPorts";
import { JumpHint, useJumpHint } from "./JumpHints";
import "./settle-button.css";

/** How long the settle sweep plays before the thread actually moves. */
const SETTLE_SWEEP_MS = 520;
/** A settle that worked has unmounted the card by now; one that failed has not. */
const SETTLE_RECOVER_MS = 4_000;

function shouldAnimateSettle(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface ThreadReorderControls {
  disabled: boolean;
  isDragging: boolean;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
}

/**
 * One thread as a three-line card: project and status, title, then branch and
 * activity. With `compactWhenWorking`, a thread with live work folds to one
 * line, like a settled row, ending in its status glyph and run time. Under a shared project header the project line is dropped and the
 * title takes its place beside the status. Status lives in the row instead of
 * its position, so manual order can stay fixed while work changes state.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
export function ThreadCard({
  thread,
  provider,
  projectName,
  projectIconUrl,
  showProject = true,
  isActive,
  isWoke,
  canPark,
  snoozePresets,
  onNavigate,
  onRenamingChange,
  onPark,
  onSettle,
  onSnooze,
  onAcknowledgeWake,
  childThreads,
  childrenByParent,
  activeThreadId,
  childrenExpanded,
  showRunningChildrenWhenCollapsed,
  onToggleChildren,
  reorder,
  compactWhenWorking = false,
  now,
}: {
  thread: PluginSidebarThread;
  provider: SidebarProvider | null;
  projectName: string | null;
  projectIconUrl: string | null;
  /** False when a group header already names the project. */
  showProject?: boolean;
  isActive: boolean;
  /** A snooze ended and has not yet been acknowledged. */
  isWoke: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  onNavigate: () => void;
  onRenamingChange?: (editing: boolean) => void;
  onPark?: () => void;
  onSettle: () => void;
  onSnooze: (snoozedUntil: number) => void;
  onAcknowledgeWake: () => void;
  childThreads: readonly PluginSidebarThread[];
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  activeThreadId: string | null;
  childrenExpanded: boolean;
  showRunningChildrenWhenCollapsed: boolean;
  onToggleChildren: () => void;
  reorder?: ThreadReorderControls;
  /** Experimental: show threads with live work as a single line. */
  compactWhenWorking?: boolean;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
}) {
  const actions = useSidebarThreadActions();
  const jumpHint = useJumpHint(thread.id);
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);
  const rowRef = useRef<HTMLLIElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry?.isIntersecting ?? false);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const [isRenaming, setIsRenaming] = useState(false);
  useLayoutEffect(() => {
    return () => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !rowRef.current?.contains(focused)) return;
      const sidebar = rowRef.current.closest<HTMLElement>("[data-bb-sidebar-root]");
      const childId = focused.getAttribute("data-child-thread-id");
      const control = focused.getAttribute("data-thread-control");
      // Moving a row between shelf trees unmounts its focused control.
      queueMicrotask(() => {
        if (!sidebar?.isConnected || document.activeElement !== document.body) return;
        const replacement = [...sidebar.querySelectorAll<HTMLAnchorElement>("a[data-sidebar-thread-id]")]
          .find((link) => link.dataset.sidebarThreadId === thread.id);
        const row = replacement?.closest("li");
        const child = childId && [...(row?.querySelectorAll<HTMLElement>("[data-child-thread-id]") ?? [])]
          .find((item) => item.dataset.childThreadId === childId);
        const matchingControl = control && [...(row?.querySelectorAll<HTMLElement>("[data-thread-control]") ?? [])]
          .find((item) => item.dataset.threadControl === control);
        (child || matchingControl || replacement)?.focus();
      });
    };
  }, [thread.id]);
  const compactAtRenameStart = useRef(false);
  const [isSnoozeOpen, setIsSnoozeOpen] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const settleTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );
  // The sweep plays before the settle is sent, so the row leaves in its
  // finished state instead of vanishing under the cursor.
  const startSettle = () => {
    if (isSettling) return;
    if (!shouldAnimateSettle()) {
      onSettle();
      return;
    }
    setIsSettling(true);
    settleTimer.current = window.setTimeout(() => {
      onSettle();
      settleTimer.current = window.setTimeout(
        () => setIsSettling(false),
        SETTLE_RECOVER_MS,
      );
    }, SETTLE_SWEEP_MS);
  };
  // The sweep keeps the actions up, as an open snooze menu does, so the check
  // it starts from does not disappear when the cursor leaves the row.
  const holdParkActions = isSnoozeOpen || isSettling;
  const childListId = useId();
  const liveStatus = threadShortStatus(thread)?.showsDuration === true;
  // A thread stays folded until everything under it is done; it unfolds at
  // once when it needs you, fails, or just woke.
  const naturalCompact =
    compactWhenWorking &&
    !isWoke &&
    isWorkingTree(thread, childThreads, childrenByParent);
  const compact = isRenaming ? compactAtRenameStart.current : naturalCompact;
  const stripeView = compact ? "collapsed" : "full";
  const projectColor = useProjectColor(thread.projectId);
  const changeRenaming = (editing: boolean) => {
    if (editing) compactAtRenameStart.current = compact;
    setIsRenaming(editing);
    onRenamingChange?.(editing);
  };
  // A folded row stays one line: its children wait for the badge to expand
  // them, whatever "Show children that need attention" says.
  const showChildrenWhenCollapsed = showRunningChildrenWhenCollapsed && !compact;
  const emphasis = isWoke
    ? "woke"
    : thread.isUnread
      ? "unread"
      : thread.indicator === "none"
        ? "read-idle"
        : "active";

  const showParkActions = !isWoke && canPark && (snoozePresets.length > 0 || !!onPark);
  const unpinButton = thread.isPinned ? (
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
        className={cn(
          "shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground",
          "pointer-events-auto",
          !showParkActions &&
            "opacity-0 transition-opacity duration-150 ease-out focus-visible:opacity-100 group-hover/card:opacity-100 motion-reduce:transition-none",
        )}
      >
        <Icon name="PinOff" className="size-3.5" />
      </button>
    </Tooltip>
  ) : null;

  const titleLine = (
    <div
      data-row-emphasis={emphasis}
      data-settle-fade=""
      className={cn(
        "pointer-events-none relative truncate text-sm",
        showProject ? "mt-0.5" : "min-w-0 flex-1",
        isRenaming && "pointer-events-auto",
        emphasis === "read-idle" ? "text-muted-foreground" : "text-foreground",
        (emphasis === "unread" || emphasis === "woke") && "font-medium",
      )}
    >
      <InlineThreadTitle
        thread={thread}
        editing={isRenaming}
        onEditingChange={changeRenaming}
      />
    </div>
  );

  return (
    <RowContextMenu
      thread={thread}
      onPark={canPark ? onPark : undefined}
      canSnooze={canPark}
      canArchive={canPark}
      snoozePresets={snoozePresets}
      onSnooze={onSnooze}
      onSettle={canPark ? startSettle : undefined}
      onRename={() => changeRenaming(true)}
    >
      <li
        ref={rowRef}
        className={cn(
          "list-none",
          // The row stays in the flow — the list reorders around it — but it
          // is drawn over its neighbours rather than under them, so its shadow
          // and ring are not clipped by the rows it sits between.
          reorder?.isDragging && "relative z-20",
        )}
      >
        <div data-drag-visual="">
          <div
            data-parent-card=""
            data-settling={isSettling ? "" : undefined}
            className={cn(
              "group/card relative rounded-md px-2.5 transition-colors duration-150 ease-out motion-reduce:transition-none",
              compact ? "flex h-8 items-center gap-2 text-xs" : "py-2",
              isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
              // A thread open in another pane gets a weaker tint than the active
              // row, so the two states stay distinguishable.
              !isActive && layout !== null && "bg-sidebar-accent/30",
              // Lifted, not faded: the row under the cursor is the one the user
              // is acting on, so it should read as the most present thing on the
              // shelf. The two stacked gradients put an opaque sidebar base under
              // the accent tint, because a translucent row would let the rows it
              // passes over show straight through it.
              reorder?.isDragging &&
                "bg-[linear-gradient(var(--sidebar-accent),var(--sidebar-accent)),linear-gradient(var(--sidebar),var(--sidebar))] shadow-lg ring-1 ring-sidebar-border",
            )}
          >
            {isSettling ? (
              <span aria-hidden="true" className="bb-sidebar-settle-sweep" />
            ) : null}
            {showProject && projectName ? <ProjectStripe projectId={thread.projectId} view={stripeView} /> : null}
            <ThreadDetailsTooltip thread={thread} disabled={isRenaming || !!reorder?.isDragging}>
              <a
                // Both attributes, or bb's nine thread shortcuts stop finding rows.
                data-sidebar-thread-shortcut-target=""
                data-sidebar-thread-id={thread.id}
                href="#"
                aria-label={threadDisplayTitle(thread)}
                aria-current={isActive ? "page" : undefined}
                draggable={false}
                aria-keyshortcuts={
                  reorder ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                }
                onPointerDown={(event) => {
                  splitProps.onPointerDown?.(event);
                  reorder?.onPointerDown(event);
                }}
                onKeyDown={reorder?.onKeyDown}
                onClick={(event) => {
                  event.preventDefault();
                  if (isRenaming || event.detail > 1) return;
                  if (isWoke) onAcknowledgeWake();
                  actions.open(thread.id, { split: false });
                  onNavigate();
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  changeRenaming(true);
                }}
                className={cn(
                  // Vertical panning stays with the scroller; this row never
                  // claims a touch gesture for reordering.
                  "absolute inset-0 touch-pan-y rounded-md",
                  reorder && !reorder.disabled
                    ? "cursor-grab active:cursor-grabbing"
                    : "cursor-pointer",
                )}
              />
            </ThreadDetailsTooltip>
            {compact ? (
              <>
                <span
                  data-settle-fade=""
                  className={cn(
                    "pointer-events-none relative flex min-w-0 flex-1 items-center gap-1",
                    isRenaming && "pointer-events-auto",
                  )}
                >
                  {showProject && projectName && !isRenaming ? (
                    <>
                      <ProjectFavicon projectId={thread.projectId} src={projectIconUrl} name={projectName} className="size-3" />
                      <span style={projectColor} className={cn("max-w-[40%] shrink truncate", projectColor ? "bb-sidebar-project-name" : "text-muted-foreground/70")}>
                        {projectName}
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-sm leading-none text-muted-foreground/60">
                        ·
                      </span>
                    </>
                  ) : null}
                  <InlineThreadTitle
                    thread={thread}
                    editing={isRenaming}
                    onEditingChange={changeRenaming}
                    className={cn(
                      "min-w-0 flex-1 truncate text-foreground",
                      thread.isUnread && "font-medium",
                    )}
                  />
                </span>
                <span className="pointer-events-none relative flex shrink-0 items-center gap-1.5">
                  <OpenPortsIndicator thread={thread} />
                  {childThreads.length > 0 ? (
                    <ChildThreadBadge
                      threads={childThreads}
                      childrenByParent={childrenByParent}
                      expanded={childrenExpanded}
                      controls={childListId}
                      onToggle={onToggleChildren}
                    />
                  ) : null}
                  {jumpHint ? (
                    <JumpHint label={jumpHint} />
                  ) : (
                    <>
                      {unpinButton}
                      {/* The parent's own run time while it works; otherwise its
                          usual status or age, with the badge showing the
                          children still running. */}
                      {liveStatus ? (
                        <CompactLiveStatus thread={thread} now={now} />
                      ) : (
                        <StatusOrTime thread={thread} now={now} />
                      )}
                    </>
                  )}
                </span>
              </>
            ) : (
            <>
            <div className="pointer-events-none relative flex h-5 items-center gap-1.5">
              {showProject ? (
                <span
                  data-settle-fade=""
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-2xs font-medium text-muted-foreground"
                >
                  {projectName ? (
                    <ProjectFavicon projectId={thread.projectId} src={projectIconUrl} name={projectName} className="size-3" />
                  ) : null}
                  <span
                    style={projectColor}
                    className={cn("min-w-0 truncate", projectColor && "bb-sidebar-project-name")}
                  >
                    {projectName ?? " "}
                  </span>
                </span>
              ) : (
                titleLine
              )}
              {/* bb's own rows trade their trailing status for the shortcut
                  while the modifier is held; these do the same. */}
              {jumpHint ? (
                <span className={cn(STATUS_SLOT_CLASS, "w-auto")}>
                  <JumpHint label={jumpHint} />
                </span>
              ) : isWoke ? (
                <span className={cn(STATUS_SLOT_CLASS, "w-auto gap-1.5")}>
                  {unpinButton}
                  <Tooltip label="Dismiss Woke marker">
                    <button
                      type="button"
                      aria-label="Dismiss Woke marker"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onAcknowledgeWake();
                      }}
                      className="pointer-events-auto text-2xs font-medium text-[color:var(--bb-sidebar-woke)] hover:underline"
                    >
                      Woke
                    </button>
                  </Tooltip>
                  <StatusOrTime thread={thread} now={now} />
                </span>
              ) : (
                <span
                  className={cn(
                    STATUS_SLOT_CLASS,
                    "group/status-slot pointer-events-auto relative h-5",
                    showParkActions &&
                      "[@media(hover:none)]:w-auto [@media(hover:none)]:gap-1.5",
                    !showParkActions && "w-auto min-w-20",
                    // Beside the title a fixed slot would cut every title short,
                    // so it hugs the time and widens only while the actions show.
                    !showProject && "w-auto min-w-0",
                    !showProject &&
                      showParkActions &&
                      "[@media(hover:hover)]:group-hover/card:min-w-11 has-[:focus-visible]:min-w-11",
                    !showProject && holdParkActions && "min-w-11",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-end gap-0.5 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                      showParkActions &&
                        "[@media(hover:hover)]:group-hover/card:opacity-0 [@media(hover:hover)]:group-has-[:focus-visible]/status-slot:opacity-0 [@media(hover:none)]:static [@media(hover:none)]:opacity-100",
                      showParkActions && showProject && "absolute inset-y-0 right-0",
                      holdParkActions &&
                        "opacity-0 [@media(hover:none)]:opacity-100",
                    )}
                  >
                    {!showParkActions ? unpinButton : null}
                    <StatusOrTime thread={thread} now={now} />
                  </span>
                  {showParkActions ? (
                    <span
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 motion-reduce:transition-none",
                        holdParkActions && "pointer-events-auto opacity-100",
                      )}
                    >
                      {unpinButton}
                      <SnoozeSelect
                        label="Snooze thread"
                        snoozePresets={snoozePresets}
                        triggerClassName="h-5 w-5 border-0 px-0.5 py-0 shadow-none duration-200 ease-out hover:bg-transparent hover:duration-200 hover:text-[color:var(--bb-sidebar-snooze-active)] focus:ring-0 focus-visible:text-[color:var(--bb-sidebar-snooze-active)] data-[state=open]:text-[color:var(--bb-sidebar-snooze-active)] motion-reduce:transition-none [&>svg:last-child]:size-3"
                        onOpenChange={setIsSnoozeOpen}
                        onSnooze={onSnooze}
                        onPark={onPark}
                      />
                      <ParkButton
                        label="Settle thread"
                        settling={isSettling}
                        onActivate={startSettle}
                      />
                    </span>
                  ) : null}
                </span>
              )}
            </div>
            {showProject ? titleLine : null}
            <div
              data-settle-fade=""
              className="pointer-events-none relative mt-0.5 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground"
            >
              {/* A thread without a worktree still runs somewhere, so the
                  machine takes the branch's place rather than leaving the line
                  blank. */}
              <ThreadLocation thread={thread} />
              <OpenPortsIndicator thread={thread} />
              {childThreads.length > 0 ? (
                <ChildThreadBadge
                  threads={childThreads}
                  childrenByParent={childrenByParent}
                  expanded={childrenExpanded}
                  controls={childListId}
                  onToggle={onToggleChildren}
                />
              ) : null}
              {thread.environment?.branchName && thread.host ? (
                <Icon
                  name="Computer"
                  aria-label={`Machine: ${thread.host.name}`}
                  className="size-3 shrink-0 text-muted-foreground/60"
                />
              ) : null}
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
              {isVisible ? <ThreadPullRequest threadId={thread.id} /> : null}
              <ProviderGlyph
                providerId={thread.providerId}
                provider={provider}
              />
            </div>
            </>
            )}
          </div>
          {childThreads.length > 0 &&
          (childrenExpanded ||
            collapsedChildThreads(
              childThreads,
              childrenByParent,
              activeThreadId,
              showChildrenWhenCollapsed,
            ).length > 0) ? (
            <ChildThreadList
              id={childListId}
              threads={childThreads}
              childrenByParent={childrenByParent}
              activeThreadId={activeThreadId}
              expanded={childrenExpanded}
              showRunningChildrenWhenCollapsed={showChildrenWhenCollapsed}
              parentProjectId={thread.projectId}
              variant="sidebar"
              now={now}
              onOpenThread={(childId) => {
                actions.open(childId, { split: false });
                onNavigate();
              }}
            />
          ) : null}
        </div>
      </li>
    </RowContextMenu>
  );
}

function ThreadLocation({ thread }: { thread: PluginSidebarThread }) {
  const branchName = thread.environment?.branchName;
  if (branchName) {
    const isWorktree =
      thread.environment?.workspaceDisplayKind === "managed-worktree" ||
      thread.environment?.workspaceDisplayKind === "unmanaged-worktree";
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        <Icon
          name={isWorktree ? "FolderGit" : "GitBranch"}
          aria-label={isWorktree ? "Worktree branch" : "Branch"}
          className="size-3 shrink-0 text-muted-foreground/60"
        />
        <span className="truncate font-mono">{branchName}</span>
      </span>
    );
  }
  if (thread.host) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        <Icon
          name="Computer"
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60"
        />
        <span className="truncate">{thread.host.name}</span>
      </span>
    );
  }
  return <span className="flex-1" />;
}


function ThreadPullRequest({ threadId }: { threadId: string }) {
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  if (!pullRequest) return null;
  return (
    <Tooltip
      label={`${pullRequest.title}\n${pullRequestStatusLabel(pullRequest)}`}
      className="whitespace-pre-line"
    >
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "pointer-events-auto relative shrink-0 font-mono hover:underline",
          pullRequestToneClass(pullRequest),
        )}
      >
        #{pullRequest.number}
      </a>
    </Tooltip>
  );
}


function ParkButton({
  label,
  settling,
  onActivate,
}: {
  label: string;
  settling: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-settling={settling ? "" : undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className={cn(
        "bb-sidebar-settle relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground",
        "transition-colors duration-200 ease-out hover:text-[color:var(--bb-sidebar-settle-active)]",
        "focus-visible:text-[color:var(--bb-sidebar-settle-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
        "motion-reduce:transition-none",
        settling && "text-[color:var(--bb-sidebar-settle-active)]",
      )}
    >
      {/* Move only the artwork so hovering an edge cannot move the hit area. */}
      <span
        aria-hidden="true"
        className="bb-sidebar-settle-art pointer-events-none relative flex size-full items-center justify-center rounded-[inherit]"
      >
        <Icon name="Check" aria-hidden className="bb-sidebar-settle-check size-3.5" />
        <span className="bb-sidebar-settle-stars">
          {[0, 1, 2].map((star) => (
            <span key={star} className="bb-sidebar-settle-star" />
          ))}
        </span>
      </span>
    </button>
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
