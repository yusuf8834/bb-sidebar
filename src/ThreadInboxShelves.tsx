import { useListMotion } from "./useListMotion";
import { useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "./components/Icon";
import { cn } from "./lib/utils";
import { ProjectFavicon, ProjectStripe } from "./ProjectFavicon";
import { useProjectColor } from "./ProjectColors";
import type { ThreadReorderControls } from "./ThreadCard";
import { SlimRow } from "./SlimRow";
import { CleanSettledDialog } from "./CleanSettledDialog";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";
import { projectIconUrl } from "./project-icons";
import type { GroupAlert, ProjectViewUnit } from "./inbox-layout";
import { EnvironmentGroup } from "./EnvironmentGroup";
import { GroupAlertDots, groupAlertPhrase } from "./GroupAlertDots";
import { environmentLabel } from "./environment-groups";
import { useInboxEnvironment, useInboxActions, useInboxActivity } from "./InboxContext";

export const SETTLED_PAGE_SIZE = 25;

/**
 * A collapsed shelf of parked threads. The header stays while anything is
 * parked — the count is the whole footprint when collapsed — and the shelf
 * vanishes entirely at zero.
 */
export function CompactShelf({
  label,
  icon,
  threads,
  expanded,
  onToggle,
  shelf,
  visibleThreads,
  settledLimit,
  onLoadMore,
  expandedChildParentIds,
}: {
  label: string;
  icon: IconName;
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  onToggle: () => void;
  shelf: "parked" | "snoozed" | "settled";
  visibleThreads: readonly PluginSidebarThread[];
  settledLimit?: number;
  onLoadMore?: () => void;
  expandedChildParentIds: ReadonlySet<string>;
}) {
  const { lifecycle } = useInboxEnvironment();
  const { activeThreadId, now: clockNow } = useInboxActivity();
  const { onNavigate } = useInboxActions();
  const attachListMotionRef = useListMotion<HTMLUListElement>();
  const now = useMemo(() => Date.now(), [clockNow, visibleThreads]);
  if (threads.length === 0 && shelf !== "settled") return null;
  const limit = shelf === "settled" ? (settledLimit ?? threads.length) : threads.length;
  const hasMore = shelf === "settled" && threads.length > limit;
  return (
    <CollapsibleShelf
      label={label}
      hidden={threads.length === 0}
      icon={icon}
      count={threads.length}
      expanded={expanded}
      onToggle={onToggle}
      action={
        shelf === "settled" ? (
          <CleanSettledDialog threadIds={threads.map((thread) => thread.id)} onNavigate={onNavigate} />
        ) : undefined
      }
    >
      <ul ref={attachListMotionRef} className="flex flex-col gap-px">
        {visibleThreads.map((thread) => (
          <SlimRow
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            shelf={shelf}
            parkedAt={lifecycle.parkedAtFor(thread)}
            wakeAt={lifecycle.wakeAtFor(thread)}
            now={now}
            childrenExpanded={expandedChildParentIds.has(thread.id)}
          />
        ))}
      </ul>
      {expanded && hasMore && onLoadMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="ml-2.5 mt-1 rounded px-1.5 py-1 text-2xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          Load {Math.min(SETTLED_PAGE_SIZE, threads.length - limit)} more
        </button>
      ) : null}
    </CollapsibleShelf>
  );
}

/**
 * The shelves as one scrolling list. Docked, the list fills at least the
 * sidebar's height and the shelves after Active take the space left over at
 * the top of their group, so while they are short they rest at the bottom;
 * an open shelf longer than the room simply extends the list, and everything
 * scrolls together. T3 Code's sidebar anchors its shelves the same way.
 */
export function DockableShelves({
  docked,
  upper,
  lower,
  attachUpperRef,
  attachLowerRef,
}: {
  docked: boolean;
  upper: React.ReactNode;
  lower: React.ReactNode;
  attachUpperRef: (node: HTMLDivElement | null) => void;
  attachLowerRef: (node: HTMLDivElement | null) => void;
}) {
  if (!docked) {
    return (
      <div ref={attachUpperRef} className="flex flex-col">
        {upper}
        {lower}
      </div>
    );
  }
  return (
    <div className="flex min-h-full flex-col">
      <div ref={attachUpperRef} className="flex flex-col">
        {upper}
      </div>
      <div ref={attachLowerRef} data-shelf-dock="" className="mt-auto flex flex-col">
        {lower}
      </div>
    </div>
  );
}

export function CollapsibleShelf({
  label,
  icon,
  animateIcon = false,
  count,
  expanded,
  onToggle,
  action,
  children,
  hidden = false,
}: {
  label: string;
  icon: IconName;
  animateIcon?: boolean;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
  hidden?: boolean;
}) {
  return (
    <section aria-label={label} hidden={hidden}>
      <div className="relative">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          // Padded like a card, so the chevron ends on the same right edge as
          // every row's status and provider glyph.
          className="mt-3 flex w-full items-center gap-2 px-2.5 pb-1 text-left"
        >
          <span className="flex shrink-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground/70">
            <Icon
              name={icon}
              className={cn("size-3.5 shrink-0", animateIcon && "animate-spin motion-reduce:animate-none")}
              aria-hidden
            />
            {expanded ? label : `${label} (${count})`}
          </span>
          <span className="h-px flex-1 bg-sidebar-border" />
          {action ? <span aria-hidden="true" className="size-4 shrink-0" /> : null}
          <span className={TRAILING_GLYPH_BOX_CLASS}>
            <Icon
              name="ChevronDown"
              className={cn(
                "size-3 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
          </span>
        </button>
        {action}
      </div>
      {children}
    </section>
  );
}

function ActiveProjectGroup({
  unitKey,
  projectId,
  projectName,
  projectIconUrl,
  threadCount,
  alerts,
  expanded,
  onToggle,
  reorder,
  children,
}: {
  unitKey: string;
  projectId: string;
  projectName: string;
  projectIconUrl: string | null;
  threadCount: number;
  alerts: readonly GroupAlert[];
  expanded: boolean;
  onToggle: () => void;
  reorder: ThreadReorderControls;
  children: React.ReactNode;
}) {
  const stripeView = expanded ? "group-full" : "group-collapsed";
  const projectColor = useProjectColor(projectId);
  const attachListMotionRef = useListMotion<HTMLUListElement>();
  return (
    // One item of the top-level list, so the whole project is a single drop
    // target when projects are dragged around each other.
    <li
      data-reorder-unit={unitKey}
      className={cn(
        "list-none rounded-md",
        reorder.isDragging &&
          "relative z-20 bg-[linear-gradient(var(--sidebar-accent),var(--sidebar-accent)),linear-gradient(var(--sidebar),var(--sidebar))] shadow-lg ring-1 ring-sidebar-border",
      )}
    >
      <section data-drag-visual="" className="relative" aria-label={`${projectName} project`}>
        <ProjectStripe projectId={projectId} view={stripeView} className="z-10" />
        <button
          type="button"
          data-reorder-key={unitKey}
          onClick={onToggle}
          onPointerDown={reorder.onPointerDown}
          onKeyDown={reorder.onKeyDown}
          aria-expanded={expanded}
          aria-label={`${projectName} (${threadCount})${groupAlertPhrase(alerts)}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          // Padded like a card, so the name lines up with every row's title and
          // the chevron with every row's trailing glyph. Vertical panning stays
          // with the scroller, as on a row.
          className={cn(
            "flex w-full touch-pan-y items-center gap-1.5 px-2.5 text-left",
            expanded ? "pb-0.5 pt-2" : "py-1.5",
            !reorder.disabled && "cursor-grab active:cursor-grabbing",
          )}
        >
          <ProjectFavicon projectId={projectId} src={projectIconUrl} name={projectName} className="size-3" />
          <span
            style={projectColor}
            className={cn(
              "min-w-0 truncate text-2xs font-medium",
              projectColor ? "bb-sidebar-project-name" : "text-muted-foreground",
            )}
          >
            {projectName}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground/50">{threadCount}</span>
          <GroupAlertDots alerts={alerts} />
          <span className="h-px flex-1 bg-sidebar-border/50" />
          <span className={TRAILING_GLYPH_BOX_CLASS}>
            <Icon
              name="ChevronDown"
              className={cn(
                "size-3 text-muted-foreground/50 transition-transform duration-150 ease-out motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
          </span>
        </button>
        <ul ref={attachListMotionRef} aria-label={`${projectName} active threads`} className="flex flex-col gap-px">
          {children}
        </ul>
      </section>
    </li>
  );
}

/** Lone threads and whole projects, in one list so either can pass the other. */
export function ProjectGroups({
  units,
  reorderControls,
  renderThread,
  onToggleEnvironment,
}: {
  units: readonly ProjectViewUnit[];
  reorderControls: (unit: Extract<ProjectViewUnit, { kind: "group" }>, projectName: string) => ThreadReorderControls;
  renderThread: (thread: PluginSidebarThread, grouped: boolean, environmentGrouped?: boolean) => React.ReactNode;
  onToggleEnvironment: (key: string) => void;
}) {
  const { projectNameById, projectIconRevision } = useInboxEnvironment();
  const { toggleProjectCollapse: onToggle } = useInboxActions();
  const attachListMotionRef = useListMotion<HTMLUListElement>();
  if (units.length === 0) return null;
  return (
    <ul ref={attachListMotionRef} className="flex flex-col gap-px">
      {units.map((unit) => {
        if (unit.kind === "thread") return renderThread(unit.thread, false);
        const projectName = projectNameById.get(unit.projectId) ?? "Project";
        return (
          <ActiveProjectGroup
            key={unit.key}
            unitKey={unit.key}
            projectId={unit.projectId}
            projectName={projectName}
            projectIconUrl={projectIconUrl(unit.projectId, projectIconRevision)}
            threadCount={unit.threadCount}
            alerts={unit.alerts}
            expanded={unit.expanded}
            onToggle={() => onToggle(unit.projectId)}
            reorder={reorderControls(unit, projectName)}
          >
            {unit.children
              ? unit.children.map((child) =>
                  child.kind === "thread" ? (
                    renderThread(child.thread, true)
                  ) : (
                    <EnvironmentGroup
                      key={child.key}
                      unit={child}
                      onToggle={() => onToggleEnvironment(child.key)}
                      reorder={reorderControls(child, environmentLabel(child.environment!))}
                    >
                      {child.threads.map((thread) => renderThread(thread, true, true))}
                    </EnvironmentGroup>
                  ),
                )
              : unit.threads.map((thread) => renderThread(thread, true))}
          </ActiveProjectGroup>
        );
      })}
    </ul>
  );
}

export function Shelf({ label, children }: { label: string | null; children: React.ReactNode }) {
  const attachListMotionRef = useListMotion<HTMLUListElement>();
  return (
    // A named section is exposed as a landmark region; shelf rows stay in an
    // unnamed list beneath their collapsible heading.
    <section {...(label ? { "aria-label": label } : {})}>
      {label ? (
        <h2 className={cn("flex items-center gap-2 px-2.5 pb-1 pt-3")}>
          <span className="text-2xs font-medium text-muted-foreground/70">{label}</span>
          <span className="h-px flex-1 bg-sidebar-border" />
        </h2>
      ) : null}
      <ul ref={attachListMotionRef} className="flex flex-col gap-px">
        {children}
      </ul>
    </section>
  );
}
