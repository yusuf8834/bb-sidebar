import { useId, useRef, useState } from "react";
import { ACTIVE_SORT_MODES, type ActiveSortMode } from "./inbox-layout";
import { Icon } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { cn } from "./lib/utils";

const SORT_LABELS: Record<ActiveSortMode, string> = {
  manual: "Manual order",
  activity: "Recent activity",
  created: "Date created",
  project: "Project",
};

export function ActiveSortPicker({
  mode,
  onModeChange,
  groupEnvironments,
  onGroupEnvironmentsChange,
  groupSingleThreadProjects,
  onGroupSingleThreadProjectsChange,
}: {
  mode: ActiveSortMode;
  onModeChange: (mode: ActiveSortMode) => void;
  groupEnvironments: boolean;
  onGroupEnvironmentsChange: (enabled: boolean) => void;
  groupSingleThreadProjects: boolean;
  onGroupSingleThreadProjectsChange: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const groupName = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Sort active threads: ${SORT_LABELS[mode]}`}
          title={`Sort active threads: ${SORT_LABELS[mode]}`}
          onKeyDown={(event) => {
            if (!open && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={cn(
            "absolute bottom-1 right-[1.875rem] z-10 flex size-4 items-center justify-between rounded-md border-0 bg-transparent p-0 text-muted-foreground/40 shadow-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-muted-foreground hover:duration-0 focus:outline-none focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring",
            mode !== "manual" && "bg-sidebar-accent/60 text-muted-foreground/80",
          )}
        >
          <Icon name="ArrowUpDown" className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        aria-label="Sort active threads"
        className="min-w-48 p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
        }}
      >
        <div role="radiogroup" aria-label="Sort by">
          {ACTIVE_SORT_MODES.map((value) => (
            <label key={value} className="block cursor-default">
              <input
                type="radio"
                name={groupName}
                value={value}
                checked={mode === value}
                className="peer sr-only"
                onChange={() => onModeChange(value)}
                onClick={(event) => {
                  if (event.detail > 0 && value !== "project") setOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value !== "project") {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
              />
              <span className="flex items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover peer-focus-visible:bg-state-hover">
                {SORT_LABELS[value]}
                <span className="flex size-3.5 items-center justify-center">
                  {mode === value ? <Icon name="Check" className="size-4" aria-hidden /> : null}
                </span>
              </span>
            </label>
          ))}
        </div>
        {mode === "project" ? (
          <div className="mt-1 border-t border-border pt-1">
            <SortOption
              label="Group single-thread projects"
              checked={groupSingleThreadProjects}
              onChange={onGroupSingleThreadProjectsChange}
            />
            <SortOption label="Group by worktree" checked={groupEnvironments} onChange={onGroupEnvironmentsChange} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SortOption({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="block cursor-default">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-xs hover:bg-state-hover peer-focus-visible:bg-state-hover">
        {label}
        <span className="flex size-3.5 items-center justify-center">
          {checked ? <Icon name="Check" className="size-4" aria-hidden /> : null}
        </span>
      </span>
    </label>
  );
}
