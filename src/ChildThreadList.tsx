import { useId, useState, type ReactNode } from "react";
import {
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtime,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { Disc } from "./Disc";
import { cn } from "./lib/utils";
import { StatusGlyph } from "./StatusGlyph";
import {
  STATUS_SLOT_CLASS,
  StatusOrTime,
  threadStatusLabel,
  useThreadWithDraft,
} from "./StatusSlot";
import { useWorkingSinceContext } from "./useWorkingSince";
import { threadDisplayTitle } from "./inbox";
import { canParkThread } from "./lifecycle";
import { RowContextMenu } from "./RowContextMenu";
import { InlineThreadTitle } from "./InlineThreadTitle";
import { ThreadDetailsTooltip } from "./ThreadDetailsTooltip";
import { OpenPortsIndicator } from "./OpenPorts";
import {
  childStatusIndicator,
  childStatusKind,
  childStatusPhrase,
  childStatusSummary,
  childSubtree,
  type ChildStatusKind,
} from "./child-status";
import { childThreadSortOf, type ChildThreadSort } from "./sidebar-settings";
import {
  ChildThreadIcon,
  compareChildThreads,
  useChildThreadDisplay,
} from "./ChildThreadDisplay";
import { ProviderGlyph } from "./ProviderGlyph";
import { ProjectFavicon } from "./ProjectFavicon";
import { PROJECT_ICONS_CHANNEL, projectIconUrl } from "./project-icons";

const MAX_CHILD_DOTS = 3;

export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
  sort: ChildThreadSort = childThreadSortOf(null),
): PluginSidebarThread[] {
  return threads
    .filter(
      (thread) =>
        !thread.isArchived && thread.parentThreadId === parentThreadId,
    )
    .sort(compareChildThreads(sort));
}

export function childThreadsByParent(
  threads: readonly PluginSidebarThread[],
  sort: ChildThreadSort = childThreadSortOf(null),
): ReadonlyMap<string, readonly PluginSidebarThread[]> {
  const result = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    if (thread.isArchived || !thread.parentThreadId) continue;
    const siblings = result.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    result.set(thread.parentThreadId, siblings);
  }
  for (const siblings of result.values()) {
    siblings.sort(compareChildThreads(sort));
  }
  return result;
}

export function childNeedsYouCount(
  threads: readonly PluginSidebarThread[],
): number {
  return threads.filter(
    (thread) => !thread.isArchived && thread.hasPendingInteraction,
  ).length;
}

/**
 * Whether a child earns a row while its section is collapsed: anything with
 * a status to report (failed, waiting on the user, finished but unread, or
 * still working). Read and idle children fold away; so does any indicator bb
 * ships later, until it is given a kind. This is the same set the collapsed
 * badge counts, so the rows and the badge never disagree.
 */
export function childNeedsAttention(thread: PluginSidebarThread): boolean {
  return childStatusKind(thread) !== null;
}

/** Children retained while collapsed, including paths to visible descendants. */
export function collapsedChildThreads(
  threads: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  activeThreadId: string | null | undefined,
  showAttentionChildren: boolean,
): PluginSidebarThread[] {
  return threads.filter((child) => {
    if (child.isArchived) return false;
    return childSubtree([child], childrenByParent).some(
      (descendant) =>
        descendant.id === activeThreadId ||
        (showAttentionChildren && childNeedsAttention(descendant)),
    );
  });
}

export function ChildThreadDots({
  threads,
  compact = false,
}: {
  threads: readonly PluginSidebarThread[];
  compact?: boolean;
}) {
  const { iconStyle, providerById } = useChildThreadDisplay();
  const visibleThreads = threads.filter((thread) => !thread.isArchived);
  if (iconStyle === "provider") {
    // One glyph per agent: three identical logos would say nothing.
    const providerIds = [
      ...new Set(visibleThreads.map((thread) => thread.providerId)),
    ].slice(0, MAX_CHILD_DOTS);
    return (
      <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
        {providerIds.map((providerId) => (
          <span key={providerId} data-child-thread-dot="">
            <ProviderGlyph
              providerId={providerId}
              provider={providerById.get(providerId) ?? null}
              className={compact ? "size-3 [&_span]:size-2.5" : undefined}
            />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {visibleThreads.slice(0, MAX_CHILD_DOTS).map((thread, index) => (
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

/**
 * The badge tint for the subtree's most urgent state. Needs-you keeps the
 * amber the rest of the sidebar uses for a raised hand in a child row; the
 * others borrow the status glyph tones so the card and the child rows agree.
 */
function childStatusBadgeClass(kind: ChildStatusKind | null): string {
  switch (kind) {
    case "failed":
      return "bg-[color:var(--bb-sidebar-badge-failed-bg)] text-[color:var(--bb-sidebar-badge-failed-fg)]";
    case "needs-you":
      return "bg-[color:var(--bb-sidebar-badge-needs-you-bg)] text-[color:var(--bb-sidebar-badge-needs-you-fg)]";
    case "done":
      return "bg-[color:var(--bb-sidebar-badge-done-bg)] text-[color:var(--bb-sidebar-badge-done-fg)]";
    case "working":
      return "bg-[color:var(--bb-sidebar-badge-working-bg)] text-[color:var(--bb-sidebar-badge-working-fg)]";
    default:
      return "bg-muted text-foreground";
  }
}

export function ChildThreadBadge({
  threads,
  childrenByParent,
  expanded,
  controls,
  onToggle,
}: {
  threads: readonly PluginSidebarThread[];
  /** When given, descendants count toward the status rollup (not the count). */
  childrenByParent?: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const visibleThreads = threads.filter((thread) => !thread.isArchived);
  const count = visibleThreads.length;
  const summary = childStatusSummary(
    childrenByParent
      ? childSubtree(visibleThreads, childrenByParent)
      : visibleThreads,
  );
  const tooltip = `${count} child thread${count === 1 ? "" : "s"}${childStatusPhrase(summary)}`;

  return (
    <Tooltip label={tooltip} side="bottom">
      <button
        type="button"
        data-thread-control="child-badge"
        aria-label={tooltip}
        aria-expanded={expanded}
        aria-controls={controls}
        data-child-status={summary.dominant ?? undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        className={cn(
          "pointer-events-auto flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium",
          "outline-none focus-visible:ring-1 focus-visible:ring-ring",
          childStatusBadgeClass(summary.dominant),
        )}
      >
        <ChildThreadDots threads={threads} compact />
        <span className="tabular-nums">{count}</span>
        {summary.dominant ? (
          <StatusGlyph
            indicator={childStatusIndicator(summary.dominant)}
            label={null}
            className="size-3 text-current"
          />
        ) : null}
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
  childrenByParent,
  variant,
  now,
  id,
  activeThreadId,
  expanded = true,
  showRunningChildrenWhenCollapsed = false,
  parentProjectId,
  onOpenThread,
}: {
  threads: readonly PluginSidebarThread[];
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  variant: "header" | "sidebar";
  now?: number;
  id?: string;
  activeThreadId?: string | null;
  /** When false, only children on the path to the active descendant show. */
  expanded?: boolean;
  /**
   * While collapsed, also keep children with something to report: failed,
   * waiting on the user, unread, or working. The setting keeps its original
   * key; only its wording changed when it grew beyond running children.
   */
  showRunningChildrenWhenCollapsed?: boolean;
  /** The project of the thread these children hang from. */
  parentProjectId?: string | null;
  onOpenThread: (threadId: string) => void;
}) {
  const disclosureId = useId();
  const { projects } = useSidebarThreads();
  const visibleThreads = expanded
    ? threads.filter((thread) => !thread.isArchived)
    : collapsedChildThreads(
        threads,
        childrenByParent,
        activeThreadId,
        showRunningChildrenWhenCollapsed,
      );
  const [expandedDescendantParentIds, setExpandedDescendantParentIds] =
    useState<ReadonlySet<string>>(() => new Set());

  const toggleDescendants = (threadId: string) => {
    setExpandedDescendantParentIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const renderRows = (
    siblings: readonly PluginSidebarThread[],
    depth: number,
    ancestors: ReadonlySet<string>,
    siblingParentProjectId: string | null | undefined,
  ): ReactNode => siblings
    .map((child) => {
      const path = new Set(ancestors).add(child.id);
      const descendants = (childrenByParent.get(child.id) ?? []).filter(
        (thread) => !thread.isArchived && !path.has(thread.id),
      );
      const descendantsExpanded = expandedDescendantParentIds.has(child.id);
      const visibleDescendants = descendantsExpanded
        ? descendants
        : collapsedChildThreads(
            descendants,
            childrenByParent,
            activeThreadId,
            showRunningChildrenWhenCollapsed,
          );
      const descendantsId = `${disclosureId}-${child.id}`;
      const relation = depth === 1 ? "child"
        : depth === 2 ? "grandchild"
        : depth === 3 ? "great-grandchild" : "descendant";
      const descendantRelation = depth === 1 ? "grandchild"
        : depth === 2 ? "great-grandchild" : "descendant";
      const listLabel = depth === 1 ? "Grandchildren"
        : depth === 2 ? "Great-grandchildren" : "Descendants";
      // Children can live in another project than their parent; say so,
      // since nothing else in the tree shows a row's project.
      const foreignProject =
        siblingParentProjectId != null &&
        child.projectId !== siblingParentProjectId
          ? {
              id: child.projectId,
              name:
                projects.find((project) => project.id === child.projectId)
                  ?.name ?? null,
            }
          : undefined;
      return (
        <li key={child.id} className="list-none">
          <ChildThreadRow
            thread={child}
            relation={relation}
            variant={variant}
            now={now}
            isActive={child.id === activeThreadId}
            foreignProject={foreignProject}
            onOpenThread={onOpenThread}
            disclosure={
              descendants.length > 0
                ? {
                    count: descendants.length,
                    relation: descendantRelation,
                    expanded: descendantsExpanded,
                    controls: descendantsId,
                    onToggle: () => toggleDescendants(child.id),
                  }
                : undefined
            }
          />
          {visibleDescendants.length > 0 ? (
            <ul
              id={descendantsId}
              aria-label={`${listLabel} of ${threadDisplayTitle(child)}`}
              data-grandchild-thread-list={depth === 1 ? variant : undefined}
              className="ml-3 flex flex-col border-l border-border"
            >
              {renderRows(visibleDescendants, depth + 1, path, child.projectId)}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <ul
      id={id}
      aria-label="Child threads"
      data-child-thread-list={variant}
      onContextMenu={(event) => event.stopPropagation()}
      className={cn(
        "flex flex-col",
        variant === "header"
          ? "mb-1.5 ml-1.75 mr-1.5 mt-0.5"
          : "ml-4 mt-1 border-l border-border",
      )}
    >
      {renderRows(visibleThreads, 1, new Set(), parentProjectId)}
    </ul>
  );
}

interface ForeignProject {
  id: string;
  name: string | null;
}

interface GrandchildDisclosure {
  count: number;
  relation: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}

function ChildThreadRow({
  thread,
  relation,
  variant,
  now,
  isActive = false,
  foreignProject,
  onOpenThread,
  disclosure,
}: {
  thread: PluginSidebarThread;
  relation: string;
  variant: "header" | "sidebar";
  now?: number;
  isActive?: boolean;
  /** Set when the thread's project differs from its parent's. */
  foreignProject?: ForeignProject;
  onOpenThread: (threadId: string) => void;
  disclosure?: GrandchildDisclosure;
}) {
  const title = threadDisplayTitle(thread);
  const needsYou = thread.hasPendingInteraction;
  const effectiveNow = now ?? Date.now();
  const workingSince = useWorkingSinceContext();
  const statusThread = useThreadWithDraft(thread);
  const visibleStatus = threadStatusLabel(
    statusThread,
    workingSince.get(thread.id),
    effectiveNow,
  );
  const [isRenaming, setIsRenaming] = useState(false);
  const { splitProps } = experimental_useSidebarThreadSplit(thread.id);
  const RowAction = isRenaming ? "div" : "button";

  return (
    <RowContextMenu
      thread={thread}
      canArchive={canParkThread(thread)}
      onRename={() => setIsRenaming(true)}
    >
      <div
        data-child-thread-row=""
        data-active={isActive ? "true" : undefined}
        className={cn(
          "flex w-full items-center rounded-md text-left",
          variant === "header"
            ? "hover:bg-accent"
            : "h-7 hover:bg-sidebar-accent/60",
          variant === "sidebar" &&
            needsYou &&
            !isActive &&
            cn(
              "bg-[color:var(--bb-sidebar-needs-you-tint)]",
              "hover:bg-[color:var(--bb-sidebar-needs-you-tint-hover)]",
              // In dark the amber fill is only a 1.07:1 step off the sidebar,
              // so a leading rule carries where the fill cannot. It is
              // transparent in light, where the cream band already reads.
              "shadow-[inset_2px_0_0_0_var(--bb-sidebar-needs-you-accent)]",
            ),
          // The open chat gets the same tint as an active parent card, so the
          // eye finds it in a long tree the way it finds a card in the list.
          isActive &&
            (variant === "header"
              ? "bg-accent"
              : "bg-sidebar-accent hover:bg-sidebar-accent"),
        )}
      >
        <ThreadDetailsTooltip thread={thread} disabled={isRenaming}>
          <RowAction
            data-child-thread-id={thread.id}
            type={isRenaming ? undefined : "button"}
            aria-label={
              isRenaming
                ? undefined
                : childThreadOpenLabel(
                    relation,
                    title,
                    visibleStatus,
                    foreignProject,
                  )
            }
            aria-current={isActive && !isRenaming ? "page" : undefined}
            draggable={false}
            onPointerDown={isRenaming ? undefined : splitProps.onPointerDown}
            onClick={isRenaming ? undefined : () => onOpenThread(thread.id)}
            onKeyDown={isRenaming ? (event) => event.stopPropagation() : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
              isRenaming
                ? "cursor-auto"
                : splitProps.onPointerDown
                  ? "cursor-grab active:cursor-grabbing"
                  : "cursor-pointer",
              variant === "header"
                ? "gap-1.25 rounded-md py-1.5 pl-1.25 pr-1.5"
                : "h-full gap-1.25 rounded-md pl-1.25",
            )}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <ChildThreadIcon
                thread={thread}
                discClassName={
                  variant === "header" ? undefined : "size-2 border-0"
                }
              />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-xs",
                variant === "header" ? "flex flex-col" : "truncate",
                isActive && "font-medium text-foreground",
              )}
            >
              <InlineThreadTitle
                thread={thread}
                editing={isRenaming}
                onEditingChange={setIsRenaming}
                className="truncate"
              />
              {variant === "header" ? (
                <span className="truncate text-2xs text-muted-foreground">
                  {thread.originKind ?? "thread"}
                  {foreignProject?.name ? ` · ${foreignProject.name}` : null}
                </span>
              ) : null}
            </span>
            {foreignProject ? (
              <ForeignProjectMark project={foreignProject} />
            ) : null}
            <OpenPortsIndicator thread={thread} />
            {variant === "header" ? (
              <span className="shrink-0">
                <StatusGlyph
                  indicator={statusThread.indicator}
                  label={statusThread.indicatorLabel}
                />
              </span>
            ) : null}
            {variant === "sidebar" ? (
              // Match parent cards: a recognized status owns the trailing
              // slot; an idle or future unknown status leaves it to the age.
              //
              // Sized to the label rather than fixed at the 112px "Monitoring
              // · 27m" needs: a child row also pays an indent rail and a
              // grandchild disclosure, so at a 280px sidebar a fixed slot left
              // the title about six characters. No floor either: the label is
              // right-aligned, so a floor under "8h" is only empty space the
              // title could use. The ceiling keeps the longest status intact;
              // the cost is that the title's truncation point shifts with the
              // length of that row's status.
              <span
                className={cn(STATUS_SLOT_CLASS, "w-auto max-w-28 pr-2")}
              >
                <StatusOrTime thread={thread} now={effectiveNow} />
              </span>
            ) : null}
          </RowAction>
        </ThreadDetailsTooltip>
        {disclosure ? (
          <GrandchildDisclosureButton title={title} {...disclosure} />
        ) : null}
      </div>
    </RowContextMenu>
  );
}

function childThreadOpenLabel(
  relation: string,
  title: string,
  status: string | null,
  foreignProject?: ForeignProject,
): string {
  const project = foreignProject
    ? `, in ${foreignProject.name ? `project ${foreignProject.name}` : "another project"}`
    : "";
  return `Open ${relation} thread: ${title}${project}${status ? `, ${status}` : ""}`;
}

/**
 * The project icon on a child from another project than its parent. Only
 * these rows subscribe to icon updates; same-project rows draw nothing.
 */
function ForeignProjectMark({ project }: { project: ForeignProject }) {
  const [iconRevision, setIconRevision] = useState(0);
  useRealtime(PROJECT_ICONS_CHANNEL, () => {
    setIconRevision((revision) => revision + 1);
  });
  return (
    <span
      data-foreign-project={project.id}
      className="flex shrink-0 items-center pl-1"
    >
      <ProjectFavicon
        src={projectIconUrl(project.id, iconRevision)}
        name={project.name}
        className="size-3"
      />
    </span>
  );
}

function GrandchildDisclosureButton({
  title,
  count,
  relation,
  expanded,
  controls,
  onToggle,
}: GrandchildDisclosure & { title: string }) {
  const noun = `${relation} thread${count === 1 ? "" : "s"}`;
  const label = `${expanded ? "Hide" : "Show"} ${count} ${noun} for ${title}`;

  return (
    <Tooltip label={`${count} ${noun}`} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        className="group mr-1 flex h-6 min-w-9 shrink-0 items-center justify-center rounded-full bg-transparent px-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="inline-flex h-4.5 min-w-8 items-center justify-center gap-0.5 rounded-full bg-muted px-1 text-muted-foreground group-hover:bg-accent group-hover:text-foreground group-focus-visible:bg-accent group-focus-visible:text-foreground">
          <span className="min-w-2.5 text-center font-sans text-2xs font-medium tabular-nums">
            {count}
          </span>
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            className="size-3"
            aria-hidden
          />
        </span>
      </button>
    </Tooltip>
  );
}
