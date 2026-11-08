import type { ReactNode } from "react";
import type { ProjectViewUnit } from "./inbox-layout";
import type { ThreadReorderControls } from "./ThreadCard";
import { environmentLabel } from "./environment-groups";
import { Icon } from "./components/Icon";
import { GroupAlertDots, groupAlertPhrase } from "./GroupAlertDots";
import { cn } from "./lib/utils";
import { useListMotion } from "./useListMotion";

export function EnvironmentGroup({
  unit,
  onToggle,
  reorder,
  children,
}: {
  unit: Extract<ProjectViewUnit, { kind: "group" }>;
  onToggle: () => void;
  reorder: ThreadReorderControls;
  children: ReactNode;
}) {
  const attachListRef = useListMotion<HTMLUListElement>();
  const environment = unit.environment!;
  const label = environmentLabel(environment);
  const host = unit.threads.find((thread) => thread.host)?.host;
  return (
    <li
      data-reorder-unit={unit.key}
      className={cn(
        "list-none rounded-md",
        reorder.isDragging && "relative z-20 bg-sidebar-accent shadow-lg ring-1 ring-sidebar-border",
      )}
    >
      <section data-drag-visual="" aria-label={`${label} worktree`}>
        <button
          type="button"
          data-reorder-key={unit.key}
          aria-expanded={unit.expanded}
          aria-label={`${label} (${unit.threadCount})${groupAlertPhrase(unit.alerts)}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title={[environment.name, environment.path, host?.name].filter(Boolean).join("\n")}
          onClick={onToggle}
          onPointerDown={reorder.onPointerDown}
          onKeyDown={reorder.onKeyDown}
          className={cn(
            "flex w-full touch-pan-y items-center gap-1.5 px-2.5 pb-1 pt-2 text-left text-2xs text-muted-foreground",
            !reorder.disabled && "cursor-grab active:cursor-grabbing",
          )}
        >
          <Icon name="FolderGit" className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
          <span className="min-w-0 truncate font-mono">{label}</span>
          <span className="shrink-0 text-muted-foreground/50">{unit.threadCount}</span>
          <GroupAlertDots alerts={unit.alerts} />
          <span className="flex-1" />
          <Icon
            name="ChevronDown"
            className={cn("size-3 shrink-0 text-muted-foreground/50", unit.expanded && "rotate-180")}
            aria-hidden
          />
        </button>
        <ul
          ref={attachListRef}
          aria-label={`${label} active threads`}
          className="ml-2 flex flex-col gap-px border-l border-sidebar-border/60 pl-1"
        >
          {children}
        </ul>
      </section>
    </li>
  );
}
