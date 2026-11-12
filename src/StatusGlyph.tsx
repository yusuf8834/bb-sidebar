import type { PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk";
import type { AnimationEvent } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { unhandledIndicator } from "./child-status";
import { StillThreadStatusGlyph } from "./StillThreadStatusGlyph";
import { cn } from "./lib/utils";
import { relativeTimeLabel } from "./relative-time";
import { shortStatusLabel, statusToneClass, StatusOrTime, threadShortStatus, useThreadWithDraft } from "./StatusSlot";
import { useWorkingSinceContext } from "./useWorkingSince";
import { useThreadLimit } from "./RateLimits";
import "./working-pulse.css";

/**
 * This plugin's status glyphs, matching bb's own sidebar shape for shape: the
 * red circle-x for a failure, the circle-question for a raised hand, and a dot
 * for a finished thread you have not read.
 *
 * The SDK ships `indicator` as data and no status component on purpose, so a
 * replaced sidebar can choose its own look. This one deliberately does not:
 * the two lists sit in the same window, and a user who switches between them
 * should not have to learn a second vocabulary.
 *
 * Live work is where this list departs from bb, on purpose. bb spins a
 * spinner and shines the activity glyphs forever. In Chromium any running
 * animation redraws the window at the display's refresh rate, and on a 120 Hz
 * Mac that kept bb's renderer, GPU process and WindowServer near a full core
 * for as long as a thread worked, however small the glyph. A slower spin or a
 * stepped one still cost a third of that, and a spinner held still reads as
 * frozen. So live work gets a pulse in a box, which says "running" without
 * promising motion, in the enclosed style of the circle-x and the
 * circle-question; the bare pulse stays the Active shelf's. It breathes the way
 * T3 Code's status dot does, mostly holding still (see working-pulse.css),
 * which costs a few points of a core instead of a full one. The activity
 * glyphs keep their shapes and hold still. The working tone and
 * "Working · 5m" carry the rest, and a spinner never said whether an agent was
 * alive anyway. See get-bb/bb#7233.
 *
 * An indicator this sidebar has no shape for, such as a kind bb ships after
 * this build, is drawn with bb's own glyph, held still: bb adds kinds over
 * time, and users must not lose a status bb would show them.
 */

/**
 * Pin a working pulse to the start of the document timeline, so every working
 * glyph, however late it mounted, is at the same point of the cycle and they
 * all change in the same frames.
 */
export function syncWorkingPulse(event: AnimationEvent<HTMLElement>) {
  if (event.animationName !== "bb-sidebar-working-pulse") return;
  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "bb-sidebar-working-pulse") {
      animation.startTime = 0;
    }
  }
}

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
        <span className="bb-sidebar-working-pulse inline-flex shrink-0" onAnimationStart={syncWorkingPulse}>
          <Icon name="Working" aria-label={aria} className={cn(shared, statusToneClass(indicator))} />
        </span>
      );
    case "workflow":
      return <ActivityIcon name="Workflow" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "background-agent":
      return <ActivityIcon name="UserRoundPlus" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "background-command":
      return <ActivityIcon name="Terminal" label={aria} className={cn(shared, statusToneClass(indicator))} />;
    case "plan-mode":
      return <ActivityIcon name="ListTodo" label={aria} className={cn(shared, statusToneClass(indicator))} />;
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
    case "queued-failed":
    case "queued-waiting":
      // bb's own glyphs: the sidebar has no shape of its own for a queued send.
      return <HostIndicatorGlyph indicator={indicator} label={aria} className={shared} />;
    case "none":
      return null;
    default:
      return <HostIndicatorGlyph indicator={unhandledIndicator(indicator)} label={aria} className={shared} />;
  }
}

/**
 * bb's glyph for an indicator this sidebar does not draw itself, held still
 * like every other glyph here and sized to the same box.
 */
function HostIndicatorGlyph({
  indicator,
  label,
  className,
}: {
  indicator: PluginSidebarThreadIndicator;
  label: string | undefined;
  className: string;
}) {
  return (
    <span
      aria-label={label}
      role={label ? "img" : undefined}
      className={cn("inline-flex items-center justify-center [&_svg]:size-full", className)}
    >
      <StillThreadStatusGlyph indicator={indicator} size="compact" />
    </span>
  );
}

function ActivityIcon({
  name,
  label,
  className,
}: {
  name: "Workflow" | "UserRoundPlus" | "Terminal" | "ListTodo";
  label: string | undefined;
  className: string;
}) {
  return <Icon name={name} aria-label={label} className={cn("opacity-75", className)} />;
}

/**
 * The live-status glyph and how long the work has run ("◌ 5m"), for rows too
 * narrow for the card's "Working · 5m". The full label stays readable to
 * assistive tech; the duration is left off under a minute, as on the card.
 * Threads with no live status show their usual status or age, including
 * parents whose children are still running.
 */
export function CompactStatusOrTime({
  thread: listedThread,
  now,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
}) {
  const thread = useThreadWithDraft(listedThread);
  const workingSince = useWorkingSinceContext();
  const limit = useThreadLimit(listedThread);
  const status = threadShortStatus(thread);
  if (limit || status === null || !status.showsDuration) return <StatusOrTime thread={listedThread} now={now} />;
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
