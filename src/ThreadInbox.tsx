import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadListProps,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/Select";
import { ThreadCard } from "./ThreadCard";
import { SlimRow } from "./SlimRow";
import { SearchResults } from "./SearchResults";
import { useLifecycle } from "./useLifecycle";
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
  DEFAULT_SNOOZE_PRESET_CONFIG,
  parseConfiguredSnoozePresets,
  type ConfiguredSnoozePreset,
} from "./lifecycle";

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

  const { pinned, inbox, snoozed, settled } = useMemo(() => {
    const scoped = filterByProject(
      visibleInboxThreads(threads),
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
    return {
      pinned: sortByCreatedAtDescending(split.pinned),
      inbox: sortByCreatedAtDescending(split.inbox),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozed: [...onSnoozeShelf].sort(
        (left, right) =>
          (lifecycle.wakeAtFor(left) ?? 0) - (lifecycle.wakeAtFor(right) ?? 0),
      ),
      settled: sortSettledThreads(onSettledShelf, lifecycle.settledAtFor),
    };
  }, [lifecycle, scope, threads]);

  const isSearching = searchQuery.trim().length > 0;
  const searchResults = useMemo(
    () =>
      searchThreadsByTitle(
        [...pinned, ...inbox, ...snoozed, ...settled],
        searchQuery,
      ),
    [inbox, pinned, searchQuery, settled, snoozed],
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
              activeThreadId={activeThreadId}
              lifecycle={lifecycle}
              snoozePresets={snoozePresets}
              onNavigate={onNavigate}
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
              activeThreadId={activeThreadId}
              lifecycle={lifecycle}
              snoozePresets={snoozePresets}
              onNavigate={onNavigate}
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
  activeThreadId,
  lifecycle,
  snoozePresets,
  onNavigate,
  settledLimit,
  onLoadMore,
}: {
  label: string;
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  onToggle: () => void;
  shelf: "snoozed" | "settled";
  activeThreadId: string | null;
  lifecycle: ReturnType<typeof useLifecycle>;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  onNavigate: () => void;
  settledLimit?: number;
  onLoadMore?: () => void;
}) {
  if (threads.length === 0) return null;
  const now = Date.now();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const limit =
    shelf === "settled" ? (settledLimit ?? threads.length) : threads.length;
  const visibleThreads = expanded
    ? threads.filter(
        (thread, index) => index < limit || thread.id === activeThreadId,
      )
    : activeThread
      ? [activeThread]
      : [];
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
              shelf={shelf}
              wakeAt={lifecycle.wakeAtFor(thread)}
              now={now}
              snoozePresets={snoozePresets}
              onSnooze={(until) => void lifecycle.snooze(thread.id, until)}
              onNavigate={onNavigate}
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
