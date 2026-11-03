import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { ProjectFavicon } from "./ProjectFavicon";
import { projectIconUrl } from "./project-icons";
import { cn } from "./lib/utils";
import { BROWSER_EVENTS } from "./lib/browser-events";
import { useRecentFilters } from "./useThreadFilter";
import {
  EMPTY_FILTER,
  currentToken,
  extractCompletedTokens,
  suggestionKey,
  suggestionsFor,
  toggleHost,
  toggleIsValue,
  type IsValue,
  type Suggestion,
  type ThreadFilter,
} from "./thread-filter";

const LISTBOX_ID = "bb-sidebar-filter-suggestions";
const optionId = (index: number) => `${LISTBOX_ID}-${index}`;

type Chip =
  | { kind: "project"; id: string; label: string }
  | { kind: "host"; name: string; label: string }
  | { kind: "is"; value: IsValue; label: string };

function withoutToken(text: string): string {
  const token = currentToken(text);
  return text.slice(0, text.length - token.length);
}

/**
 * Keyboard-first thread filter, in TaskYou's grammar: [project], @machine,
 * is:state or is:shelf, and free text for titles. Finished tokens become
 * chips; Enter or Tab takes the highlighted suggestion, Backspace in an empty
 * field drops the last chip, and Escape steps back out.
 */
export function FilterBar({
  scope,
  onScopeChange,
  filter,
  onFilterChange,
  projects,
  hosts,
  projectIconRevision,
  pinnedProjects,
  onToggleProjectPin,
}: {
  scope: readonly string[];
  onScopeChange: Dispatch<SetStateAction<string[]>>;
  filter: ThreadFilter;
  onFilterChange: Dispatch<SetStateAction<ThreadFilter>>;
  projects: readonly PluginSidebarProject[];
  hosts: readonly string[];
  projectIconRevision: number;
  pinnedProjects: readonly string[];
  onToggleProjectPin: (projectId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [recents, remember] = useRecentFilters();
  const text = filter.keyword;
  const token = currentToken(text);

  const suggestions = useMemo(
    () => (open ? suggestionsFor(token, { projects, hosts, scope, filter, recents }) : []),
    [open, token, projects, hosts, scope, filter, recents],
  );
  const highlighted = suggestions.length === 0 ? -1 : Math.min(activeIndex, suggestions.length - 1);

  const chips = useMemo<Chip[]>(() => {
    const projectChips = scope.flatMap((id): Chip[] => {
      const project = projects.find((entry) => entry.id === id);
      return project ? [{ kind: "project", id, label: project.name }] : [];
    });
    const isChips = [...filter.states, ...filter.shelves].map(
      (value): Chip => ({ kind: "is", value, label: `is:${value}` }),
    );
    const hostChips = filter.hosts.map((name): Chip => ({ kind: "host", name, label: `@${name}` }));
    return [...projectChips, ...isChips, ...hostChips];
  }, [scope, projects, filter]);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
      setActiveIndex(-1);
    };
    window.addEventListener(BROWSER_EVENTS.focusFilter, focus);
    return () => window.removeEventListener(BROWSER_EVENTS.focusFilter, focus);
  }, []);

  useEffect(() => {
    if (highlighted < 0) return;
    listRef.current?.querySelector(`#${optionId(highlighted)}`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const setText = (next: string) => onFilterChange((current) => ({ ...current, keyword: next }));

  const handleChange = (next: string) => {
    const parsed = extractCompletedTokens(next, { projects, hosts });
    for (const id of parsed.projects) remember(`project:${id}`);
    for (const host of parsed.hosts) remember(`host:${host.toLowerCase()}`);
    for (const value of parsed.isValues) remember(`is:${value}`);
    if (parsed.projects.length > 0) {
      onScopeChange((current) => [...current, ...parsed.projects.filter((id) => !current.includes(id))]);
    }
    onFilterChange((current) => {
      let updated = { ...current, keyword: parsed.rest };
      for (const host of parsed.hosts)
        if (!updated.hosts.includes(host.toLowerCase())) updated = toggleHost(updated, host);
      for (const value of parsed.isValues) {
        const present = (updated.states as string[]).includes(value) || (updated.shelves as string[]).includes(value);
        if (!present) updated = toggleIsValue(updated, value);
      }
      return updated;
    });
    setOpen(true);
    setActiveIndex(currentToken(parsed.rest).length > 0 ? 0 : -1);
  };

  const apply = (suggestion: Suggestion) => {
    if (!suggestion.selected) remember(suggestionKey(suggestion));
    if (suggestion.kind === "project") {
      onScopeChange((current) =>
        current.includes(suggestion.id) ? current.filter((id) => id !== suggestion.id) : [...current, suggestion.id],
      );
    }
    onFilterChange((current) => {
      const cleared = { ...current, keyword: withoutToken(current.keyword) };
      if (suggestion.kind === "host") return toggleHost(cleared, suggestion.name);
      if (suggestion.kind === "is") return toggleIsValue(cleared, suggestion.value);
      return cleared;
    });
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const removeChip = (chip: Chip) => {
    if (chip.kind === "project") onScopeChange((current) => current.filter((id) => id !== chip.id));
    else if (chip.kind === "host") onFilterChange((current) => toggleHost(current, chip.name));
    else onFilterChange((current) => toggleIsValue(current, chip.value));
  };

  const clearAll = () => {
    onScopeChange([]);
    onFilterChange(EMPTY_FILTER);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const suggestion = highlighted >= 0 ? suggestions[highlighted] : undefined;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) setOpen(true);
        if (suggestions.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex(
          highlighted < 0 && step < 0
            ? suggestions.length - 1
            : (highlighted + step + suggestions.length) % suggestions.length,
        );
        return;
      }
      case "Enter":
      case "Tab":
        if (suggestion && (event.key === "Enter" || token.length > 0)) {
          event.preventDefault();
          apply(suggestion);
        } else if (event.key === "Enter") {
          event.preventDefault();
          setOpen(false);
          inputRef.current?.blur();
        }
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (open && suggestions.length > 0) setOpen(false);
        else if (text.length > 0) setText("");
        else inputRef.current?.blur();
        return;
      case "Backspace":
        if (text.length > 0 || event.currentTarget.selectionStart !== 0) return;
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) clearAll();
        else {
          const last = chips.at(-1);
          if (last) removeChip(last);
        }
        return;
      case "p":
        if (event.altKey && suggestion?.kind === "project") {
          event.preventDefault();
          onToggleProjectPin(suggestion.id);
        }
        return;
    }
  };

  const hasFilter = chips.length > 0 || text.trim().length > 0;

  return (
    <div className="relative">
      <div
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
        className="flex min-h-7 flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors duration-150 focus-within:bg-sidebar-accent hover:bg-sidebar-accent hover:duration-0"
      >
        <Icon name="Search" className="size-3 shrink-0 text-muted-foreground opacity-60" aria-hidden />
        {chips.map((chip) => (
          <button
            key={chip.kind === "project" ? chip.id : chip.label}
            type="button"
            tabIndex={-1}
            title={`Remove ${chip.label}`}
            aria-label={`Remove ${chip.label} from filter`}
            onClick={() => removeChip(chip)}
            className="group flex max-w-full items-center gap-1 rounded bg-state-hover px-1 py-0.5 font-medium text-foreground hover:bg-state-active"
          >
            {chip.kind === "project" ? (
              <ProjectFavicon src={projectIconUrl(chip.id, projectIconRevision)} name={chip.label} className="size-3" />
            ) : null}
            <span className="truncate">{chip.label}</span>
            <Icon name="CircleX" className="size-3 shrink-0 opacity-0 group-hover:opacity-60" aria-hidden />
          </button>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Filter threads"
          aria-expanded={open && suggestions.length > 0}
          aria-autocomplete="list"
          aria-controls={LISTBOX_ID}
          aria-activedescendant={highlighted < 0 ? undefined : optionId(highlighted)}
          aria-keyshortcuts="Control+Shift+S Meta+Shift+S"
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder={chips.length === 0 ? "Filter: [project] @machine is:status" : ""}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="h-5 min-w-16 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
        {hasFilter ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear filter"
            title="Clear filter (Ctrl+Backspace in an empty field)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearAll}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <Icon name="ArrowTurnBackward" className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {open && suggestions.length > 0 ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover text-popover-foreground shadow-md">
          <div
            ref={listRef}
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Filter suggestions"
            className="max-h-72 overflow-y-auto p-1"
          >
            {suggestions.map((suggestion, index) => {
              const previous = suggestions[index - 1];
              const heading =
                groupLabel(suggestion) === (previous && groupLabel(previous)) ? null : groupLabel(suggestion);
              return (
                <div key={suggestionKey(suggestion)}>
                  {heading ? (
                    <p className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {heading}
                    </p>
                  ) : null}
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === highlighted}
                    // Keep focus in the field so typing continues after a click.
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => apply(suggestion)}
                    className={cn(
                      "flex cursor-default select-none items-center gap-1.5 rounded-sm px-2 py-1 text-xs",
                      index === highlighted && "bg-state-hover text-foreground",
                    )}
                  >
                    <SuggestionLabel suggestion={suggestion} projectIconRevision={projectIconRevision} />
                    {suggestion.kind === "project" ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        title={`${pinnedProjects.includes(suggestion.id) ? "Unpin" : "Pin"} ${suggestion.name} (Alt+P)`}
                        aria-label={`${pinnedProjects.includes(suggestion.id) ? "Unpin" : "Pin"} ${suggestion.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleProjectPin(suggestion.id);
                        }}
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-sm",
                          pinnedProjects.includes(suggestion.id)
                            ? "text-foreground"
                            : "text-muted-foreground/40 opacity-0 hover:opacity-100",
                          index === highlighted && "opacity-100",
                        )}
                      >
                        <Icon
                          name={pinnedProjects.includes(suggestion.id) ? "PinOff" : "Pin"}
                          className="size-3"
                          aria-hidden
                        />
                      </button>
                    ) : null}
                    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
                      {suggestion.selected ? <Icon name="Check" className="size-3.5" /> : null}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
            ↑↓ move · ↵ add/remove · ⌫ drop last · esc close
          </p>
        </div>
      ) : null}
    </div>
  );
}

const groupLabel = (suggestion: Suggestion) => (suggestion.recent ? "Recent" : GROUP_LABELS[suggestion.kind]);

const GROUP_LABELS: Record<Suggestion["kind"], string> = {
  is: "Status and shelves",
  host: "Machines",
  project: "Projects",
};

function SuggestionLabel({ suggestion, projectIconRevision }: { suggestion: Suggestion; projectIconRevision: number }) {
  if (suggestion.kind === "project") {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <ProjectFavicon
          src={projectIconUrl(suggestion.id, projectIconRevision)}
          name={suggestion.name}
          className="size-3"
        />
        <span className="truncate">{suggestion.name}</span>
      </span>
    );
  }
  if (suggestion.kind === "host") {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Icon name="Computer" className="size-3 shrink-0 opacity-60" aria-hidden />
        <span className="truncate">@{suggestion.name}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className="shrink-0 font-medium">is:{suggestion.value}</span>
      <span className="truncate text-muted-foreground">{suggestion.label}</span>
    </span>
  );
}
