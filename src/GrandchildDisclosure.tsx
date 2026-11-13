import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";
import { StatusGlyph } from "./StatusGlyph";
import { useWorkingForDisplay } from "./StatusSlot";
import {
  childStatusIndicator,
  childStatusPhrase,
  childStatusSummary,
  childSubtree,
  type ChildStatusKind,
} from "./child-status";

/**
 * The badge tint for the subtree's most urgent state. Needs-you keeps the
 * amber the rest of the sidebar uses for a raised hand in a child row; the
 * others borrow the status glyph tones so the card and the child rows agree.
 */
export function childStatusBadgeClass(kind: ChildStatusKind | null): string {
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

export interface GrandchildDisclosure {
  /** The row's own children, archived ones already dropped. */
  descendants: readonly PluginSidebarThread[];
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  relation: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}

/**
 * A child row's capsule for its own children. Like the parent card's badge,
 * it rolls up the whole subtree under the row, so a question two levels down
 * still tints the row that hides it.
 */
export function GrandchildDisclosureButton({
  title,
  descendants,
  childrenByParent,
  relation,
  expanded,
  controls,
  onToggle,
}: GrandchildDisclosure & { title: string }) {
  const count = descendants.length;
  const isWorking = useWorkingForDisplay();
  const summary = childStatusSummary(childSubtree(descendants, childrenByParent), isWorking);
  const noun = `${relation} thread${count === 1 ? "" : "s"}`;
  const phrase = childStatusPhrase(summary);
  const label = `${expanded ? "Hide" : "Show"} ${count} ${noun} for ${title}${phrase}`;

  return (
    <Tooltip label={`${count} ${noun}${phrase}`} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={controls}
        data-child-status={summary.dominant ?? undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        className="group mr-1 flex h-6 min-w-9 shrink-0 items-center justify-center rounded-full bg-transparent px-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "inline-flex h-4.5 min-w-8 items-center justify-center gap-0.5 rounded-full px-1",
            summary.dominant
              ? childStatusBadgeClass(summary.dominant)
              : "bg-muted text-muted-foreground group-hover:bg-accent group-hover:text-foreground group-focus-visible:bg-accent group-focus-visible:text-foreground",
          )}
        >
          <span className="min-w-2.5 text-center font-sans text-2xs font-medium tabular-nums">{count}</span>
          {summary.dominant ? (
            <StatusGlyph
              indicator={childStatusIndicator(summary.dominant)}
              label={null}
              className="size-3 text-current"
            />
          ) : null}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
        </span>
      </button>
    </Tooltip>
  );
}
