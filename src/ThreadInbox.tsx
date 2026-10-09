import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useProviders as useProviders,
  type PluginSidebarThread,
  type PluginThreadListProps,
  useRealtime,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  autoAnimate,
  type AnimationController,
} from "@formkit/auto-animate";
import { toast } from "sonner";
import { Icon, type IconName } from "./components/Icon";
import { cn } from "./lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./components/Select";
import { ProjectScopeSelect } from "./ProjectScopeSelect";
import { ProjectFavicon, ProjectStripe } from "./ProjectFavicon";
import { ProjectColorsProvider, useProjectColor } from "./ProjectColors";
import { ThreadCard, type ThreadReorderControls } from "./ThreadCard";
import { SlimRow } from "./SlimRow";
import { CleanSettledDialog } from "./CleanSettledDialog";
import { SearchResults } from "./SearchResults";
import { childThreadsByParent, collapsedChildThreads } from "./ChildThreadList";
import {
  ChildThreadDisplayContext,
  useChildThreadDisplayValue,
} from "./ChildThreadDisplay";
import { useLifecycle, type LifecycleApi } from "./useLifecycle";
import { createDragPreview } from "./drag-preview";
import { usePinnedReorder } from "./usePinnedReorder";
import { useInboxReorder } from "./useInboxReorder";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";
import { WorkingSinceContext, useWorkingSince } from "./useWorkingSince";
import { JumpHintsContext, useJumpHints } from "./JumpHints";
import { useSidebarSettings } from "./useSidebarSettings";
import { OpenPortsProvider } from "./OpenPorts";
import {
  ALL_PROJECTS,
  filterByProject,
  hideChildrenOfVisibleParents,
  partitionPinned,
  reconcileProjectScope,
  searchThreadsByTitle,
  sortByCreatedAtDescending,
  sortSettledThreads,
  threadDisplayTitle,
  visibleInboxThreads,
} from "./inbox";
import {
  movePinnedId,
  movePinnedIdByOffset,
  orderPinnedThreads,
  orderSubsetInPlace,
  rebaseMovedId,
  rebaseMovedUnit,
  type OrderUnit,
} from "./pinned-order";
import {
  DEFAULT_SNOOZE_PRESET_CONFIG,
  parseConfiguredSnoozePresets,
  type ConfiguredSnoozePreset,
} from "./lifecycle";
import {
  DEFAULT_INACTIVE_AFTER_HOURS,
  isInactiveThread,
  parseInactiveAfterHours,
} from "./inactive";
import {
  PROJECT_ICONS_CHANNEL,
  projectIconUrl,
} from "./project-icons";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { isWorkingTree } from "./working-tree";
import { pickWorkingEmptyLine } from "./working-empty-lines";
import "./working-empty-state.css";
import { SCROLL_FADE_CLASS, useScrollFade } from "./useScrollFade";
import {
  MAX_CHILD_EXPANSION,
  pruneChildExpansion,
  safeSetItem,
} from "./lib/safe-storage";

const ACTIVE_GROUPING_STORAGE_KEY = "bb-sidebar:active-grouping:v1";
const ACTIVE_SORT_STORAGE_KEY = "bb-sidebar:active-sort:v1";
const SHELF_EXPANSION_STORAGE_KEY = "bb-sidebar:shelf-expansion:v1";
const CHILD_EXPANSION_STORAGE_KEY = "bb-sidebar:child-expansion:v1";
const PROJECT_COLLAPSE_STORAGE_KEY = "bb-sidebar:project-collapse:v1";
const SETTLED_INITIAL_LIMIT = 10;
const SETTLED_PAGE_SIZE = 25;

function threadNeedsAttention(thread: PluginSidebarThread): boolean {
  return thread.hasPendingInteraction || thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error" || thread.queuedWork === "failed";
}

function readCollapsedProjects(): Set<string> {
  try {
    const stored = window.localStorage.getItem(PROJECT_COLLAPSE_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  } catch {
    return new Set();
  }
}

function readChildExpansion(): Set<string> {
  try {
    const stored = window.localStorage.getItem(CHILD_EXPANSION_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const filtered = parsed.filter(
      (value): value is string => typeof value === "string",
    );
    const trimmed =
      filtered.length > MAX_CHILD_EXPANSION
        ? filtered.slice(-MAX_CHILD_EXPANSION)
        : filtered;
    return new Set(trimmed);
  } catch {
    return new Set();
  }
}

// A drag reads insertion from row geometry, so no row may be mid-flight while
// it reads: an animating rect reports where a row was, not the slot the order
// has already given it. Every list registers here so a drag can hold them all
// still for its duration.
const listAnimations = new Set<AnimationController>();
// Counted rather than a flag: two sidebars can be mounted at once, and the
// first drag to finish must not re-enable animation under a drag still running
// in the other one.
let listAnimationHolds = 0;

function suspendListAnimations(): void {
  listAnimationHolds += 1;
  if (listAnimationHolds > 1) return;
  for (const animation of listAnimations) animation.disable();
}

function resumeListAnimations(): void {
  if (listAnimationHolds === 0) return;
  listAnimationHolds -= 1;
  if (listAnimationHolds > 0) return;
  for (const animation of listAnimations) animation.enable();
}

function useListAutoAnimate<T extends HTMLElement>() {
  return useCallback((node: T | null) => {
    if (!node || typeof window.matchMedia !== "function") return;
    const animation = autoAnimate(node, {
      duration: 150,
      easing: "ease-out",
    });
    if (listAnimationHolds > 0) animation.disable();
    listAnimations.add(animation);
    return () => {
      listAnimations.delete(animation);
      // Dropping our reference is not enough: auto-animate holds the parent in
      // its own registry and keeps observers and a polling interval alive until
      // it is told to let go.
      animation.destroy?.();
    };
  }, []);
}

/**
 * Swallow the click a finished drag would otherwise fire on the row it started
 * from. Armed the moment a drag engages rather than when it drops, so drop,
 * Escape and a blurred window are all covered by the same listener.
 *
 * It disarms after one swallowed click, and on the next pointer press either
 * way. Staying armed would eat the click that Enter raises on the same row —
 * that click has no pointer press in front of it to clear the trap.
 *
 * Returns its own disarm so the caller can drop it on unmount.
 */
function armClickSuppression(key: string): () => void {
  const disarm = () => {
    window.removeEventListener("click", suppress, true);
    window.removeEventListener("pointerdown", disarm, true);
  };
  function suppress(event: MouseEvent) {
    const clicked =
      event.target instanceof Element
        ? (event.target
            .closest("[data-reorder-key]")
            ?.getAttribute("data-reorder-key") ??
          event.target
            .closest("[data-sidebar-thread-id]")
            ?.getAttribute("data-sidebar-thread-id"))
        : null;
    if (clicked !== key) return;
    event.preventDefault();
    event.stopPropagation();
    disarm();
  }
  window.addEventListener("click", suppress, true);
  window.addEventListener("pointerdown", disarm, true);
  return disarm;
}

/** Nearest ancestor that actually scrolls, so a drag can reach past the fold. */
function findScrollContainer(from: Element | null): HTMLElement | null {
  for (
    let node = from?.parentElement ?? null;
    node;
    node = node.parentElement
  ) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return null;
}

function sameOrder(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((id, index) => id === right[index])
  );
}

/** How close to an edge a drag must come before the shelf starts scrolling. */
const DRAG_SCROLL_EDGE = 48;
/** Pixels per frame at the very edge, ramping down to nothing at the hot zone. */
const DRAG_SCROLL_SPEED = 14;

interface ShelfExpansionState {
  active: boolean;
  pinned: boolean;
  working: boolean;
  inactive: boolean;
  parked: boolean;
  snoozed: boolean;
  settled: boolean;
}

const DEFAULT_SHELF_EXPANSION: ShelfExpansionState = {
  active: true,
  pinned: true,
  working: true,
  inactive: false,
  parked: false,
  snoozed: false,
  settled: false,
};

function readShelfExpansion(): ShelfExpansionState {
  try {
    const stored = window.localStorage.getItem(SHELF_EXPANSION_STORAGE_KEY);
    if (!stored) return DEFAULT_SHELF_EXPANSION;
    const parsed = JSON.parse(stored) as Partial<ShelfExpansionState>;
    return {
      // Keep Active expanded for people with the older stored shape.
      active: parsed.active !== false,
      // Pinned became independently collapsible after the first stored shape.
      pinned: parsed.pinned !== false,
      working: parsed.working !== false,
      inactive: parsed.inactive === true,
      parked: parsed.parked === true,
      snoozed: parsed.snoozed === true,
      settled: parsed.settled === true,
    };
  } catch {
    return DEFAULT_SHELF_EXPANSION;
  }
}

const ACTIVE_SORT_MODES = ["manual", "activity", "created", "project"] as const;
type ActiveSortMode = (typeof ACTIVE_SORT_MODES)[number];

const ACTIVE_SORT_LABELS: Record<ActiveSortMode, string> = {
  manual: "Manual order",
  activity: "Recent activity",
  created: "Date created",
  project: "Project",
};

function isActiveSortMode(value: string): value is ActiveSortMode {
  return ACTIVE_SORT_MODES.some((mode) => mode === value);
}

function readActiveSort(): ActiveSortMode {
  try {
    const stored = window.localStorage.getItem(ACTIVE_SORT_STORAGE_KEY);
    if (stored && isActiveSortMode(stored)) return stored;
    return window.localStorage.getItem(ACTIVE_GROUPING_STORAGE_KEY) === "true"
      ? "project"
      : "manual";
  } catch {
    return "manual";
  }
}

type ActiveShelfKind = "pinned" | "inbox";

// A project needs this many Active threads before it earns a header; below
// it, its threads stay ordinary cards, so a list of one-thread projects reads
// exactly like manual order.
const MIN_PROJECT_GROUP_SIZE = 2;

type ReorderMode = "thread" | "unit";

type ProjectViewUnit =
  | Extract<ProjectUnit, { kind: "thread" }>
  | (Extract<ProjectUnit, { kind: "group" }> & {
      expanded: boolean;
      threadCount: number;
    });

type ProjectUnit =
  | { kind: "thread"; key: string; thread: PluginSidebarThread }
  | {
      kind: "group";
      key: string;
      projectId: string;
      threads: PluginSidebarThread[];
    };

// Thread ids never take this form, so a project key cannot collide with one.
const PROJECT_UNIT_KEY_PREFIX = "project:";

function projectUnitKey(projectId: string): string {
  return `${PROJECT_UNIT_KEY_PREFIX}${projectId}`;
}

/**
 * The project view in manual order: a lone thread stays where it is, and a
 * project with enough threads is drawn once, where its first thread sits.
 * Moving a unit moves all of its threads, so a dragged group stays together.
 */
function layoutActiveThreadsByProject(
  inbox: readonly PluginSidebarThread[],
): ProjectUnit[] {
  const counts = new Map<string, number>();
  for (const thread of inbox) {
    counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
  }
  const units: ProjectUnit[] = [];
  const groups = new Map<string, PluginSidebarThread[]>();
  for (const thread of inbox) {
    if ((counts.get(thread.projectId) ?? 0) < MIN_PROJECT_GROUP_SIZE) {
      units.push({ kind: "thread", key: thread.id, thread });
      continue;
    }
    const existing = groups.get(thread.projectId);
    if (existing) {
      existing.push(thread);
      continue;
    }
    const threads = [thread];
    groups.set(thread.projectId, threads);
    units.push({
      kind: "group",
      key: projectUnitKey(thread.projectId),
      projectId: thread.projectId,
      threads,
    });
  }
  return units;
}

function projectOrderUnits(units: readonly ProjectUnit[]): OrderUnit[] {
  return units.map((unit) => ({
    key: unit.key,
    ids:
      unit.kind === "thread"
        ? [unit.thread.id]
        : unit.threads.map((thread) => thread.id),
  }));
}

/** Expand a preview of unit keys into the thread order it stands for. */
function expandProjectUnits(
  keys: readonly string[],
  units: readonly ProjectUnit[],
): string[] {
  const idsByKey = new Map(
    projectOrderUnits(units).map((unit) => [unit.key, unit.ids]),
  );
  return keys.flatMap((key) => idsByKey.get(key) ?? []);
}

function sortActiveThreads(
  threads: readonly PluginSidebarThread[],
  mode: ActiveSortMode,
): PluginSidebarThread[] {
  if (mode !== "activity" && mode !== "created") return [...threads];
  const primaryKey = mode === "activity" ? "updatedAt" : "createdAt";
  return [...threads].sort(
    (left, right) =>
      right[primaryKey] - left[primaryKey] ||
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt,
  );
}

function visibleShelfThreads(
  threads: readonly PluginSidebarThread[],
  expanded: boolean,
  activeThreadId: string | null,
  limit = threads.length,
  attentionParentIds?: ReadonlySet<string>,
): PluginSidebarThread[] {
  if (!expanded) {
    return threads.filter(
      (thread) => thread.id === activeThreadId || attentionParentIds?.has(thread.id),
    );
  }
  return threads.filter(
    (thread, index) => index < limit || thread.id === activeThreadId,
  );
}

/** Closest ancestor represented by an actual flat shelf row in this scope. */
function activeRepresentativeThreadId(
  threads: readonly PluginSidebarThread[],
  threadId: string | null,
  flatRows: readonly PluginSidebarThread[],
): string | null {
  const visibleById = new Map(
    visibleInboxThreads(threads).map((thread) => [thread.id, thread] as const),
  );
  const flatIds = new Set(flatRows.map((thread) => thread.id));
  const visited = new Set<string>();
  let current = threadId === null ? undefined : visibleById.get(threadId);
  while (current && !visited.has(current.id)) {
    if (flatIds.has(current.id)) return current.id;
    visited.add(current.id);
    current = current.parentThreadId
      ? visibleById.get(current.parentThreadId)
      : undefined;
  }
  return null;
}

/**
 * The sidebar's scrolling list. Manual order is durable, while optional views
 * can sort the same rows without changing their saved positions.
 *
 * The host owns the New-thread button and the search field above it, so this
 * ships neither. It filters by the `searchQuery` prop and keeps only the one
 * control the host has no equivalent for: the project scope picker.
 */
export function ThreadInbox({
  activeThreadId,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const { status, threads, projects } = useSidebarThreads();
  const workingSince = useWorkingSince(threads);
  const { providers } = useProviders();
  const actions = useSidebarThreadActions();
  const { values: legacySettings } = useSettings();
  const sidebarSettings = useSidebarSettings();
  const lifecycle = useLifecycle(threads);
  const [projectIconRevision, setProjectIconRevision] = useState(0);
  useRealtime(PROJECT_ICONS_CHANNEL, () => {
    setProjectIconRevision((revision) => revision + 1);
  });
  const attachShelvesAutoAnimateRef = useListAutoAnimate<HTMLDivElement>();
  const attachDockAutoAnimateRef = useListAutoAnimate<HTMLDivElement>();
  const attachScrollFadeRef = useScrollFade<HTMLDivElement>();
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const jumpHintsRootRef = useRef<HTMLDivElement>(null);
  const jumpHints = useJumpHints(jumpHintsRootRef);
  const configuredSnoozePresets =
    sidebarSettings?.snoozePresets ??
    (typeof legacySettings?.snoozePresets === "string"
      ? legacySettings.snoozePresets
      : DEFAULT_SNOOZE_PRESET_CONFIG);
  const snoozePresets = useMemo(
    () => parseConfiguredSnoozePresets(configuredSnoozePresets),
    [configuredSnoozePresets],
  );
  const inactiveAfterHours = parseInactiveAfterHours(
    sidebarSettings?.inactiveThreadsEnabled ??
      legacySettings?.inactiveThreadsEnabled === true,
    sidebarSettings
      ? String(sidebarSettings.inactiveAfterHours)
      : typeof legacySettings?.inactiveAfterHours === "string"
        ? legacySettings.inactiveAfterHours
        : String(DEFAULT_INACTIVE_AFTER_HOURS),
  );
  const dockShelvesEnabled =
    sidebarSettings?.dockShelves ?? DEFAULT_SIDEBAR_SETTINGS.dockShelves;
  const workingShelfEnabled =
    sidebarSettings?.workingShelf ?? DEFAULT_SIDEBAR_SETTINGS.workingShelf;
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
  useEffect(() => {
    setScope((current) => reconcileProjectScope(current, projects));
  }, [projects]);
  // One clock for every card in a render, quantized to the minute so the
  // labels do not disagree and do not churn on unrelated re-renders.
  const [nowMinute, setNowMinute] = useState(() =>
    Math.floor(Date.now() / 60_000),
  );
  useEffect(() => {
    const timer = setInterval(
      () => setNowMinute(Math.floor(Date.now() / 60_000)),
      60_000,
    );
    return () => clearInterval(timer);
  }, []);
  const now = nowMinute * 60_000;
  const [expandedShelves, setExpandedShelves] =
    useState<ShelfExpansionState>(readShelfExpansion);
  const [expandedChildParentIds, setExpandedChildParentIds] =
    useState<Set<string>>(readChildExpansion);
  const [activeSortMode, setActiveSortMode] =
    useState<ActiveSortMode>(readActiveSort);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    readCollapsedProjects,
  );
  const [settledLimit, setSettledLimit] = useState(SETTLED_INITIAL_LIMIT);
  const [renamingShelfLocks, setRenamingShelfLocks] = useState<Map<string, "active" | "working" | "inactive">>(() => new Map());
  useEffect(() => {
    const activeIds = new Set(threads.filter((thread) =>
      !thread.isArchived && lifecycle.shelfFor(thread) === "active" && !threadNeedsAttention(thread)
    ).map((thread) => thread.id));
    setRenamingShelfLocks((current) => {
      const next = new Map([...current].filter(([threadId]) => activeIds.has(threadId)));
      return next.size === current.size ? current : next;
    });
  }, [lifecycle, threads]);
  useEffect(() => {
    const pruned = pruneChildExpansion([...expandedChildParentIds]);
    safeSetItem(
      CHILD_EXPANSION_STORAGE_KEY,
      JSON.stringify(pruned),
    );
  }, [expandedChildParentIds]);
  useEffect(() => {
    safeSetItem(SHELF_EXPANSION_STORAGE_KEY, JSON.stringify(expandedShelves));
  }, [expandedShelves]);
  useEffect(() => {
    safeSetItem(ACTIVE_SORT_STORAGE_KEY, activeSortMode);
  }, [activeSortMode]);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  useEffect(() => {
    // Forget removed projects, but not before the project list has loaded.
    const ids = [...collapsedProjectIds].filter(
      (id) => projectNameById.size === 0 || projectNameById.has(id),
    );
    safeSetItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(ids));
  }, [collapsedProjectIds, projectNameById]);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const childDisplay = useChildThreadDisplayValue(
    sidebarSettings,
    providerById,
  );
  const childrenByParentId = useMemo(
    () => childThreadsByParent(threads, childDisplay.sort),
    [threads, childDisplay.sort],
  );
  useEffect(() => {
    setExpandedChildParentIds((current) => {
      const next = new Set(
        [...current].filter((threadId) => childrenByParentId.has(threadId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [childrenByParentId]);
  const toggleChildExpansion = useCallback((parentThreadId: string) => {
    setExpandedChildParentIds((current) => {
      const next = new Set(current);
      if (next.has(parentThreadId)) next.delete(parentThreadId);
      else next.add(parentThreadId);
      return next;
    });
  }, []);

  const {
    activeListThreadId,
    pinnedBase,
    inboxBase,
    workingBase,
    inactiveBase,
    allPinnedBase,
    allInboxBase,
    parked,
    snoozed,
    settled,
  } = useMemo(() => {
    const allVisible = visibleInboxThreads(threads);
    const scoped = filterByProject(
      allVisible,
      scope === ALL_PROJECTS ? null : scope,
    );
    // Children live in their parent's header chip instead of the flat list;
    // an orphan whose parent is not on screen stays here.
    const visible = hideChildrenOfVisibleParents(scoped);
    const active: typeof visible = [];
    const onParkedShelf: typeof visible = [];
    const onSnoozeShelf: typeof visible = [];
    const onSettledShelf: typeof visible = [];
    for (const thread of visible) {
      const shelf = lifecycle.shelfFor(thread);
      if (shelf === "parked") onParkedShelf.push(thread);
      else if (shelf === "snoozed") onSnoozeShelf.push(thread);
      else if (shelf === "settled") onSettledShelf.push(thread);
      else active.push(thread);
    }
    const split = partitionPinned(active);
    const activeUnpinned: typeof split.inbox = [];
    const working: typeof split.inbox = [];
    const inactive: typeof split.inbox = [];
    for (const thread of split.inbox) {
      const lockedShelf = renamingShelfLocks.get(thread.id);
      const needsAttention = threadNeedsAttention(thread);
      if (lockedShelf === "active") {
        activeUnpinned.push(thread);
        continue;
      }
      if (lockedShelf === "working" && workingShelfEnabled && !needsAttention && !lifecycle.wokeFor(thread)) {
        working.push(thread);
        continue;
      }
      if (lockedShelf === "inactive" && !needsAttention) {
        inactive.push(thread);
        continue;
      }
      // A thread with work running anywhere under it waits on the Working
      // shelf, unless it just woke from a snooze: that is news for Active.
      if (
        workingShelfEnabled &&
        !lifecycle.wokeFor(thread) &&
        isWorkingTree(
          thread,
          childrenByParentId.get(thread.id) ?? [],
          childrenByParentId,
        )
      ) {
        working.push(thread);
      } else if (isInactiveThread(thread, now, inactiveAfterHours)) {
        inactive.push(thread);
      } else {
        activeUnpinned.push(thread);
      }
    }
    const allSplit = partitionPinned(allVisible);
    return {
      activeListThreadId: activeRepresentativeThreadId(
        threads, activeThreadId, visible,
      ),
      // BB supplies pinned rows in the user's persisted pin order.
      pinnedBase: split.pinned,
      inboxBase: sortByCreatedAtDescending(activeUnpinned),
      workingBase: sortByCreatedAtDescending(working),
      inactiveBase: sortByCreatedAtDescending(inactive),
      // Keep a global order behind project-scoped and parked views. Child and
      // parked rows are included because they can become visible later; a
      // reorder elsewhere must not silently discard their old slot.
      allPinnedBase: allSplit.pinned,
      allInboxBase: sortByCreatedAtDescending(allSplit.inbox),
      parked: sortSettledThreads(onParkedShelf, lifecycle.parkedAtFor),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozed: [...onSnoozeShelf].sort(
        (left, right) =>
          (lifecycle.wakeAtFor(left) ?? 0) - (lifecycle.wakeAtFor(right) ?? 0),
      ),
      settled: sortSettledThreads(onSettledShelf, lifecycle.settledAtFor),
    };
  }, [
    activeThreadId,
    childrenByParentId,
    inactiveAfterHours,
    lifecycle,
    now,
    renamingShelfLocks,
    scope,
    threads,
    workingShelfEnabled,
  ]);

  const pinnedReorder = usePinnedReorder(allPinnedBase);
  const inboxReorder = useInboxReorder(allInboxBase);
  // A "unit" drag moves whole project-view units, so its ids are unit keys
  // rather than thread ids.
  const [dragOrder, setDragOrder] = useState<{
    shelf: "pinned" | "inbox";
    mode: ReorderMode;
    movingId: string;
    ids: string[];
  } | null>(null);
  const dragOrderRef = useRef(dragOrder);
  dragOrderRef.current = dragOrder;
  const dragPreviewRef = useRef<ReturnType<typeof createDragPreview> | null>(null);
  useLayoutEffect(() => {
    dragPreviewRef.current?.play();
  });
  const activeReorderCancelRef = useRef<(() => void) | null>(null);
  const clickSuppressionRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeReorderCancelRef.current?.();
      // Suppression outlives the gesture on purpose, but not the component.
      clickSuppressionRef.current?.();
    },
    [],
  );
  // A thread can be deleted from anywhere while it is being dragged. Unmounting
  // the whole sidebar already cancels; losing just this row has to as well, or
  // the drag keeps steering an order around an id that is gone. This catches
  // the thread leaving the host's list, not every way a row can stop being a
  // valid drag source — archiving or parking it still leaves the gesture
  // running until the drop rebases it.
  useEffect(() => {
    if (!dragOrder) return;
    // A dragged project lives as long as any of its threads does.
    const survives = dragOrder.movingId.startsWith(PROJECT_UNIT_KEY_PREFIX)
      ? threads.some(
          (candidate) =>
            projectUnitKey(candidate.projectId) === dragOrder.movingId,
        )
      : threads.some((candidate) => candidate.id === dragOrder.movingId);
    if (!survives) activeReorderCancelRef.current?.();
  }, [dragOrder, threads]);
  const pinned = useMemo(() => {
    const ordered = orderPinnedThreads(pinnedBase, pinnedReorder.ids);
    return orderPinnedThreads(
      ordered,
      dragOrder?.shelf === "pinned" ? dragOrder.ids : null,
    );
  }, [dragOrder, pinnedBase, pinnedReorder.ids]);
  const orderedInbox = useMemo(
    () => orderPinnedThreads(inboxBase, inboxReorder.ids),
    [inboxBase, inboxReorder.ids],
  );
  // The project view as stored, without any drag preview. A unit drag and its
  // drop are both resolved against this.
  const storedProjectUnits = useMemo(
    () => layoutActiveThreadsByProject(orderedInbox),
    [orderedInbox],
  );
  const inbox = useMemo(() => {
    if (dragOrder?.shelf !== "inbox") return orderedInbox;
    return orderSubsetInPlace(
      orderedInbox,
      dragOrder.mode === "unit"
        ? expandProjectUnits(dragOrder.ids, storedProjectUnits)
        : dragOrder.ids,
    );
  }, [dragOrder, orderedInbox, storedProjectUnits]);
  // Working and Inactive keep Active's manual order, so a thread that leaves
  // for either comes back to the slot it left.
  const working = useMemo(
    () => orderPinnedThreads(workingBase, inboxReorder.ids),
    [workingBase, inboxReorder.ids],
  );
  const inactive = useMemo(
    () => orderPinnedThreads(inactiveBase, inboxReorder.ids),
    [inactiveBase, inboxReorder.ids],
  );
  // Keep the root of an attention path reachable when its shelf is folded.
  const attentionParentIds = useMemo(() => {
    const ids = new Set<string>();
    if (!(sidebarSettings?.showRunningChildrenWhenCollapsed ??
      DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed)) {
      return ids;
    }
    for (const thread of [...pinnedBase, ...inboxBase, ...inactiveBase]) {
      if (collapsedChildThreads(
        childrenByParentId.get(thread.id) ?? [],
        childrenByParentId,
        null,
        true,
      ).length > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [
    childrenByParentId, inactiveBase, inboxBase, pinnedBase,
    sidebarSettings?.showRunningChildrenWhenCollapsed,
  ]);
  const visiblePinned = useMemo(
    () =>
      visibleShelfThreads(
        pinned,
        expandedShelves.pinned,
        activeListThreadId,
        undefined,
        attentionParentIds,
      ),
    [attentionParentIds, activeListThreadId, expandedShelves.pinned, pinned],
  );
  const visibleInbox = useMemo(
    () => visibleShelfThreads(
      inbox, expandedShelves.active, activeListThreadId, undefined, attentionParentIds,
    ),
    [attentionParentIds, activeListThreadId, expandedShelves.active, inbox],
  );
  const visibleWorking = useMemo(
    () =>
      visibleShelfThreads(working, expandedShelves.working, activeListThreadId),
    [activeListThreadId, expandedShelves.working, working],
  );
  const visibleInactive = useMemo(
    () =>
      visibleShelfThreads(
        inactive,
        expandedShelves.inactive,
        activeListThreadId,
        undefined,
        attentionParentIds,
      ),
    [attentionParentIds, activeListThreadId, expandedShelves.inactive, inactive],
  );
  const sortedVisibleInbox = useMemo(
    () => sortActiveThreads(visibleInbox, activeSortMode),
    [activeSortMode, visibleInbox],
  );
  // Laid out from every Active thread, not just the visible ones, so
  // collapsing the shelf never turns a group back into loose cards.
  const inboxProjectUnits = useMemo(
    () => layoutActiveThreadsByProject(inbox),
    [inbox],
  );
  const inboxProjectView = useMemo((): ProjectViewUnit[] => {
    // A collapsed Active shelf hides its project headers too, leaving active
    // and attention paths visible, like the other active shelves.
    if (!expandedShelves.active) {
      return visibleInbox.map((thread) => ({
        kind: "thread",
        key: thread.id,
        thread,
      }));
    }
    return inboxProjectUnits.map((unit) => {
      if (unit.kind === "thread") return unit;
      const expanded = !collapsedProjectIds.has(unit.projectId);
      return {
        ...unit,
        expanded,
        threadCount: unit.threads.length,
        // A collapsed project keeps active and attention paths, like a shelf.
        threads: visibleShelfThreads(
          unit.threads,
          expanded,
          activeListThreadId,
          undefined,
          attentionParentIds,
        ),
      };
    });
  }, [
    attentionParentIds,
    activeListThreadId,
    collapsedProjectIds,
    expandedShelves.active,
    inboxProjectUnits,
    visibleInbox,
  ]);
  const toggleProjectCollapse = (projectId: string) =>
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  // Leaving a thread follows Pinned, then Active, including collapsed rows.
  const nextThreadCandidates = useMemo(
    () => [
      ...pinned,
      ...(activeSortMode === "project"
        ? inboxProjectUnits.flatMap((unit) =>
            unit.kind === "thread" ? [unit.thread] : unit.threads,
          )
        : sortActiveThreads(inbox, activeSortMode)),
      ...working,
    ],
    [activeSortMode, inbox, inboxProjectUnits, pinned, working],
  );
  const nextThreadCandidatesRef = useRef(nextThreadCandidates);
  nextThreadCandidatesRef.current = nextThreadCandidates;

  // A drag installs its listeners once, at pointer-down, but the shelf keeps
  // moving underneath it: the host pushes order changes mid-gesture. The order
  // and the membership a drop depends on are therefore read through these refs
  // rather than captured, or the write reverts whatever landed while the
  // pointer was down. The row and shelf a gesture belongs to stay captured —
  // those are what the gesture is about.
  const reorderTargetsRef = useRef({
    pinned: pinnedReorder,
    inbox: inboxReorder,
  });
  reorderTargetsRef.current = { pinned: pinnedReorder, inbox: inboxReorder };
  const storedProjectUnitsRef = useRef(storedProjectUnits);
  storedProjectUnitsRef.current = storedProjectUnits;
  const activeSortModeRef = useRef(activeSortMode);
  activeSortModeRef.current = activeSortMode;
  /**
   * What a row or header reorders among. In the project view a thread inside
   * a group moves within its project; a lone thread or a group header moves
   * among the top-level units.
   */
  const reorderScope = useCallback(
    (key: string, shelf: "pinned" | "inbox"): {
      mode: ReorderMode;
      ids: string[];
    } => {
      if (shelf === "inbox" && activeSortMode === "project") {
        const visibleThreadIds = new Set(visibleInbox.map((thread) => thread.id));
        // Folding Active hides headers, not the projects' reorder boundaries.
        const units = expandedShelves.active
          ? inboxProjectView
          : storedProjectUnits.filter((unit) =>
              unit.kind === "thread"
                ? visibleThreadIds.has(unit.thread.id)
                : unit.threads.some((thread) => visibleThreadIds.has(thread.id)),
            );
        const group = units.find(
          (unit) =>
            unit.kind === "group" &&
            unit.threads.some((thread) => thread.id === key),
        );
        return group?.kind === "group"
          ? {
              mode: "thread",
              ids: group.threads.filter((thread) => visibleThreadIds.has(thread.id)).map((thread) => thread.id),
            }
          : { mode: "unit", ids: units.map((unit) => unit.key) };
      }
      return {
        mode: "thread",
        ids: (shelf === "pinned" ? visiblePinned : visibleInbox).map(
          (candidate) => candidate.id,
        ),
      };
    },
    [activeSortMode, expandedShelves.active, inboxProjectView, storedProjectUnits, visibleInbox, visiblePinned],
  );
  const reorderScopeRef = useRef(reorderScope);
  reorderScopeRef.current = reorderScope;
  const commitReorder = (
    shelf: "pinned" | "inbox",
    mode: ReorderMode,
    previewIds: readonly string[],
    movingId: string,
  ) => {
    if (shelf === "pinned") {
      const live = reorderTargetsRef.current.pinned;
      void live.reorder(rebaseMovedId(live.ids, previewIds, movingId), movingId);
      return;
    }
    const live = reorderTargetsRef.current.inbox;
    const participating = new Set(previewIds);
    if (mode === "unit") {
      const liveUnits = projectOrderUnits(storedProjectUnitsRef.current).filter((unit) => participating.has(unit.key));
      if (!liveUnits.some((unit) => unit.key === movingId)) return;
      void live.reorder(
        rebaseMovedUnit(
          live.ids,
          liveUnits,
          previewIds,
          movingId,
        ),
      );
      return;
    }
    // Within a project, its threads trade places among the slots they hold,
    // so the project itself stays where it is in the list.
    const projectUnit =
      activeSortModeRef.current === "project"
        ? storedProjectUnitsRef.current.find(
            (unit) =>
              unit.kind === "thread"
                ? unit.thread.id === movingId
                : unit.threads.some((thread) => thread.id === movingId),
          )
        : undefined;
    void live.reorder(
      activeSortModeRef.current === "project"
        ? rebaseMovedUnit(
            live.ids,
            (projectUnit?.kind === "group" ? projectUnit.threads : projectUnit ? [projectUnit.thread] : [])
              .filter((thread) => participating.has(thread.id))
              .map((thread) => ({ key: thread.id, ids: [thread.id] })),
            previewIds,
            movingId,
          )
        : rebaseMovedId(live.ids, previewIds, movingId),
    );
  };
  // Keyboard reordering moves a row with no pointer to follow and no sound, so
  // the only feedback a screen reader gets is what this region says.
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");

  const threadReorderControls = (
    thread: PluginSidebarThread,
    shelf: "pinned" | "inbox",
  ): ThreadReorderControls =>
    reorderControls(thread.id, shelf, threadDisplayTitle(thread));

  /**
   * Pointer and keyboard reordering for one row or project header. `key` is a
   * thread id, or a project unit key for a header.
   */
  const reorderControls = (
    key: string,
    shelf: "pinned" | "inbox",
    title: string,
  ): ThreadReorderControls => {
    const target = shelf === "pinned" ? pinnedReorder : inboxReorder;
    return {
      disabled: target.isReordering,
      isDragging: dragOrder?.shelf === shelf && dragOrder.movingId === key,
      onPointerDown: (event) => {
        // Touch has no hover and no spare axis here: the row fills the width, so
        // a finger dragging it is far more likely to mean "scroll the shelf".
        // Reordering by touch needs a long-press to claim the gesture, which
        // this does not implement, so it declines the gesture instead of
        // competing with the scroller for it.
        if (
          target.isReordering ||
          event.button !== 0 ||
          event.pointerType === "touch"
        ) {
          return;
        }

        activeReorderCancelRef.current?.();
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        const movingId = key;
        // Captured while the event is still being dispatched, which is the only
        // time `currentTarget` is meaningful.
        const rowAnchor = event.currentTarget;
        let engaged = false;
        let finished = false;
        let previousUserSelect = "";
        let previousCursor = "";
        let listElement: HTMLElement | null = null;
        let scrollContainer: HTMLElement | null = null;
        let scrollFrame = 0;
        let pointerX = startX;
        let pointerY = startY;
        let resolvedY = startY;
        let reorderDirection = 0;

        function cleanup() {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onPointerCancel);
          window.removeEventListener("keydown", onKeyDown);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("resize", cancel);
          window.removeEventListener("pagehide", cancel);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          if (scrollFrame !== 0) {
            window.cancelAnimationFrame(scrollFrame);
            scrollFrame = 0;
          }
          if (engaged) {
            document.body.style.userSelect = previousUserSelect;
            document.body.style.cursor = previousCursor;
            dragPreviewRef.current?.destroy();
            dragPreviewRef.current = null;
            resumeListAnimations();
          }
          if (activeReorderCancelRef.current === cancel) {
            activeReorderCancelRef.current = null;
          }
        }

        function cancel() {
          if (finished) return;
          finished = true;
          cleanup();
          if (engaged) {
            dragOrderRef.current = null;
            setDragOrder(null);
          }
        }

        function engage() {
          engaged = true;
          previousUserSelect = document.body.style.userSelect;
          previousCursor = document.body.style.cursor;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          suspendListAnimations();
          clickSuppressionRef.current?.();
          clickSuppressionRef.current = armClickSuppression(movingId);
          listElement = rowAnchor.closest("ul");
          scrollContainer = findScrollContainer(listElement);
          resolvedY = startY + (scrollContainer?.scrollTop ?? 0);
          if (listElement) dragPreviewRef.current = createDragPreview(listElement);
          const next = {
            shelf,
            movingId,
            ...reorderScopeRef.current(movingId, shelf),
          };
          dragOrderRef.current = next;
          setDragOrder(next);
          scrollFrame = window.requestAnimationFrame(onScrollFrame);
        }

        function reorderAt(clientX: number, clientY: number) {
          const current = dragOrderRef.current;
          if (!current || current.shelf !== shelf) return;
          // Content coordinates include auto-scroll. Keep the last direction
          // when the pointer is stationary: a tall neighbour can occupy the
          // cursor after a swap, but must not swap back without a reversal.
          const contentY = clientY + (scrollContainer?.scrollTop ?? 0);
          if (contentY !== resolvedY) reorderDirection = Math.sign(contentY - resolvedY);
          resolvedY = contentY;
          const visibleIds = reorderScopeRef.current(movingId, shelf).ids;
          const hit = document.elementFromPoint(clientX, clientY);
          const hitRow = hit instanceof Element ? hit.closest("li") : null;
          // A whole project is one target among the top-level units; inside
          // a project's own drag, its header is not a row at all.
          const unitRow =
            hit instanceof Element
              ? hit.closest<HTMLElement>("[data-reorder-unit]")
              : null;
          const row =
            current.mode === "unit"
              ? (unitRow ?? hitRow)
              : hitRow?.hasAttribute("data-reorder-unit")
                ? null
                : hitRow;
          const targetThreadId = row
            ?.querySelector<HTMLAnchorElement>("[data-sidebar-thread-id]")
            ?.getAttribute("data-sidebar-thread-id");
          const targetId =
            current.mode === "unit" && unitRow
              ? unitRow.getAttribute("data-reorder-unit")
              : current.mode === "unit"
                ? storedProjectUnitsRef.current.find((unit) =>
                    unit.kind === "thread"
                      ? unit.thread.id === targetThreadId
                      : unit.threads.some((thread) => thread.id === targetThreadId),
                  )?.key
                : targetThreadId;

          let nextIds: string[] | null = null;
          if (
            row &&
            targetId &&
            visibleIds.includes(targetId) &&
            current.movingId !== targetId
          ) {
            const targetDirection = Math.sign(
              current.ids.indexOf(targetId) - current.ids.indexOf(current.movingId),
            );
            if (targetDirection === reorderDirection) {
              nextIds = movePinnedId(
                current.ids,
                current.movingId,
                targetId,
                targetDirection < 0 ? "before" : "after",
              );
            }
          } else if (!targetId && listElement) {
            // Headers, padding and the run-off below the last row are not rows,
            // so hit-testing alone strands a drag aimed at either end of a
            // shelf. Resolve those against the list box instead — but only
            // directly above or below it, or a pointer parked off to the side
            // of the sidebar would keep snapping the row to an end.
            const listRect = listElement.getBoundingClientRect();
            const within =
              clientX >= listRect.left && clientX <= listRect.right;
            const before = within && clientY < listRect.top && reorderDirection < 0;
            const after = within && clientY > listRect.bottom && reorderDirection > 0;
            const edgeId = before
              ? current.ids.find((id) => id !== current.movingId)
              : after
                ? [...current.ids]
                    .reverse()
                    .find((id) => id !== current.movingId)
                : undefined;
            if (edgeId) {
              nextIds = movePinnedId(
                current.ids,
                current.movingId,
                edgeId,
                before ? "before" : "after",
              );
            }
          }

          if (!nextIds || sameOrder(nextIds, current.ids)) return;
          dragPreviewRef.current?.capture();
          const next = { ...current, ids: nextIds };
          dragOrderRef.current = next;
          setDragOrder(next);
        }

        function onScrollFrame() {
          scrollFrame = 0;
          if (finished || !engaged) return;
          if (scrollContainer) {
            const rect = scrollContainer.getBoundingClientRect();
            const fromTop = pointerY - rect.top;
            const fromBottom = rect.bottom - pointerY;
            // A pointer dragged off to the side has left the shelf; it should
            // not keep driving it.
            const within =
              pointerX >= rect.left && pointerX <= rect.right;
            const delta = !within
              ? 0
              : fromTop < DRAG_SCROLL_EDGE
                ? -DRAG_SCROLL_SPEED *
                  (1 - Math.max(fromTop, 0) / DRAG_SCROLL_EDGE)
                : fromBottom < DRAG_SCROLL_EDGE
                  ? DRAG_SCROLL_SPEED *
                    (1 - Math.max(fromBottom, 0) / DRAG_SCROLL_EDGE)
                  : 0;
            if (delta !== 0) {
              const scrollTop = scrollContainer.scrollTop;
              scrollContainer.scrollTop = scrollTop + delta;
              // Only re-resolve when the view actually moved, so a drag parked
              // against an end does not churn state every frame. A host update
              // can still shift rows without the scroll position changing;
              // the next pointermove or the drop picks that up.
              if (scrollContainer.scrollTop !== scrollTop) {
                reorderAt(pointerX, pointerY);
              }
            }
          }
          scrollFrame = window.requestAnimationFrame(onScrollFrame);
        }

        function onPointerMove(moveEvent: PointerEvent) {
          if (finished || moveEvent.pointerId !== pointerId) return;
          // A button let go outside the window never delivers its pointerup.
          if ((moveEvent.buttons & 1) === 0) {
            cancel();
            return;
          }
          pointerX = moveEvent.clientX;
          pointerY = moveEvent.clientY;
          if (!engaged) {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            // Radial distance, but still vertical-dominant: a sideways gesture
            // belongs to the host's drag-to-split, not to reordering.
            if (
              Math.hypot(deltaX, deltaY) < 6 ||
              Math.abs(deltaY) <= Math.abs(deltaX)
            ) {
              return;
            }
            engage();
          }
          moveEvent.preventDefault();
          reorderAt(moveEvent.clientX, moveEvent.clientY);
        }

        function onPointerUp(upEvent: PointerEvent) {
          if (finished || upEvent.pointerId !== pointerId) return;
          // Auto-scroll and host updates both move the list under a pointer
          // that never moved again, so the last pointermove is not necessarily
          // the last word on where this row belongs.
          if (engaged) reorderAt(upEvent.clientX, upEvent.clientY);
          const current = dragOrderRef.current;
          finished = true;
          cleanup();
          if (!engaged || !current || current.shelf !== shelf) return;

          dragOrderRef.current = null;
          setDragOrder(null);
          commitReorder(shelf, current.mode, current.ids, current.movingId);
        }

        function onPointerCancel(cancelEvent: PointerEvent) {
          if (cancelEvent.pointerId === pointerId) cancel();
        }

        function onKeyDown(keyEvent: KeyboardEvent) {
          if (keyEvent.key === "Escape") cancel();
        }

        function onVisibilityChange() {
          if (document.visibilityState === "hidden") cancel();
        }

        window.addEventListener("pointermove", onPointerMove, {
          passive: false,
        });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        window.addEventListener("keydown", onKeyDown);
        // A gesture interrupted by lost focus, a hidden tab or a resize has no
        // drop target left worth guessing at.
        window.addEventListener("blur", cancel);
        window.addEventListener("resize", cancel);
        window.addEventListener("pagehide", cancel);
        document.addEventListener("visibilitychange", onVisibilityChange);
        activeReorderCancelRef.current = cancel;
      },
      onKeyDown: (event) => {
        if (
          !event.altKey ||
          target.isReordering ||
          (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const { mode, ids: currentIds } = reorderScopeRef.current(key, shelf);
        const ids = movePinnedIdByOffset(
          currentIds,
          key,
          event.key === "ArrowUp" ? -1 : 1,
        );
        const shelfName = shelf === "pinned" ? "Pinned" : "Active";
        setReorderAnnouncement(
          sameOrder(ids, currentIds)
            ? `${title} is already ${
                event.key === "ArrowUp" ? "first" : "last"
              } in ${shelfName}`
            : `${title} moved to ${ids.indexOf(key) + 1} of ${
                ids.length
              } in ${shelfName}`,
        );
        commitReorder(shelf, mode, ids, key);
      },
    };
  };

  const isSearching = searchQuery.trim().length > 0;
  const searchCandidates = useMemo(
    () =>
      filterByProject(
        visibleInboxThreads(threads),
        scope === ALL_PROJECTS ? null : scope,
      ),
    [scope, threads],
  );
  const searchResults = useMemo(
    () => searchThreadsByTitle(searchCandidates, searchQuery),
    [searchCandidates, searchQuery],
  );
  const visibleParked = useMemo(
    () =>
      visibleShelfThreads(
        parked,
        expandedShelves.parked,
        activeListThreadId,
      ),
    [activeListThreadId, expandedShelves.parked, parked],
  );
  const visibleSnoozed = useMemo(
    () =>
      visibleShelfThreads(
        snoozed,
        expandedShelves.snoozed,
        activeListThreadId,
      ),
    [activeListThreadId, expandedShelves.snoozed, snoozed],
  );
  const visibleSettled = useMemo(
    () =>
      visibleShelfThreads(
        settled,
        expandedShelves.settled,
        activeListThreadId,
        settledLimit,
      ),
    [activeListThreadId, expandedShelves.settled, settled, settledLimit],
  );
  const wokeThreadIds = useMemo(
    () =>
      new Set(
        [...pinned, ...inbox, ...working, ...inactive]
          .filter((thread) => lifecycle.wokeFor(thread))
          .map((thread) => thread.id),
      ),
    [inactive, inbox, lifecycle, pinned, working],
  );

  const parkActiveThread = async (
    thread: PluginSidebarThread,
    mutation: () => Promise<boolean>,
  ) => {
    const parked = await mutation();
    if (!parked || activeThreadIdRef.current !== thread.id) return;

    // Read the latest list after the request, since another client may
    // have moved or reordered the first candidate while it was pending.
    const nextThread = nextThreadCandidatesRef.current.find(
      (candidate) => candidate.id !== thread.id,
    );
    if (nextThread) {
      actions.open(nextThread.id);
    } else {
      actions.openNewThread({
        projectId: thread.projectId,
        focusPrompt: true,
      });
    }
    onNavigate();
  };

  const parkThread = (thread: PluginSidebarThread) =>
    void parkActiveThread(thread, () => lifecycle.park(thread.id));
  const settleThread = (thread: PluginSidebarThread) =>
    void parkActiveThread(thread, () => lifecycle.settle(thread.id));
  const snoozeThread = (thread: PluginSidebarThread, until: number) =>
    void parkActiveThread(thread, () => lifecycle.snooze(thread.id, until));

  const renderActiveThread = (
    thread: PluginSidebarThread,
    shelf: ActiveShelfKind,
    reorderable = true,
    showProject = true,
    compact = false,
    renameShelf: "active" | "working" | "inactive" = "active",
  ) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      provider={providerById.get(thread.providerId) ?? null}
      projectName={projectNameById.get(thread.projectId) ?? null}
      projectIconUrl={projectIconUrl(thread.projectId, projectIconRevision)}
      showProject={showProject}
      isActive={thread.id === activeThreadId}
      isWoke={wokeThreadIds.has(thread.id)}
      canPark={lifecycle.canPark(thread)}
      snoozePresets={snoozePresets}
      onNavigate={onNavigate}
      onRenamingChange={(editing) => {
        setRenamingShelfLocks((current) => {
          const next = new Map(current);
          if (editing) next.set(thread.id, renameShelf);
          else next.delete(thread.id);
          return next;
        });
      }}
      onPark={() => parkThread(thread)}
      onSettle={() => settleThread(thread)}
      onSnooze={(until) => snoozeThread(thread, until)}
      onAcknowledgeWake={() => void lifecycle.acknowledgeWake(thread.id)}
      childThreads={childrenByParentId.get(thread.id) ?? []}
      childrenByParent={childrenByParentId}
      activeThreadId={activeThreadId}
      childrenExpanded={expandedChildParentIds.has(thread.id)}
      showRunningChildrenWhenCollapsed={
        sidebarSettings?.showRunningChildrenWhenCollapsed ??
        DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed
      }
      onToggleChildren={() => toggleChildExpansion(thread.id)}
      reorder={
        !reorderable ||
        (shelf === "pinned" && thread.pinSortKey == null) ||
        (shelf === "inbox" &&
          (activeSortMode === "activity" || activeSortMode === "created"))
          ? undefined
          : threadReorderControls(thread, shelf)
      }
      compactWhenWorking={
        compact ||
        (sidebarSettings?.compactWorkingThreads ??
          DEFAULT_SIDEBAR_SETTINGS.compactWorkingThreads)
      }
      now={now}
    />
  );

  return (
    <ProjectColorsProvider
      enabled={sidebarSettings?.projectColorsEnabled === true}
      display={sidebarSettings?.projectColorDisplay ?? DEFAULT_SIDEBAR_SETTINGS.projectColorDisplay}
      projectIds={projects.map((project) => project.id)}
    >
    <WorkingSinceContext.Provider value={workingSince}>
    <ChildThreadDisplayContext.Provider value={childDisplay}>
    <OpenPortsProvider>
    <JumpHintsContext.Provider value={jumpHints}>
      <div ref={jumpHintsRootRef} data-bb-sidebar-root="" className="flex min-h-0 flex-1 flex-col">
        {/* The one control the host has no equivalent for. Everything else in
            the chrome above — New thread, search — is bb's and stays bb's. */}
        <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
          <ProjectScopeSelect
            scope={scope}
            projects={projects}
            projectIconRevision={projectIconRevision}
            onScopeChange={setScope}
          />
        </div>

        <p role="status" aria-live="polite" className="sr-only">
          {reorderAnnouncement}
        </p>

        <div
          ref={attachScrollFadeRef}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-1.5 pb-2",
            SCROLL_FADE_CLASS,
          )}
        >
          {status === "loading" ? (
            <ThreadListLoading />
          ) : status === "error" ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-muted-foreground"
            >
              Could not load threads.
            </p>
          ) : isSearching && searchResults.length === 0 ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-muted-foreground"
            >
              No threads found
            </p>
          ) : isSearching ? (
            <SearchResults
              threads={searchResults}
              projectNameById={projectNameById}
              projectIconRevision={projectIconRevision}
              activeThreadId={activeThreadId}
              now={now}
              wokeThreadIds={wokeThreadIds}
              onAcknowledgeWake={(threadId) =>
                void lifecycle.acknowledgeWake(threadId)
              }
              onNavigate={onNavigate}
            />
          ) : (
            <DockableShelves
              docked={dockShelvesEnabled}
              attachUpperRef={attachShelvesAutoAnimateRef}
              attachLowerRef={attachDockAutoAnimateRef}
              upper={
                <>
                  {pinned.length > 0 ? (
                    <CollapsibleShelf
                      label="Pinned"
                      icon="Pin"
                      count={pinned.length}
                      expanded={expandedShelves.pinned}
                      onToggle={() =>
                        setExpandedShelves((current) => ({
                          ...current,
                          pinned: !current.pinned,
                        }))
                      }
                    >
                      <Shelf label={null}>
                        {visiblePinned.map((thread) =>
                          renderActiveThread(thread, "pinned"),
                        )}
                      </Shelf>
                    </CollapsibleShelf>
                  ) : null}
                  {inbox.length > 0 ? (
                    <CollapsibleShelf
                      label="Active"
                      icon="Pulse"
                      count={inbox.length}
                      expanded={expandedShelves.active}
                      onToggle={() =>
                        setExpandedShelves((current) => ({
                          ...current,
                          active: !current.active,
                        }))
                      }
                      action={
                        <Select
                          value={activeSortMode}
                          onValueChange={(value) => {
                            if (isActiveSortMode(value)) setActiveSortMode(value);
                          }}
                        >
                          <SelectTrigger
                            aria-label={`Sort active threads: ${ACTIVE_SORT_LABELS[activeSortMode]}`}
                            title={`Sort active threads: ${ACTIVE_SORT_LABELS[activeSortMode]}`}
                            className={cn(
                              "absolute bottom-1 right-[1.875rem] z-10 size-4 h-4 w-4 border-0 p-0 text-muted-foreground/40 shadow-none hover:bg-sidebar-accent hover:text-muted-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring [&>svg:last-child]:hidden",
                              activeSortMode !== "manual" &&
                                "bg-sidebar-accent/60 text-muted-foreground/80",
                            )}
                          >
                            <Icon name="ArrowUpDown" className="size-3" />
                          </SelectTrigger>
                          <SelectContent align="end" className="min-w-40">
                            {ACTIVE_SORT_MODES.map((mode) => (
                              <SelectItem key={mode} value={mode} className="text-xs">
                                {ACTIVE_SORT_LABELS[mode]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      }
                    >
                      {activeSortMode === "project" ? (
                        <ProjectGroups
                          units={inboxProjectView}
                          projectNameById={projectNameById}
                          projectIconRevision={projectIconRevision}
                          onToggle={toggleProjectCollapse}
                          reorderControls={(unit, name) =>
                            reorderControls(unit.key, "inbox", `${name} project`)
                          }
                          renderThread={(thread, grouped) =>
                            renderActiveThread(thread, "inbox", true, !grouped)
                          }
                        />
                      ) : visibleInbox.length > 0 ? (
                        <Shelf label={null}>
                          {sortedVisibleInbox.map((thread) =>
                            renderActiveThread(thread, "inbox"),
                          )}
                        </Shelf>
                      ) : null}
                    </CollapsibleShelf>
                  ) : null}
                  {pinned.length === 0 &&
                  inbox.length === 0 &&
                  working.length === 0 &&
                  inactive.length === 0 ? (
                    <ActiveEmptyState />
                  ) : null}
                  {pinned.length === 0 &&
                  inbox.length === 0 &&
                  working.length > 0 &&
                  inactive.length === 0 ? (
                    <WorkingEmptyState />
                  ) : null}
                </>
              }
              lower={
                <>
                  {working.length > 0 ? (
                    <CollapsibleShelf
                      label="Working"
                      icon="Loading"
                      animateIcon
                      count={working.length}
                      expanded={expandedShelves.working}
                      onToggle={() =>
                        setExpandedShelves((current) => ({
                          ...current,
                          working: !current.working,
                        }))
                      }
                    >
                      <Shelf label={null}>
                        {/* One line, like every shelf after Active. */}
                        {visibleWorking.map((thread) =>
                          renderActiveThread(thread, "inbox", false, true, true, "working"),
                        )}
                      </Shelf>
                    </CollapsibleShelf>
                  ) : null}
                  {inactive.length > 0 ? (
                    <CollapsibleShelf
                      label="Inactive"
                      icon="PauseCircle"
                      count={inactive.length}
                      expanded={expandedShelves.inactive}
                      onToggle={() =>
                        setExpandedShelves((current) => ({
                          ...current,
                          inactive: !current.inactive,
                        }))
                      }
                    >
                      <Shelf label={null}>
                        {visibleInactive.map((thread) =>
                          renderActiveThread(thread, "inbox", false, true, false, "inactive"),
                        )}
                      </Shelf>
                    </CollapsibleShelf>
                  ) : null}
                  <CompactShelf
                    label="Snoozed"
                    onPark={parkThread}
                    onSettle={settleThread}
                    onSnooze={snoozeThread}
                    icon="Clock"
                    threads={snoozed}
                    projectNameById={projectNameById}
                    expanded={expandedShelves.snoozed}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        snoozed: !current.snoozed,
                      }))
                    }
                    shelf="snoozed"
                    visibleThreads={visibleSnoozed}
                    activeThreadId={activeThreadId}
                    lifecycle={lifecycle}
                    snoozePresets={snoozePresets}
                    onNavigate={onNavigate}
                    projectIconRevision={projectIconRevision}
                  />
                  <CompactShelf
                    label="Parked"
                    onPark={parkThread}
                    onSettle={settleThread}
                    onSnooze={snoozeThread}
                    icon="Car"
                    threads={parked}
                    projectNameById={projectNameById}
                    expanded={expandedShelves.parked}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        parked: !current.parked,
                      }))
                    }
                    shelf="parked"
                    visibleThreads={visibleParked}
                    activeThreadId={activeThreadId}
                    lifecycle={lifecycle}
                    snoozePresets={snoozePresets}
                    onNavigate={onNavigate}
                    projectIconRevision={projectIconRevision}
                  />
                  <CompactShelf
                    label="Settled"
                    onPark={parkThread}
                    onSettle={settleThread}
                    onSnooze={snoozeThread}
                    icon="Meditation"
                    threads={settled}
                    projectNameById={projectNameById}
                    expanded={expandedShelves.settled}
                    onToggle={() =>
                      setExpandedShelves((current) => ({
                        ...current,
                        settled: !current.settled,
                      }))
                    }
                    shelf="settled"
                    visibleThreads={visibleSettled}
                    activeThreadId={activeThreadId}
                    lifecycle={lifecycle}
                    snoozePresets={snoozePresets}
                    onNavigate={onNavigate}
                    projectIconRevision={projectIconRevision}
                    settledLimit={settledLimit}
                    onLoadMore={() =>
                      setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)
                    }
                  />
                </>
              }
            />
          )}
        </div>
      </div>
    </JumpHintsContext.Provider>
    </OpenPortsProvider>
    </ChildThreadDisplayContext.Provider>
    </WorkingSinceContext.Provider>
    </ProjectColorsProvider>
  );
}

/**
 * How long the initial load may run before the indicator shows. Most loads
 * finish well inside this, and a spinner that appears only to vanish at once
 * reads as a flicker, not as progress.
 */
const LOADING_INDICATOR_DELAY_MS = 200;

/**
 * The list's placeholder while bb is still loading threads. The paragraph
 * mounts empty at the size it will have with text, so the layout does not
 * jump when the text arrives. Because the live region already exists before
 * its text is added, a screen reader announces "Loading threads…" once, and
 * says nothing when a load finishes before the delay. Unmounting on any new
 * status cancels the timer.
 */
function ThreadListLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setVisible(true),
      LOADING_INDICATOR_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p
      role="status"
      className="px-2 py-6 text-center text-xs text-muted-foreground"
    >
      <span className="flex h-4 items-center justify-center gap-1.5">
        {visible ? (
          <>
            <Icon
              name="Loading"
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin opacity-75 motion-reduce:animate-none"
            />
            Loading threads…
          </>
        ) : null}
      </span>
    </p>
  );
}

function ActiveEmptyState() {
  return (
    <div
      role="status"
      className="flex flex-col items-center px-5 pb-7 pt-8 text-center text-muted-foreground"
    >
      <svg
        viewBox="0 0 180 104"
        className="mb-3 h-auto w-36"
        aria-hidden="true"
      >
        <circle cx="132" cy="24" r="11" fill="currentColor" opacity="0.12" />
        <path
          d="M16 77c18-18 36-24 55-17 14 5 23 5 36-3 18-11 36-7 57 20"
          fill="currentColor"
          opacity="0.08"
        />
        <path
          d="M12 78c22-13 43-14 64-3 16 8 31 8 45 0 16-9 31-8 47 3"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
          opacity="0.38"
        />
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          opacity="0.55"
        >
          <path d="M51 76c0-13-2-22-8-30M51 66c-6-3-10-7-13-12M51 61c5-5 8-10 9-16" />
          <path d="M104 77c1-12 5-21 12-28M107 66c6-2 11-6 15-11M108 62c-2-6-2-11-1-16" />
          <path d="M76 75c0-8-2-14-6-20M77 69c4-3 7-6 9-11" />
        </g>
      </svg>
      <p className="text-xs font-medium text-foreground/75">
        All clear. Time to touch some grass.
      </p>
    </div>
  );
}

/**
 * Active's placeholder while every thread is working: a small creature typing
 * away behind a laptop. The motion lives in working-empty-state.css.
 */
function WorkingEmptyState() {
  // Drawn on mount, so the line changes between appearances, never while shown.
  const [line] = useState(() => pickWorkingEmptyLine());
  return (
    <div
      role="status"
      className="flex flex-col items-center px-5 pb-6 pt-7 text-center text-muted-foreground"
    >
      <svg
        viewBox="40 14 110 80"
        className="mb-2 h-auto w-28"
        aria-hidden="true"
      >
        <ellipse cx="90" cy="88" rx="38" ry="2.5" fill="currentColor" opacity="0.08" />
        <g className="bb-sidebar-working-head">
          <path
            d="M70 66v-6c0-14 9-24 20-24s20 10 20 24v6z"
            fill="currentColor"
            fillOpacity="0.1"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <g
            className="bb-sidebar-working-sprout"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
            opacity="0.55"
          >
            <path d="M90 36c0-4 1-7 3-9" />
            <path d="M93 27c3-3 7-3 9-1-2 3-6 4-9 1z" fill="currentColor" fillOpacity="0.3" />
          </g>
          <g fill="currentColor" opacity="0.7">
            <circle className="bb-sidebar-working-eye" cx="84" cy="50" r="1.8" />
            <circle className="bb-sidebar-working-eye" cx="96" cy="50" r="1.8" />
          </g>
          <g fill="currentColor" opacity="0.15">
            <ellipse cx="79.5" cy="54.5" rx="2.5" ry="1.2" />
            <ellipse cx="100.5" cy="54.5" rx="2.5" ry="1.2" />
          </g>
        </g>
        {/* Opaque so the bobbing head tucks behind the lid. */}
        <rect x="65" y="60" width="50" height="26" rx="3" style={{ fill: "var(--sidebar)" }} />
        <rect
          x="65"
          y="60"
          width="50"
          height="26"
          rx="3"
          fill="currentColor"
          fillOpacity="0.05"
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <circle cx="90" cy="73" r="2" fill="currentColor" opacity="0.25" />
        <path
          d="M59 86h62"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
          opacity="0.55"
        />
        <rect
          x="114"
          y="24"
          width="26"
          height="13"
          rx="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          opacity="0.35"
        />
        <g fill="currentColor">
          <circle className="bb-sidebar-working-dot" cx="121" cy="30.5" r="1.4" opacity="0.25" />
          <circle className="bb-sidebar-working-dot" cx="127" cy="30.5" r="1.4" opacity="0.25" />
          <circle className="bb-sidebar-working-dot" cx="133" cy="30.5" r="1.4" opacity="0.25" />
        </g>
      </svg>
      <p className="text-xs font-medium text-foreground/75">
        {line}
      </p>
    </div>
  );
}

/**
 * A collapsed shelf of parked threads. The header stays while anything is
 * parked — the count is the whole footprint when collapsed — and the shelf
 * vanishes entirely at zero.
 */
function CompactShelf({
  label,
  icon,
  threads,
  projectNameById,
  expanded,
  onToggle,
  shelf,
  visibleThreads,
  activeThreadId,
  lifecycle,
  snoozePresets,
  onNavigate,
  projectIconRevision,
  settledLimit,
  onLoadMore,
  onPark,
  onSettle,
  onSnooze,
}: {
  label: string;
  icon: IconName;
  threads: readonly PluginSidebarThread[];
  projectNameById?: ReadonlyMap<string, string>;
  expanded: boolean;
  onToggle: () => void;
  shelf: "parked" | "snoozed" | "settled";
  visibleThreads: readonly PluginSidebarThread[];
  activeThreadId: string | null;
  lifecycle: LifecycleApi;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  onNavigate: () => void;
  projectIconRevision: number;
  settledLimit?: number;
  onLoadMore?: () => void;
  onPark: (thread: PluginSidebarThread) => void;
  onSettle: (thread: PluginSidebarThread) => void;
  onSnooze: (thread: PluginSidebarThread, until: number) => void;
}) {
  const attachListAutoAnimateRef = useListAutoAnimate<HTMLUListElement>();
  if (threads.length === 0 && shelf !== "settled") return null;
  const now = Date.now();
  const limit =
    shelf === "settled" ? (settledLimit ?? threads.length) : threads.length;
  const hasMore = shelf === "settled" && threads.length > limit;
  return (
    <CollapsibleShelf
      label={label}
      hidden={threads.length === 0}
      icon={icon}
      count={threads.length}
      expanded={expanded}
      onToggle={onToggle}
      action={shelf === "settled" ? <CleanSettledDialog threadIds={threads.map((thread) => thread.id)} onNavigate={onNavigate} /> : undefined}
    >
      <ul ref={attachListAutoAnimateRef} className="flex flex-col gap-px">
        {visibleThreads.map((thread) => (
          <SlimRow
            key={thread.id}
            thread={thread}
            projectName={projectNameById?.get(thread.projectId) ?? null}
            projectIconUrl={projectIconUrl(
              thread.projectId,
              projectIconRevision,
            )}
            isActive={thread.id === activeThreadId}
            shelf={shelf}
            parkedAt={lifecycle.parkedAtFor(thread)}
            onPark={() => onPark(thread)}
            onSettle={() => onSettle(thread)}
            wakeAt={lifecycle.wakeAtFor(thread)}
            now={now}
            snoozePresets={snoozePresets}
            onSnooze={(until) => onSnooze(thread, until)}
            onNavigate={onNavigate}
            onRestore={() =>
              shelf === "parked"
                ? void lifecycle.resume(thread.id)
                : shelf === "snoozed"
                  ? void lifecycle.unsnooze(thread.id)
                  : void lifecycle.unsettle(thread.id)
            }
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
function DockableShelves({
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
      <div
        ref={attachLowerRef}
        data-shelf-dock=""
        className="mt-auto flex flex-col"
      >
        {lower}
      </div>
    </div>
  );
}

function CollapsibleShelf({
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
          {action ? (
            <span aria-hidden="true" className="size-4 shrink-0" />
          ) : null}
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
  expanded: boolean;
  onToggle: () => void;
  reorder: ThreadReorderControls;
  children: React.ReactNode;
}) {
  const stripeView = expanded ? "group-full" : "group-collapsed";
  const projectColor = useProjectColor(projectId);
  const attachListAutoAnimateRef = useListAutoAnimate<HTMLUListElement>();
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
          aria-label={`${projectName} (${threadCount})`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          // Padded like a card, so the name lines up with every row's title and
          // the chevron with every row's trailing glyph. Vertical panning stays
          // with the scroller, as on a row.
          className={cn(
            "flex w-full touch-pan-y items-center gap-1.5 px-2.5 pb-0.5 pt-2 text-left",
            !reorder.disabled && "cursor-grab active:cursor-grabbing",
          )}
        >
          <ProjectFavicon projectId={projectId} src={projectIconUrl} name={projectName} className="size-3" />
          <span style={projectColor} className={cn("min-w-0 truncate text-2xs font-medium", projectColor ? "bb-sidebar-project-name" : "text-muted-foreground")}>
            {projectName}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground/50">
            {threadCount}
          </span>
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
        <ul
          ref={attachListAutoAnimateRef}
          aria-label={`${projectName} active threads`}
          className="flex flex-col gap-px"
        >
          {children}
        </ul>
      </section>
    </li>
  );
}

/** Lone threads and whole projects, in one list so either can pass the other. */
function ProjectGroups({
  units,
  projectNameById,
  projectIconRevision,
  onToggle,
  reorderControls,
  renderThread,
}: {
  units: readonly ProjectViewUnit[];
  projectNameById: ReadonlyMap<string, string>;
  projectIconRevision: number;
  onToggle: (projectId: string) => void;
  reorderControls: (
    unit: Extract<ProjectViewUnit, { kind: "group" }>,
    projectName: string,
  ) => ThreadReorderControls;
  renderThread: (
    thread: PluginSidebarThread,
    grouped: boolean,
  ) => React.ReactNode;
}) {
  const attachListAutoAnimateRef = useListAutoAnimate<HTMLUListElement>();
  if (units.length === 0) return null;
  return (
    <ul ref={attachListAutoAnimateRef} className="flex flex-col gap-px">
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
            expanded={unit.expanded}
            onToggle={() => onToggle(unit.projectId)}
            reorder={reorderControls(unit, projectName)}
          >
            {unit.threads.map((thread) => renderThread(thread, true))}
          </ActiveProjectGroup>
        );
      })}
    </ul>
  );
}

function Shelf({
  label,
  children,
}: {
  label: string | null;
  children: React.ReactNode;
}) {
  const attachListAutoAnimateRef = useListAutoAnimate<HTMLUListElement>();
  return (
    // A named section is exposed as a landmark region; shelf rows stay in an
    // unnamed list beneath their collapsible heading.
    <section {...(label ? { "aria-label": label } : {})}>
      {label ? (
        <h2 className={cn("flex items-center gap-2 px-2.5 pb-1 pt-3")}>
          <span className="text-2xs font-medium text-muted-foreground/70">
            {label}
          </span>
          <span className="h-px flex-1 bg-sidebar-border" />
        </h2>
      ) : null}
      <ul ref={attachListAutoAnimateRef} className="flex flex-col gap-px">
        {children}
      </ul>
    </section>
  );
}
