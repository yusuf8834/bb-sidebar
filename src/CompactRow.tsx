import type { ComponentProps, CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { InlineThreadTitle } from "./InlineThreadTitle";
import { ProjectFavicon, ProjectStripe } from "./ProjectFavicon";
import { ThreadDetailsTooltip } from "./ThreadDetailsTooltip";
import { cn } from "./lib/utils";

/** Shared one-line layout; callers own navigation, menus, and trailing actions. */
export function CompactRow({
  thread,
  tone,
  showProject = true,
  projectIconOnly = false,
  projectName,
  projectIconUrl,
  projectColor,
  label,
  isActive,
  isSplitOpen = false,
  isDragging = false,
  isRenaming,
  onRenamingChange,
  onOpen,
  rowProps,
  linkProps,
  beforeContent,
  fadeContent = false,
  trailing,
}: {
  thread: PluginSidebarThread;
  tone: "normal" | "muted";
  showProject?: boolean;
  projectIconOnly?: boolean;
  projectName: string | null;
  projectIconUrl: string;
  projectColor?: CSSProperties;
  label: string;
  isActive: boolean;
  isSplitOpen?: boolean;
  isDragging?: boolean;
  isRenaming: boolean;
  onRenamingChange: (editing: boolean) => void;
  /** Runs on a click that bb's link routing opens; it does not navigate. */
  onOpen: () => void;
  rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  linkProps?: Pick<
    ComponentProps<"a">,
    "draggable" | "aria-keyshortcuts" | "onPointerDown" | "onKeyDown" | "className"
  >;
  beforeContent?: ReactNode;
  fadeContent?: boolean;
  trailing: ReactNode;
}) {
  const muted = tone === "muted";
  return (
    <div
      {...rowProps}
      className={cn(
        muted
          ? "group/slim relative flex h-8 items-center gap-2 rounded-md px-2.5 text-xs transition-colors duration-150 ease-out motion-reduce:transition-none"
          : "group/card relative rounded-md px-2.5 transition-colors duration-150 ease-out motion-reduce:transition-none",
        !muted && "flex h-8 items-center gap-2 text-xs",
        isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
        !isActive && isSplitOpen && "bg-sidebar-accent/30",
        // Keep the lifted row opaque while other rows pass underneath it.
        isDragging &&
          "bg-[linear-gradient(var(--sidebar-accent),var(--sidebar-accent)),linear-gradient(var(--sidebar),var(--sidebar))] shadow-lg ring-1 ring-sidebar-border",
      )}
    >
      {beforeContent}
      {showProject && projectName ? <ProjectStripe projectId={thread.projectId} view="collapsed" /> : null}
      <ThreadDetailsTooltip thread={thread} disabled={isRenaming || isDragging} isOpen={isActive}>
        <a
          // Both attributes, or bb's nine thread shortcuts stop finding rows.
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          // bb routes a plain click in place and a Cmd/Ctrl-click to a split.
          href={thread.href}
          aria-label={label}
          aria-current={isActive ? "page" : undefined}
          {...linkProps}
          onClick={(event) => {
            if (isRenaming || event.detail > 1) {
              event.preventDefault();
              return;
            }
            onOpen();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRenamingChange(true);
          }}
          className={linkProps?.className ?? "absolute inset-0 cursor-pointer rounded-md"}
        />
      </ThreadDetailsTooltip>
      <span
        data-settle-fade={fadeContent ? "" : undefined}
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 items-center gap-1",
          isRenaming && "pointer-events-auto",
          muted && (isActive ? "text-foreground" : "text-muted-foreground/70"),
          muted && "group-hover/slim:text-foreground",
        )}
      >
        {showProject && projectName && !isRenaming ? (
          <>
            <ProjectFavicon projectId={thread.projectId} src={projectIconUrl} name={projectName} className="size-3" />
            <span
              style={projectColor}
              className={
                projectIconOnly
                  ? "sr-only"
                  : cn(
                      "max-w-[40%] shrink truncate",
                      projectColor
                        ? "bb-sidebar-project-name"
                        : !muted || isActive
                          ? "text-muted-foreground/70"
                          : "text-muted-foreground/50 group-hover/slim:text-muted-foreground/70",
                    )
              }
            >
              {projectName}
            </span>
            {!projectIconOnly ? (
              <span
                aria-hidden="true"
                className={cn(
                  "shrink-0 text-sm leading-none",
                  !muted || isActive
                    ? "text-muted-foreground/60"
                    : "text-muted-foreground/45 group-hover/slim:text-muted-foreground/60",
                )}
              >
                ·
              </span>
            ) : null}
          </>
        ) : null}
        <InlineThreadTitle
          thread={thread}
          editing={isRenaming}
          onEditingChange={onRenamingChange}
          className={
            muted
              ? cn(
                  "min-w-0 flex-1 truncate",
                  isActive ? "text-foreground" : "text-foreground/80 group-hover/slim:text-foreground",
                )
              : cn("min-w-0 flex-1 truncate text-foreground", thread.isUnread && "font-medium")
          }
        />
      </span>
      {trailing}
    </div>
  );
}
