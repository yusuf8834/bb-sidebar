import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadListProps,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/Select";
import { ThreadCard, type ThreadReorderControls } from "./ThreadCard";
import { SlimRow } from "./SlimRow";
import { SearchResults } from "./SearchResults";
import { BulkSelectionBar } from "./BulkSelectionBar";
import { runBulkAction, type BulkActionResult } from "./bulk-actions";
import { useLifecycle } from "./useLifecycle";
import { usePinnedReorder } from "./usePinnedReorder";
import { useInboxReorder } from "./useInboxReorder";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";
import {
  filterByProject,
  hideChildrenOfVisibleParents,
  nextThreadAfterParking,
  partitionPinned,
  searchThreadsByTitle,
  sortByCreatedAtDescending,
  sortSettledThreads,
  visibleInboxThreads,
} from "./inbox";
import {
  movePinnedId,
  movePinnedIdByOffset,
  mergeVisibleOrder,
  orderPinnedThreads,
} from "./pinned-order";
import {
  DEFAULT_SNOOZE_PRESET_CONFIG,
  parseConfiguredSnoozePresets,
  type ConfiguredSnoozePreset,
} from "./lifecycle";
import {
  EMPTY_THREAD_SELECTION,
  keepFailedSelection,
  reconcileThreadSelection,
  updateThreadSelection,
  type ThreadSelectionState,
} from "./selection";

const ALL_PROJECTS = "__all__";
const SHELF_EXPANSION_STORAGE_KEY = "t3chat-sidebar:shelf-expansion:v1";
const SETTLED_INITIAL_LIMIT = 10;
const SETTLED_PAGE_SIZE = 25;

interface ShelfExpansionState {
  snoozed: boolean;
  settled: boolean;
}

const COLLAPSED_SHELVES: ShelfExpansionState = {
  snoozed: false,
  settled: false,
};

function readShelfExpansion(): ShelfExpansionState {
  try {
    const stored = window.localStorage.getItem(SHELF_EXPANSION_STORAGE_KEY);
    if (!stored) return COLLAPSED_SHELVES;
    const parsed = JSON.parse(stored) as Partial<ShelfExpansionState>;
    return {
      snoozed: parsed.snoozed === true,
      settled: parsed.settled === true,
    };
  } catch {
    return COLLAPSED_SHELVES;
  }
}

function visibleParkedThreads(
  threads: readonly PluginSidebarThread[],
  expanded: boolean,
  activeThreadId: string | null,
  limit = threads.length,
): PluginSidebarThread[] {
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!expanded) return activeThread ? [activeThread] : [];
  return threads.filter(
    (thread, index) => index < limit || thread.id === activeThreadId,
  );
}

/**
 * The sidebar's scrolling list: one flat, statically ordered stack of cards.
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
  const actions = useSidebarThreadActions();
  const { values: settings } = useSettings();
  const lifecycle = useLifecycle(threads);
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const configuredSnoozePresets =
    typeof settings?.snoozePresets === "string"
      ? settings.snoozePresets
      : DEFAULT_SNOOZE_PRESET_CONFIG;
  const snoozePresets = useMemo(
    () => parseConfiguredSnoozePresets(configuredSnoozePresets),
    [configuredSnoozePresets],
  );
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
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
  const [settledLimit, setSettledLimit] = useState(SETTLED_INITIAL_LIMIT);
  const [selection, setSelection] = useState<ThreadSelectionState>(
    EMPTY_THREAD_SELECTION,
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SHELF_EXPANSION_STORAGE_KEY,
        JSON.stringify(expandedShelves),
      );
    } catch {
      // Storage may be unavailable in a hardened browser. The shelves still
      // work for this mount; only the preference becomes non-durable.
    }
  }, [expandedShelves]);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const {
    pinnedBase,
    inboxBase,
    allPinnedBase,
    allInboxBase,
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
    const onSnoozeShelf: typeof visible = [];
    const onSettledShelf: typeof visible = [];
    for (const thread of visible) {
      const shelf = lifecycle.shelfFor(thread);
      if (shelf === "snoozed") onSnoozeShelf.push(thread);
      else if (shelf === "settled") onSettledShelf.push(thread);
      else active.push(thread);
    }
    const split = partitionPinned(active);
    const allSplit = partitionPinned(allVisible);
    return {
      // BB supplies pinned rows in the user's persisted pin order.
      pinnedBase: split.pinned,
      inboxBase: sortByCreatedAtDescending(split.inbox),
      // Keep a global order behind project-scoped and parked views. Child and
      // parked rows are included because they can become visible later; a
      // reorder elsewhere must not silently discard their old slot.
      allPinnedBase: allSplit.pinned,
      allInboxBase: sortByCreatedAtDescending(allSplit.inbox),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozed: [...onSnoozeShelf].sort(
        (left, right) =>
          (lifecycle.wakeAtFor(left) ?? 0) - (lifecycle.wakeAtFor(right) ?? 0),
      ),
      settled: sortSettledThreads(onSettledShelf, lifecycle.settledAtFor),
    };
  }, [lifecycle, scope, threads]);

  const pinnedReorder = usePinnedReorder(allPinnedBase);
  const inboxReorder = useInboxReorder(allInboxBase);
  const [dragOrder, setDragOrder] = useState<{
    shelf: "pinned" | "inbox";
    movingId: string;
    ids: string[];
  } | null>(null);
  const dragOrderRef = useRef(dragOrder);
  dragOrderRef.current = dragOrder;
  const pinned = useMemo(() => {
    const ordered = orderPinnedThreads(pinnedBase, pinnedReorder.ids);
    return orderPinnedThreads(
      ordered,
      dragOrder?.shelf === "pinned" ? dragOrder.ids : null,
    );
  }, [dragOrder, pinnedBase, pinnedReorder.ids]);
  const inbox = useMemo(() => {
    const ordered = orderPinnedThreads(inboxBase, inboxReorder.ids);
    return orderPinnedThreads(
      ordered,
      dragOrder?.shelf === "inbox" ? dragOrder.ids : null,
    );
  }, [dragOrder, inboxBase, inboxReorder.ids]);

  const threadReorderControls = (
    thread: PluginSidebarThread,
    shelf: "pinned" | "inbox",
  ): ThreadReorderControls => {
    const target = shelf === "pinned" ? pinnedReorder : inboxReorder;
    const visibleIds = (shelf === "pinned" ? pinned : inbox).map(
      (candidate) => candidate.id,
    );
    return {
      disabled: target.isReordering,
      isDragging:
        dragOrder?.shelf === shelf && dragOrder.movingId === thread.id,
      onDragStart: (event) => {
        if (target.isReordering) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", thread.id);
        const next = { shelf, movingId: thread.id, ids: visibleIds };
        dragOrderRef.current = next;
        setDragOrder(next);
      },
      onDragEnd: () => {
        dragOrderRef.current = null;
        setDragOrder(null);
      },
      onDragOver: (event) => {
        const current = dragOrderRef.current;
        if (
          !current ||
          current.shelf !== shelf ||
          current.movingId === thread.id
        ) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        const placement =
          event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        const ids = movePinnedId(
          current.ids,
          current.movingId,
          thread.id,
          placement,
        );
        const next = { ...current, ids };
        dragOrderRef.current = next;
        setDragOrder(next);
      },
      onDrop: (event) => {
        const current = dragOrderRef.current;
        if (!current || current.shelf !== shelf) return;
        event.preventDefault();
        dragOrderRef.current = null;
        setDragOrder(null);
        const globalIds = mergeVisibleOrder(target.ids, current.ids);
        if (shelf === "pinned") {
          void pinnedReorder.reorder(globalIds, current.movingId);
        } else {
          void inboxReorder.reorder(globalIds);
        }
      },
      onKeyDown: (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        const ids = movePinnedIdByOffset(
          visibleIds,
          thread.id,
          event.key === "ArrowUp" ? -1 : 1,
        );
        const globalIds = mergeVisibleOrder(target.ids, ids);
        if (shelf === "pinned") {
          void pinnedReorder.reorder(globalIds, thread.id);
        } else {
          void inboxReorder.reorder(globalIds);
        }
      },
    };
  };

  const isSearching = searchQuery.trim().length > 0;
  const searchResults = useMemo(
    () =>
      searchThreadsByTitle(
        [...pinned, ...inbox, ...snoozed, ...settled],
        searchQuery,
      ),
    [inbox, pinned, searchQuery, settled, snoozed],
  );
  const visibleSnoozed = useMemo(
    () =>
      visibleParkedThreads(
        snoozed,
        expandedShelves.snoozed,
        activeThreadId,
      ),
    [activeThreadId, expandedShelves.snoozed, snoozed],
  );
  const visibleSettled = useMemo(
    () =>
      visibleParkedThreads(
        settled,
        expandedShelves.settled,
        activeThreadId,
        settledLimit,
      ),
    [activeThreadId, expandedShelves.settled, settled, settledLimit],
  );
  const selectableThreads = useMemo(
    () =>
      isSearching
        ? searchResults
        : [...pinned, ...inbox, ...visibleSnoozed, ...visibleSettled],
    [
      inbox,
      isSearching,
      pinned,
      searchResults,
      visibleSettled,
      visibleSnoozed,
    ],
  );
  const selectableThreadIds = useMemo(
    () => selectableThreads.map((thread) => thread.id),
    [selectableThreads],
  );
  const selectableThreadIdsKey = selectableThreadIds.join("\0");
  useEffect(() => {
    setSelection((current) =>
      reconcileThreadSelection(current, selectableThreadIds),
    );
  }, [selectableThreadIds, selectableThreadIdsKey]);
  const selectedThreads = useMemo(
    () =>
      selectableThreads.filter((thread) =>
        selection.selectedIds.has(thread.id),
      ),
    [selectableThreads, selection.selectedIds],
  );
  const wokeThreadIds = useMemo(
    () =>
      new Set(
        [...pinned, ...inbox]
          .filter((thread) => lifecycle.wokeFor(thread))
          .map((thread) => thread.id),
      ),
    [inbox, lifecycle, pinned],
  );

  const scopeLabel =
    scope === ALL_PROJECTS
      ? "All projects"
      : (projectNameById.get(scope) ?? "All projects");

  const handleSelectionClick = (
    threadId: string,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ): boolean => {
    const toggleKey = event.metaKey || event.ctrlKey;
    if (!toggleKey && !event.shiftKey) {
      if (selection.selectedIds.size > 0) {
        setSelection(EMPTY_THREAD_SELECTION);
      }
      return false;
    }
    setSelection((current) =>
      updateThreadSelection(current, selectableThreadIds, threadId, {
        shiftKey: event.shiftKey,
        toggleKey,
      }),
    );
    return true;
  };

  const finishBulkAction = (
    actionLabel: string,
    successLabel: string,
    total: number,
    result: BulkActionResult,
  ) => {
    if (result.failures.length === 0) {
      toast.success(
        `${total} ${total === 1 ? "thread" : "threads"} ${successLabel}`,
      );
    } else {
      toast.error(
        `${result.failures.length} of ${total} ${actionLabel} actions failed`,
        { description: result.failures[0]?.error },
      );
    }
    setSelection(
      keepFailedSelection(
        result.failures.map((failure) => failure.threadId),
        selectableThreadIds,
      ),
    );
  };

  const runSelectedAction = async (
    actionLabel: string,
    successLabel: string,
    action: (
      threads: readonly PluginSidebarThread[],
    ) => Promise<BulkActionResult>,
    parksThreads = false,
  ) => {
    if (bulkBusy || selectedThreads.length === 0) return;
    const targets = [...selectedThreads];
    setBulkBusy(true);
    try {
      const result = await action(targets);
      finishBulkAction(actionLabel, successLabel, targets.length, result);
      if (
        parksThreads &&
        activeThreadIdRef.current !== null &&
        result.succeededThreadIds.includes(activeThreadIdRef.current)
      ) {
        const parkedIds = new Set(result.succeededThreadIds);
        const activeRows = [...pinned, ...inbox];
        const activeIndex = activeRows.findIndex(
          (thread) => thread.id === activeThreadIdRef.current,
        );
        const nextThread =
          activeRows
            .slice(activeIndex + 1)
            .find((thread) => !parkedIds.has(thread.id)) ??
          activeRows
            .slice(0, Math.max(0, activeIndex))
            .reverse()
            .find((thread) => !parkedIds.has(thread.id)) ??
          null;
        if (nextThread) actions.open(nextThread.id);
        else {
          actions.openNewThread({
            projectId: targets[0]?.projectId,
            focusPrompt: true,
          });
        }
        onNavigate();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const failures = targets.map((thread) => ({
        threadId: thread.id,
        error: message,
      }));
      finishBulkAction(actionLabel, successLabel, targets.length, {
        succeededThreadIds: [],
        failures,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkParkAction = (
    actionLabel: "settle" | "snooze",
    snoozedUntil?: number,
  ) =>
    runSelectedAction(
      actionLabel,
      actionLabel === "settle" ? "settled" : "snoozed",
      async (targets) => {
        const eligible = targets.filter(lifecycle.canPark);
        const blocked = targets
          .filter((thread) => !lifecycle.canPark(thread))
          .map((thread) => ({
            threadId: thread.id,
            error: "Thread is working or needs input",
          }));
        const result =
          eligible.length === 0
            ? { succeededThreadIds: [], failures: [] }
            : actionLabel === "settle"
              ? await lifecycle.bulkSettle(eligible.map((thread) => thread.id))
              : await lifecycle.bulkSnooze(
                  eligible.map((thread) => thread.id),
                  snoozedUntil!,
                );
        return { ...result, failures: [...result.failures, ...blocked] };
      },
      true,
    );

  const parkActiveThread = async (
    thread: PluginSidebarThread,
    mutation: () => Promise<boolean>,
  ) => {
    const parked = await mutation();
    if (!parked || activeThreadIdRef.current !== thread.id) return;

    const nextThread = nextThreadAfterParking(
      [...pinned, ...inbox],
      thread.id,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The one control the host has no equivalent for. Everything else in
          the chrome above — New thread, search — is bb's and stays bb's. */}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        {selectedThreads.length > 0 ? (
          <BulkSelectionBar
            count={selectedThreads.length}
            busy={bulkBusy}
            snoozePresets={snoozePresets}
            onSettle={() => void runBulkParkAction("settle")}
            onSnooze={(snoozedUntil) =>
              void runBulkParkAction("snooze", snoozedUntil)
            }
            onMarkRead={() =>
              void runSelectedAction("mark read", "marked read", (targets) =>
                runBulkAction(
                  targets.map((thread) => thread.id),
                  (threadId) => actions.setRead(threadId, true),
                ),
              )
            }
            onMarkUnread={() =>
              void runSelectedAction(
                "mark unread",
                "marked unread",
                (targets) =>
                  runBulkAction(
                    targets.map((thread) => thread.id),
                    (threadId) => actions.setRead(threadId, false),
                  ),
              )
            }
            onClear={() => setSelection(EMPTY_THREAD_SELECTION)}
          />
        ) : (
          <Select value={scope} onValueChange={setScope}>
            {/* Ghost trigger: no border, no filled track — it reads as a label
                until you hover it. */}
            <SelectTrigger
              className="h-7 min-w-0 flex-1 border-0 px-1.5 py-1 text-xs font-medium text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0"
              aria-label={`Project scope: ${scopeLabel}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS} className="text-xs">
                All projects
              </SelectItem>
              {projects.map((project) => (
                <SelectItem
                  key={project.id}
                  value={project.id}
                  className="text-xs"
                >
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {status === "loading" ? null : status === "error" ? (
          <p
            role="status"
            className="px-2 py-6 text-center text-xs text-muted-foreground"
          >
            Could not load threads.
          </p>
        ) : (isSearching
            ? searchResults.length
            : pinned.length + inbox.length + snoozed.length + settled.length) ===
          0 ? (
          <p
            role="status"
            className="px-2 py-6 text-center text-xs text-muted-foreground"
          >
            {isSearching ? "No threads found" : "No threads yet"}
          </p>
        ) : isSearching ? (
          <SearchResults
            threads={searchResults}
            projectNameById={projectNameById}
            activeThreadId={activeThreadId}
            now={now}
            wokeThreadIds={wokeThreadIds}
            onAcknowledgeWake={(threadId) =>
              void lifecycle.acknowledgeWake(threadId)
            }
            selectedThreadIds={selection.selectedIds}
            onSelectionClick={handleSelectionClick}
            onNavigate={onNavigate}
          />
        ) : (
          <>
            {pinned.length > 0 ? (
              <Shelf label="Pinned">
                {pinned.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    isActive={thread.id === activeThreadId}
                    isSelected={selection.selectedIds.has(thread.id)}
                    isWoke={wokeThreadIds.has(thread.id)}
                    canPark={lifecycle.canPark(thread)}
                    snoozePresets={snoozePresets}
                    onNavigate={onNavigate}
                    onSettle={() =>
                      void parkActiveThread(thread, () =>
                        lifecycle.settle(thread.id),
                      )
                    }
                    onSnooze={(until) =>
                      void parkActiveThread(thread, () =>
                        lifecycle.snooze(thread.id, until),
                      )
                    }
                    onAcknowledgeWake={() =>
                      void lifecycle.acknowledgeWake(thread.id)
                    }
                    onSelectionClick={(event) =>
                      handleSelectionClick(thread.id, event)
                    }
                    reorder={threadReorderControls(thread, "pinned")}
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            {inbox.length > 0 ? (
              <Shelf label={pinned.length > 0 ? "Inbox" : null}>
                {inbox.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    isActive={thread.id === activeThreadId}
                    isSelected={selection.selectedIds.has(thread.id)}
                    isWoke={wokeThreadIds.has(thread.id)}
                    canPark={lifecycle.canPark(thread)}
                    snoozePresets={snoozePresets}
                    onNavigate={onNavigate}
                    onSettle={() =>
                      void parkActiveThread(thread, () =>
                        lifecycle.settle(thread.id),
                      )
                    }
                    onSnooze={(until) =>
                      void parkActiveThread(thread, () =>
                        lifecycle.snooze(thread.id, until),
                      )
                    }
                    onAcknowledgeWake={() =>
                      void lifecycle.acknowledgeWake(thread.id)
                    }
                    onSelectionClick={(event) =>
                      handleSelectionClick(thread.id, event)
                    }
                    reorder={threadReorderControls(thread, "inbox")}
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            <ParkedShelf
              label="Snoozed"
              threads={snoozed}
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
              selectedThreadIds={selection.selectedIds}
              onSelectionClick={handleSelectionClick}
            />
            <ParkedShelf
              label="Settled"
              threads={settled}
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
              selectedThreadIds={selection.selectedIds}
              onSelectionClick={handleSelectionClick}
              settledLimit={settledLimit}
              onLoadMore={() =>
                setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A collapsed shelf of parked threads. The header stays while anything is
 * parked — the count is the whole footprint when collapsed — and the shelf
 * vanishes entirely at zero.
 */
function ParkedShelf({
  label,
  threads,
  expanded,
  onToggle,
  shelf,
  visibleThreads,
  activeThreadId,
  lifecycle,
  snoozePresets,
  onNavigate,
  selectedThreadIds,
  onSelectionClick,
  settledLimit,
  onLoadMore,
}: {
  label: string;
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  onToggle: () => void;
  shelf: "snoozed" | "settled";
  visibleThreads: readonly PluginSidebarThread[];
  activeThreadId: string | null;
  lifecycle: ReturnType<typeof useLifecycle>;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  onNavigate: () => void;
  selectedThreadIds: ReadonlySet<string>;
  onSelectionClick: (
    threadId: string,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => boolean;
  settledLimit?: number;
  onLoadMore?: () => void;
}) {
  if (threads.length === 0) return null;
  const now = Date.now();
  const limit =
    shelf === "settled" ? (settledLimit ?? threads.length) : threads.length;
  const hasMore = shelf === "settled" && threads.length > limit;
  return (
    <section aria-label={label}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        // Padded like a card, so the chevron ends on the same right edge as
        // every row's status and provider glyph.
        className="mt-3 flex w-full items-center gap-2 px-2.5 pb-1 text-left"
      >
        <span className="text-2xs font-medium text-muted-foreground/70">
          {expanded ? label : `${label} (${threads.length})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border" />
        <span className={TRAILING_GLYPH_BOX_CLASS}>
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 text-muted-foreground/70 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>
      {visibleThreads.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {visibleThreads.map((thread) => (
            <SlimRow
              key={thread.id}
              thread={thread}
              isActive={thread.id === activeThreadId}
              isSelected={selectedThreadIds.has(thread.id)}
              shelf={shelf}
              wakeAt={lifecycle.wakeAtFor(thread)}
              now={now}
              snoozePresets={snoozePresets}
              onSnooze={(until) => void lifecycle.snooze(thread.id, until)}
              onNavigate={onNavigate}
              onSelectionClick={(event) =>
                onSelectionClick(thread.id, event)
              }
              onRestore={() =>
                shelf === "snoozed"
                  ? void lifecycle.unsnooze(thread.id)
                  : void lifecycle.unsettle(thread.id)
              }
            />
          ))}
        </ul>
      ) : null}
      {expanded && hasMore && onLoadMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="ml-2.5 mt-1 rounded px-1.5 py-1 text-2xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          Load {Math.min(SETTLED_PAGE_SIZE, threads.length - limit)} more
        </button>
      ) : null}
    </section>
  );
}

function Shelf({
  label,
  children,
}: {
  label: string | null;
  children: React.ReactNode;
}) {
  return (
    // A named section is exposed as a landmark region; an unnamed one is not,
    // which is exactly right for the single unlabelled inbox list.
    <section {...(label ? { "aria-label": label } : {})}>
      {label ? (
        <h2 className={cn("flex items-center gap-2 px-2.5 pb-1 pt-3")}>
          <span className="text-2xs font-medium text-muted-foreground/70">
            {label}
          </span>
          <span className="h-px flex-1 bg-sidebar-border" />
        </h2>
      ) : null}
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}
