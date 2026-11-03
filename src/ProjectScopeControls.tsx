import type { useSidebarThreads } from "./bb-sdk";
import { useInboxActions, useInboxEnvironment } from "./InboxContext";
import { FilterBar } from "./FilterBar";
import type { ThreadFilter } from "./thread-filter";
import { ProjectFavicon } from "./ProjectFavicon";
import { projectIconUrl } from "./project-icons";
import { usePinnedProjects } from "./usePinnedProjects";
import { cn } from "./lib/utils";
import { useState, type Dispatch, type DragEvent, type SetStateAction } from "react";

function dropPlacement(event: DragEvent<HTMLButtonElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
}

export function ProjectScopeControls({
  scope,
  status,
  filter,
  onFilterChange,
  hosts,
}: {
  scope: readonly string[];
  status: ReturnType<typeof useSidebarThreads>["status"];
  filter: ThreadFilter;
  onFilterChange: Dispatch<SetStateAction<ThreadFilter>>;
  hosts: readonly string[];
}) {
  const { projects, projectIconRevision } = useInboxEnvironment();
  const { setScope } = useInboxActions();
  const { pinnedProjects, toggleProjectPin, moveProjectPin } = usePinnedProjects({ projects, status });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const clearDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };
  const shortcuts = pinnedProjects.flatMap((id) => {
    const project = projects.find((project) => project.id === id);
    return project ? [project] : [];
  });
  return (
    <div className="shrink-0 px-2 pb-1">
      <FilterBar
        scope={scope}
        onScopeChange={setScope}
        filter={filter}
        onFilterChange={onFilterChange}
        projects={projects}
        hosts={hosts}
        projectIconRevision={projectIconRevision}
        pinnedProjects={pinnedProjects}
        onToggleProjectPin={toggleProjectPin}
      />
      {shortcuts.length > 0 ? (
        <div role="group" aria-label="Pinned projects" className="flex flex-wrap gap-1 pt-1">
          {shortcuts.map((project) => {
            const active = scope.includes(project.id);
            return (
              <button
                key={project.id}
                type="button"
                aria-label={`Filter by ${project.name}`}
                aria-pressed={active}
                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                title={`${active ? "Remove" : "Add"} ${project.name} ${active ? "from" : "to"} project filter. Drag to reorder, or use Alt+Left/Right.`}
                draggable={shortcuts.length > 1}
                onDragStart={(event) => {
                  event.stopPropagation();
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-bb-sidebar-pinned-project", project.id);
                  setDraggingId(project.id);
                }}
                onDragOver={(event) => {
                  if (!draggingId || draggingId === project.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropTarget({ id: project.id, placement: dropPlacement(event) });
                }}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                  setDropTarget(null);
                }}
                onDrop={(event) => {
                  if (!draggingId) return;
                  event.preventDefault();
                  event.stopPropagation();
                  moveProjectPin(draggingId, project.id, dropPlacement(event));
                  clearDrag();
                }}
                onDragEnd={clearDrag}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const offset = event.key === "ArrowLeft" ? -1 : 1;
                  const target = shortcuts[shortcuts.indexOf(project) + offset];
                  if (target) moveProjectPin(project.id, target.id, offset < 0 ? "before" : "after");
                }}
                onClick={() =>
                  setScope((current) =>
                    current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id],
                  )
                }
                className={cn(
                  "relative flex min-h-7 min-w-0 max-w-full select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-xs outline-none hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring [&_img]:pointer-events-none",
                  active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
                  shortcuts.length > 1 && "cursor-grab active:cursor-grabbing",
                  draggingId === project.id && "opacity-50",
                )}
              >
                {dropTarget?.id === project.id ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-ring",
                      dropTarget.placement === "before" ? "-left-0.5" : "-right-0.5",
                    )}
                  />
                ) : null}
                <ProjectFavicon
                  src={projectIconUrl(project.id, projectIconRevision)}
                  name={project.name}
                  className="size-3"
                />
                <span className="truncate">{project.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
