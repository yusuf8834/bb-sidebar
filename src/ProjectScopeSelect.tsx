import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./components/Popover";
import { ProjectFavicon } from "./ProjectFavicon";
import { projectIconUrl } from "./project-icons";
import { filterProjectsByName } from "./inbox";
import { cn } from "./lib/utils";

const ALL_PROJECTS_LABEL = "All projects";
const ALL_PROJECTS = "__all__";
const GRID_ID = "bb-sidebar-project-scope-grid";
const HINT_ID = `${GRID_ID}-hint`;
const rowId = (index: number) => `${GRID_ID}-row-${index}`;

interface ScopeOption {
  id: string;
  name: string;
}

/**
 * Focusing the filter field raises the on-screen keyboard on touch devices,
 * which covers the list the user opened the picker to tap.
 */
function hasCoarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches === true;
}

/**
 * Project scope picker. The card opens with a filter field in its first row, so
 * a long project list stays reachable by typing instead of scrolling.
 */
export function ProjectScopeSelect({
  scope,
  projects,
  projectIconRevision,
  onResetScope,
  onToggleScope,
  pinnedProjects,
  onToggleProjectPin,
}: {
  scope: readonly string[];
  projects: readonly PluginSidebarProject[];
  projectIconRevision: number;
  onResetScope: () => void;
  onToggleScope: (id: string) => void;
  pinnedProjects: readonly string[];
  onToggleProjectPin: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);

  const options = useMemo<ScopeOption[]>(
    () => [
      { id: ALL_PROJECTS, name: ALL_PROJECTS_LABEL },
      ...projects.map((project) => ({ id: project.id, name: project.name })),
    ],
    [projects],
  );
  const matches = useMemo(() => filterProjectsByName(options, query), [options, query]);
  const unpinnedScope = scope.filter((id) => !pinnedProjects.includes(id));
  const scopeNames = unpinnedScope.map((id) => projects.find((project) => project.id === id)?.name ?? id);
  const pinnedCount = scope.length - unpinnedScope.length;
  const pinnedLabel = pinnedCount > 0 ? `${pinnedCount} ${pinnedCount === 1 ? "project" : "projects"}` : "";
  const scopeLabel = scope.length === 0 ? ALL_PROJECTS_LABEL : [...scopeNames, pinnedLabel].filter(Boolean).join(" + ");
  const selected = (id: string) => (id === ALL_PROJECTS ? scope.length === 0 : scope.includes(id));
  // The highlight follows the list as filtering shrinks it under the cursor.
  const highlighted = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);

  useEffect(() => {
    if (!open || highlighted < 0) return;
    listRef.current?.querySelector(`[data-scope-option="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setQuery("");
    if (nextOpen) {
      const current = options.findIndex((option) => selected(option.id));
      setActiveIndex(current < 0 ? 0 : current);
    }
  };

  const select = (optionId: string) => {
    if (optionId === ALL_PROJECTS) onResetScope();
    else onToggleScope(optionId);
    if (!hasCoarsePointer()) queryRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (open) return;
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      // Swallowing the key stops the browser from turning it into a click that
      // would toggle the card shut again.
      event.preventDefault();
      handleOpenChange(true);
    }
  };

  const handleQueryKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((highlighted + step + matches.length) % matches.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : matches.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = matches[highlighted];
      if (option) select(option.id);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {/* Anchor to the whole header so Reset never changes the menu width. */}
      <PopoverAnchor asChild>
        <div className="relative flex items-center">
          {/* Ghost trigger: no border, no filled track — it reads as a label
          until you hover it. */}
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-haspopup="grid"
              aria-expanded={open}
              aria-label={`Project scope: ${scopeLabel}`}
              title={scopeLabel}
              onKeyDown={handleTriggerKeyDown}
              className="flex min-h-7 min-w-0 flex-1 items-center justify-between gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:duration-0"
            >
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left">
                {scope.length === 0
                  ? ALL_PROJECTS_LABEL
                  : unpinnedScope.map((id, index) => (
                      <span key={id} className="flex min-w-0 max-w-full items-center gap-1.5">
                        <ProjectFavicon
                          src={projectIconUrl(id, projectIconRevision)}
                          name={scopeNames[index]}
                          className="size-3"
                        />
                        <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{scopeNames[index]}</span>
                      </span>
                    ))}
                {pinnedCount > 0 ? <span>{`${unpinnedScope.length > 0 ? "+ " : ""}${pinnedLabel}`}</span> : null}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {/* Reserve width only; the reset button must not increase the header height. */}
                {scope.length > 0 ? <span aria-hidden className="w-6" /> : null}
                <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
              </span>
            </button>
          </PopoverTrigger>
          {scope.length > 0 ? (
            <button
              type="button"
              aria-label="Reset project filter"
              title="Reset project filter"
              onClick={onResetScope}
              className="absolute right-7 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon name="ArrowTurnBackward" className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-48 p-0"
        onOpenAutoFocus={(event) => {
          if (hasCoarsePointer()) event.preventDefault();
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-border px-2">
          <Icon name="Search" className="size-3 shrink-0 opacity-50" aria-hidden="true" />
          <input
            ref={queryRef}
            role="combobox"
            aria-haspopup="grid"
            aria-label="Filter projects"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={GRID_ID}
            aria-describedby={HINT_ID}
            aria-activedescendant={highlighted < 0 ? undefined : rowId(highlighted)}
            value={query}
            placeholder="Filter projects"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleQueryKeyDown}
            className="h-8 w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <p id={HINT_ID} className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
          Select one or more projects
        </p>
        <div
          ref={listRef}
          id={GRID_ID}
          role="grid"
          aria-label="Projects"
          aria-multiselectable="true"
          className="max-h-72 overflow-y-auto p-1"
        >
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No projects found</p>
          ) : (
            matches.map((option, index) => (
              <div
                key={option.id}
                id={rowId(index)}
                data-scope-option={index}
                role="row"
                aria-label={option.name}
                aria-selected={selected(option.id)}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => select(option.id)}
                className={cn(
                  "flex w-full cursor-default select-none items-center rounded-sm pl-2 pr-2 text-xs outline-none",
                  index === highlighted && "bg-state-hover text-foreground",
                )}
              >
                <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {option.id !== ALL_PROJECTS ? (
                      <ProjectFavicon
                        src={projectIconUrl(option.id, projectIconRevision)}
                        name={option.name}
                        className="size-3"
                      />
                    ) : null}
                    <span className="truncate">{option.name}</span>
                  </span>
                </div>
                <div role="gridcell" className="ml-1 flex shrink-0 items-center gap-1">
                  {option.id !== ALL_PROJECTS ? (
                    <button
                      type="button"
                      tabIndex={index === highlighted ? 0 : -1}
                      aria-label={`${pinnedProjects.includes(option.id) ? "Unpin" : "Pin"} ${option.name}`}
                      title={`${pinnedProjects.includes(option.id) ? "Unpin" : "Pin"} ${option.name}`}
                      onFocus={() => setActiveIndex(index)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleProjectPin(option.id);
                      }}
                      onKeyDown={(event) => {
                        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                          handleQueryKeyDown(event);
                          queryRef.current?.focus();
                        }
                      }}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        pinnedProjects.includes(option.id) ? "text-foreground" : "text-muted-foreground/40",
                        !pinnedProjects.includes(option.id) &&
                          index !== highlighted &&
                          "opacity-0 focus:opacity-100 [@media(hover:none)]:opacity-100",
                      )}
                    >
                      <Icon
                        name={pinnedProjects.includes(option.id) ? "PinOff" : "Pin"}
                        className="size-3.5"
                        aria-hidden
                      />
                    </button>
                  ) : (
                    <span aria-hidden="true" className="size-7" />
                  )}
                  <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
                    {selected(option.id) || index === highlighted ? (
                      <Icon name="Check" className={cn("size-4", !selected(option.id) && "text-muted-foreground/40")} />
                    ) : null}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
          <span role="status" className="px-1 text-xs text-muted-foreground">
            {scope.length === 0
              ? ALL_PROJECTS_LABEL
              : `${scope.length} ${scope.length === 1 ? "project" : "projects"} selected`}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {scope.length > 0 ? (
              <button
                type="button"
                aria-label="Reset to all projects"
                onClick={() => select(ALL_PROJECTS)}
                className="rounded-sm px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Reset
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="rounded-sm px-1 py-0.5 text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Done
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
