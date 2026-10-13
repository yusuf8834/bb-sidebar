import type { PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { relativeTimeLabel } from "./relative-time";
import { shortStatusLabel, statusToneClass, threadShortStatus, useThreadWithDraft } from "./StatusSlot";
import { useWorkingSinceContext } from "./useWorkingSince";

/**
 * This plugin's status glyphs, matching bb's own sidebar shape for shape: the
 * red circle-x for a failure, the circle-question for a raised hand, the
 * spinner for live work, and a dot for a finished thread you have not read.
 *
 * The SDK ships `indicator` as data and no status component on purpose, so a
 * replaced sidebar can choose its own look. This one deliberately does not:
 * the two lists sit in the same window, and a user who switches between them
 * should not have to learn a second vocabulary.
 *
 * An unrecognized indicator draws nothing: bb adds kinds over time, and a
 * plugin built today must not break on a kind shipped tomorrow.
 */

export function StatusGlyph({
  indicator,
  label,
  className,
}: {
  indicator: PluginSidebarThreadIndicator;
  label: string | null;
  className?: string;
}) {
  const shared = cn("size-3.5 shrink-0", className);
  const aria = label ?? undefined;

  switch (indicator) {
    case "unread-error":
      return <Icon name="CircleX" aria-label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "waiting-for-input":
      return <Icon name="CircleQuestion" aria-label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "runtime":
      return (
        <Icon
          name="Loading"
          aria-label={aria}
          className={cn(shared, "animate-spin opacity-75", statusToneClass(indicator))}
        />
      );
    case "workflow":
      return <ShineIcon name="Workflow" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "background-agent":
      return <ShineIcon name="UserRoundPlus" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "background-command":
      return <ShineIcon name="Terminal" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "plan-mode":
      return <ShineIcon name="ListTodo" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "goal":
      return <ShineIcon name="Target" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "draft":
    case "working-draft":
      return <Icon name="Edit" aria-label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "unread-success":
      // The notification dot, in a box the size of every other glyph, the way
      // bb centers its own trailing indicators. Right-aligned on its own, a
      // 5px dot would sit ~4px off the column the icons share.
      return (
        <span aria-label={aria} className={cn("flex items-center justify-center", shared, statusToneClass(indicator))}>
          <span className="size-[5px] rounded-full bg-current" />
        </span>
      );
    case "none":
      return null;
    default:
      return null;
  }
}

function ShineIcon({
  name,
  label,
  className,
}: {
  name: "Workflow" | "UserRoundPlus" | "Terminal" | "ListTodo" | "Target";
  label: string | undefined;
  className: string;
}) {
  return <Icon name={name} aria-label={label} className={cn("animate-shine-icon opacity-75", className)} />;
}

/**
 * The live-status glyph and how long the work has run ("◌ 5m"), for rows too
 * narrow for the card's "Working · 5m". The full label stays readable to
 * assistive tech; the duration is left off under a minute, as on the card.
 */
export function CompactLiveStatus({
  thread: listedThread,
  now,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
}) {
  const thread = useThreadWithDraft(listedThread);
  const workingSince = useWorkingSinceContext();
  const status = threadShortStatus(thread);
  if (status === null) return null;
  const startedAt = workingSince.get(thread.id);
  const elapsed = startedAt === undefined ? "now" : relativeTimeLabel(startedAt, now);
  return (
    <span className={cn("flex shrink-0 items-center gap-1 tabular-nums text-2xs font-medium", status.className)}>
      <span aria-hidden="true" className="flex items-center">
        <StatusGlyph indicator={thread.indicator} label={null} className="size-3" />
      </span>
      {elapsed === "now" ? null : <span aria-hidden="true">{elapsed}</span>}
      <span className="sr-only">{shortStatusLabel(status, startedAt, now)}</span>
    </span>
  );
}
