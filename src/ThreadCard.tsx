import { ThreadLocation, ThreadPullRequest } from "./ThreadMetadata";
import { CompactRow } from "./CompactRow";
import { WokeMarker } from "./WokeMarker";
import { ShortcutHint, useSidebarThreadSplit, useThreadActions } from "./bb-sdk";
import {
  useId,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
} from "react";
import { useSidebarThreadShortcut, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ChildThreadBadge, ChildThreadList } from "./ChildThreadList";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { ThreadDetailsTooltip } from "./ThreadDetailsTooltip";
import { SnoozeSelect } from "./SnoozeSelect";
import { cn } from "./lib/utils";
import { rowKeyshortcuts } from "./lib/keyshortcuts";
import { RowContextMenu } from "./RowContextMenu";
import { ProviderGlyph } from "./ProviderGlyph";
import { STATUS_SLOT_CLASS, StatusOrTime, useWorkingForDisplay } from "./StatusSlot";
import { CompactStatusOrTime } from "./StatusGlyph";
import { threadDisplayTitle } from "./inbox";
import { InlineThreadTitle } from "./InlineThreadTitle";
import { isWorkingTree } from "./working-tree";
import { ProjectFavicon, ProjectStripe } from "./ProjectFavicon";
import { useProjectColor } from "./ProjectColors";
import { OpenPortsIndicator } from "./OpenPorts";
import { useThreadLimit } from "./RateLimits";
import { useInboxEnvironment, useInboxActions, useInboxActivity } from "./InboxContext";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { useRowStatusRuns } from "./useLifecycle";
import { projectIconUrl as iconUrl } from "./project-icons";
import "./settle-button.css";

/** How long the settle sweep plays before the thread actually moves. */
const SETTLE_SWEEP_MS = 520;
/** A settle that worked has unmounted the card by now; one that failed has not. */
const SETTLE_RECOVER_MS = 4_000;

function shouldAnimateSettle(): boolean {
  return typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ThreadReorderControls {
  disabled: boolean;
  isDragging: boolean;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
}

/**
 * Three-line card, or one line in compact mode. Project groups omit the project
 * line. Status follows manual reorders. Controls sit above a full-bleed anchor
 * for valid markup and keyboard access.
 */
export function ThreadCard({
  thread,
  showProject = true,
  projectIconOnly = false,
  showEnvironment = true,
  isActive,
  isWoke,
  canPark,
  childThreads,
  childrenExpanded,
  reorder,
  compactWhenWorking = false,
  compactAlways = false,
  onRenamingChange,
}: {
  thread: PluginSidebarThread;
  /** False when a group header already names the project. */
  showProject?: boolean;
  projectIconOnly?: boolean;
  showEnvironment?: boolean;
  isActive: boolean;
  /** A snooze ended and has not yet been acknowledged. */
  isWoke: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  childThreads: readonly PluginSidebarThread[];
  childrenExpanded: boolean;
  reorder?: ThreadReorderControls;
  /** Experimental: show threads with live work as a single line. */
  compactWhenWorking?: boolean;
  /** Compact all threads: one line regardless of work, woke state included. */
  compactAlways?: boolean;
  onRenamingChange?: (editing: boolean) => void;
}) {
  const [pin] = useThreadActions(thread, { keys: ["bb--core/pin"] });
  const limit = useThreadLimit(thread);
  const {
    providerById,
    projectNameById,
    projectIconRevision,
    snoozePresets,
    childrenByParentId: childrenByParent,
    sidebarSettings,
  } = useInboxEnvironment();
  const { onNavigate, parkThread, settleThread, snoozeThread, acknowledgeWake, toggleChildExpansion } =
    useInboxActions();
  const { now } = useInboxActivity();
  const provider = providerById.get(thread.providerId) ?? null;
  const projectName = projectNameById.get(thread.projectId) ?? null;
  const projectIconUrl = iconUrl(thread.projectId, projectIconRevision);
  const showRunningChildrenWhenCollapsed =
    sidebarSettings?.showRunningChildrenWhenCollapsed ?? DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed;
  const onPark = () => parkThread(thread);
  const onSettle = () => settleThread(thread);
  const onSnooze = (until: number) => snoozeThread(thread, until);
  const onAcknowledgeWake = () => acknowledgeWake(thread.id);
  const onToggleChildren = () => toggleChildExpansion(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
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
        const replacement = [...sidebar.querySelectorAll<HTMLAnchorElement>("a[data-sidebar-thread-id]")].find(
          (link) => link.dataset.sidebarThreadId === thread.id,
        );
        const row = replacement?.closest("li");
        const child =
          childId &&
          [...(row?.querySelectorAll<HTMLElement>("[data-child-thread-id]") ?? [])].find(
            (item) => item.dataset.childThreadId === childId,
          );
        const matchingControl =
          control &&
          [...(row?.querySelectorAll<HTMLElement>("[data-thread-control]") ?? [])].find(
            (item) => item.dataset.threadControl === control,
          );
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
      settleTimer.current = window.setTimeout(() => setIsSettling(false), SETTLE_RECOVER_MS);
    }, SETTLE_SWEEP_MS);
  };
  // The sweep keeps the actions up, as an open snooze menu does, so the check
  // it starts from does not disappear when the cursor leaves the row.
  const holdParkActions = isSnoozeOpen || isSettling;
  const childListId = useId();
  // Keep busy trees compact until a failure, question, or wake needs attention.
  const working = useWorkingForDisplay();
  const naturalCompact =
    compactAlways || (compactWhenWorking && !isWoke && isWorkingTree(thread, childThreads, childrenByParent, working));
  const compact = isRenaming ? compactAtRenameStart.current : naturalCompact;
  const stripeView = compact ? "collapsed" : "full";
  const projectColor = useProjectColor(thread.projectId);
  const changeRenaming = (editing: boolean) => {
    if (editing) compactAtRenameStart.current = compact;
    setIsRenaming(editing);
    onRenamingChange?.(editing);
  };
  // Collapsed cards leave their child rows behind the expansion badge.
  const showChildrenWhenCollapsed = showRunningChildrenWhenCollapsed && !compact;
  const emphasis = isWoke ? "woke" : thread.isUnread ? "unread" : thread.indicator === "none" ? "read-idle" : "active";
  const canShelve = !useRowStatusRuns(thread.id) && canPark;
  const showParkActions = !isWoke && canShelve && (snoozePresets.length > 0 || !!onPark);

  const unpinButton = thread.isPinned ? (
    <Tooltip label="Unpin thread">
      <button
        type="button"
        aria-label={`Unpin ${threadDisplayTitle(thread)}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void pin?.action.run();
        }}
        className={cn(
          "shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground",
          "pointer-events-auto",
          (compact || !showParkActions) &&
            "opacity-0 transition-opacity duration-150 ease-out focus-visible:opacity-100 group-hover/card:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100",
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
      <InlineThreadTitle thread={thread} editing={isRenaming} onEditingChange={changeRenaming} />
    </div>
  );

  return (
    <RowContextMenu
      thread={thread}
      onPark={canShelve ? onPark : undefined}
      canSnooze={canShelve}
      canArchive={canPark}
      snoozePresets={snoozePresets}
      onSnooze={onSnooze}
      onSettle={canShelve ? startSettle : undefined}
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
          {compact ? (
            <CompactRow
              thread={thread}
              tone="normal"
              showProject={showProject}
              projectIconOnly={projectIconOnly}
              projectName={projectName}
              projectIconUrl={projectIconUrl}
              projectColor={projectColor}
              label={threadDisplayTitle(thread)}
              isActive={isActive}
              isSplitOpen={layout !== null}
              isDragging={!!reorder?.isDragging}
              isRenaming={isRenaming}
              onRenamingChange={changeRenaming}
              onOpen={() => {
                if (isWoke) onAcknowledgeWake();
                onNavigate();
              }}
              rowProps={{ "data-parent-card": "", "data-settling": isSettling ? "" : undefined }}
              linkProps={{
                draggable: false,
                "aria-keyshortcuts": rowKeyshortcuts(shortcut?.ariaKeyshortcuts, !!reorder),
                onPointerDown: (event) => {
                  splitProps.onPointerDown?.(event);
                  reorder?.onPointerDown(event);
                },
                onKeyDown: reorder?.onKeyDown,
                // Vertical panning stays with the scroller during reordering.
                className: cn(
                  "absolute inset-0 touch-pan-y rounded-md",
                  reorder && !reorder.disabled ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                ),
              }}
              beforeContent={isSettling ? <span aria-hidden="true" className="bb-sidebar-settle-sweep" /> : null}
              fadeContent
              trailing={
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
                  {shortcut ? (
                    <ShortcutHint shortcut={shortcut} />
                  ) : (
                    <>
                      {unpinButton}
                      {isWoke ? <WokeMarker onDismiss={onAcknowledgeWake} /> : null}
                      <CompactStatusOrTime thread={thread} now={now} />
                    </>
                  )}
                  <ProviderGlyph providerId={thread.providerId} provider={provider} />
                </span>
              }
            />
          ) : (
            <div
              data-parent-card=""
              data-settling={isSettling ? "" : undefined}
              className={cn(
                "group/card relative rounded-md px-2.5 transition-colors duration-150 ease-out motion-reduce:transition-none",
                compact ? "flex h-8 items-center gap-2 text-xs" : "py-2",
                !compact && !showEnvironment && "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 py-1.5",
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
              {isSettling ? <span aria-hidden="true" className="bb-sidebar-settle-sweep" /> : null}
              {showProject && projectName ? <ProjectStripe projectId={thread.projectId} view={stripeView} /> : null}
              <ThreadDetailsTooltip thread={thread} disabled={isRenaming || !!reorder?.isDragging}>
                <a
                  // Both attributes, or bb's nine thread shortcuts stop finding rows.
                  data-sidebar-thread-shortcut-target=""
                  data-sidebar-thread-id={thread.id}
                  href={thread.href}
                  aria-label={threadDisplayTitle(thread)}
                  aria-current={isActive ? "page" : undefined}
                  draggable={false}
                  aria-keyshortcuts={rowKeyshortcuts(shortcut?.ariaKeyshortcuts, !!reorder)}
                  onPointerDown={(event) => {
                    splitProps.onPointerDown?.(event);
                    reorder?.onPointerDown(event);
                  }}
                  onKeyDown={reorder?.onKeyDown}
                  onClick={(event) => {
                    if (isRenaming || event.detail > 1) {
                      event.preventDefault();
                      return;
                    }
                    if (isWoke) onAcknowledgeWake();
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
                    reorder && !reorder.disabled ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                  )}
                />
              </ThreadDetailsTooltip>
              <div className="pointer-events-none relative flex h-5 min-w-0 items-center gap-1.5">
                {showProject ? (
                  <span
                    data-settle-fade=""
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-2xs font-medium text-muted-foreground"
                  >
                    {projectName ? (
                      <ProjectFavicon
                        projectId={thread.projectId}
                        src={projectIconUrl}
                        name={projectName}
                        className="size-3"
                      />
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
                {/* Show bb's thread shortcut in place of the status while the modifier is held. */}
                {shortcut ? (
                  <span className={cn(STATUS_SLOT_CLASS, "w-auto")}>
                    <ShortcutHint shortcut={shortcut} />
                  </span>
                ) : isWoke ? (
                  <span className={cn(STATUS_SLOT_CLASS, "w-auto gap-1.5")}>
                    {unpinButton}
                    <WokeMarker onDismiss={onAcknowledgeWake} />
                    <StatusOrTime thread={thread} now={now} />
                  </span>
                ) : (
                  <span
                    className={cn(
                      STATUS_SLOT_CLASS,
                      "group/status-slot pointer-events-auto relative h-5",
                      showParkActions && "[@media(hover:none)]:w-auto [@media(hover:none)]:gap-1.5",
                      (limit || !showParkActions) && "w-auto min-w-20",
                      limit && "[&_[data-limit-control]]:static [&_[role=status]]:absolute [&_[role=status]]:right-0",
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
                          !limit &&
                          "[@media(hover:hover)]:group-hover/card:opacity-0 [@media(hover:hover)]:group-has-[:focus-visible]/status-slot:opacity-0 [@media(hover:none)]:static [@media(hover:none)]:opacity-100",
                        showParkActions && !limit && showProject && "absolute inset-y-0 right-0",
                        holdParkActions && !limit && "opacity-0 [@media(hover:none)]:opacity-100",
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
                          limit && "relative ml-1.5",
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
                        <ParkButton label="Settle thread" settling={isSettling} onActivate={startSettle} />
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              {showProject ? titleLine : null}
              <div
                data-settle-fade=""
                className={cn(
                  "pointer-events-none relative flex items-center gap-1.5 text-2xs text-muted-foreground",
                  showEnvironment ? "mt-0.5 h-4" : "h-5",
                )}
              >
                {/* A thread without a worktree still runs somewhere, so the
                  machine takes the branch's place rather than leaving the line
                  blank. */}
                {showEnvironment ? <ThreadLocation thread={thread} /> : null}
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
                  <ActivityCount label="workflows" count={thread.activity.workflows} />
                ) : null}
                {thread.activity.backgroundAgents > 0 ? (
                  <ActivityCount label="background agents" count={thread.activity.backgroundAgents} />
                ) : null}
                {isVisible ? <ThreadPullRequest environmentId={thread.environment?.id ?? null} /> : null}
                <ProviderGlyph providerId={thread.providerId} provider={provider} />
              </div>
            </div>
          )}
          {childThreads.length > 0 ? (
            <ChildThreadList
              id={childListId}
              threads={childThreads}
              expanded={childrenExpanded}
              showRunningChildrenWhenCollapsed={showChildrenWhenCollapsed}
              parentProjectId={thread.projectId}
            />
          ) : null}
        </div>
      </li>
    </RowContextMenu>
  );
}

function ParkButton({ label, settling, onActivate }: { label: string; settling: boolean; onActivate: () => void }) {
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
