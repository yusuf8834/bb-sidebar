import {
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  type PluginSidebarThread,
  type PluginSidebarThreadIndicator,
  type PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import { StillThreadStatusGlyph } from "./StillThreadStatusGlyph";
import { useCallback, useMemo } from "react";
import { resolveThreadStatus } from "./bb-sdk";
import { isKnownIndicator, unhandledIndicator, type ThreadWorking } from "./child-status";
import { isThreadWorkingForDisplay } from "./working-tree";
import { cn } from "./lib/utils";
import { relativeTimeLabel } from "./relative-time";
import { useWorkingSinceContext } from "./useWorkingSince";
import { statusWithDuration } from "./working-since";
import { useThreadLimit } from "./RateLimits";
import { RateLimitRecovery } from "./RateLimitRecovery";

/**
 * The default trailing slot for cards and flat rows: fixed and right-aligned.
 *
 * Fixed rather than intrinsic because both ages and live-status labels vary in
 * width. The slot holds "Planning · 12m" without dragging the project column
 * back and forth as a thread changes state. Child trees override the width:
 * they carry no project column, so there the label's own width wins.
 */
export const STATUS_SLOT_CLASS = "flex w-20 shrink-0 items-center justify-end";

/**
 * The box every trailing glyph sits in, whatever its artwork measures.
 *
 * The status glyph, the provider glyph and a shelf's chevron all end a line at
 * the same inset, but they are drawn at different sizes. A shared box centres
 * each one on the same vertical axis, so right-aligning the boxes lines the
 * icons up instead of leaving them one or two pixels apart.
 */
export const TRAILING_GLYPH_BOX_CLASS = "flex size-3.5 shrink-0 items-center justify-center";

/**
 * Status OR age, never both: the glyph already implies the row is current, and
 * the age only earns its place once the thread has nothing to say.
 *
 * A live status carries how long the work has run ("Working · 5m"), so the
 * slot answers "is it stuck?" as well as "what is it doing?".
 */
export function StatusOrTime({
  thread: listedThread,
  now,
}: {
  thread: PluginSidebarThread;
  /** Quantized clock, shared by every row in one render. */
  now: number;
}) {
  const thread = useThreadWithDraft(listedThread);
  const workingSince = useWorkingSinceContext();
  const rowStatus = useThreadRowStatus(listedThread);
  const limit = useThreadLimit(listedThread);
  if (limit && !thread.hasPendingInteraction && thread.indicator !== "runtime") {
    return <RateLimitRecovery thread={listedThread} />;
  }
  if (rowStatus) {
    // bb's glyph for another plugin's status, in place of the label; the age stays.
    return (
      <span className="flex items-center gap-1">
        <StillThreadStatusGlyph indicator="none" rowStatus={rowStatus} size="compact" />
        <span className="tabular-nums text-2xs text-muted-foreground">{relativeTimeLabel(thread.updatedAt, now)}</span>
      </span>
    );
  }
  const status = threadShortStatus(thread);
  if (status === null && !isKnownIndicator(thread.indicator)) {
    // A kind bb added after this build: bb's glyph and label, then the age.
    return (
      <span className="flex items-center gap-1">
        <span
          role={thread.indicatorLabel ? "img" : undefined}
          aria-label={thread.indicatorLabel ?? undefined}
          className="inline-flex"
        >
          <StillThreadStatusGlyph indicator={thread.indicator} size="compact" />
        </span>
        <span className="tabular-nums text-2xs text-muted-foreground">{relativeTimeLabel(thread.updatedAt, now)}</span>
      </span>
    );
  }
  if (status !== null) {
    const label = shortStatusLabel(status, workingSince.get(thread.id), now);
    return (
      <span
        aria-label={status.ariaLabel ?? (thread.hasPendingInteraction ? label : (thread.indicatorLabel ?? label))}
        className={cn(
          "max-w-full truncate text-2xs font-medium",
          status.showsDuration && "tabular-nums",
          status.className,
        )}
      >
        {label}
      </span>
    );
  }
  return (
    <span className="tabular-nums text-2xs text-muted-foreground">{relativeTimeLabel(thread.updatedAt, now)}</span>
  );
}

/**
 * A status another plugin set on the row, such as a drafts or sandbox marker.
 * bb's resolver decides where it shows: in place of every status except live
 * work, a failure, or a raised hand. On top of that, the sidebar's provider
 * limit, a pending interaction, and its failed-send warning replace it too.
 */
export function useThreadRowStatus(thread: PluginSidebarThread): PluginSidebarThreadRowStatus | null {
  return threadRowStatus(thread, useSidebarThreadRowStatus(thread.id), useThreadLimit(thread) !== null);
}

export function threadRowStatus(
  thread: PluginSidebarThread,
  rowStatus: PluginSidebarThreadRowStatus | null,
  limited: boolean,
): PluginSidebarThreadRowStatus | null {
  if (!rowStatus || limited || thread.hasPendingInteraction || thread.queuedWork === "failed") return null;
  // Kept from before the sidebar used bb's resolver: the draft stays out, so
  // a working thread with a draft keeps "Drafting" where bb would show the
  // row status over its "working-draft" glyph.
  return resolveThreadStatus({ thread, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus }).rowStatus;
}

/**
 * Folds an unsent composer draft into the indicator with bb's resolver, as
 * bb's own row does. bb leaves drafts out of `indicator` because they are
 * per-client, so a busy thread with a draft becomes "working-draft" and an
 * otherwise quiet one "draft". A failure, a raised hand, an unread result or
 * a queued message keeps its own status.
 */
export function threadWithDraft(thread: PluginSidebarThread, hasUnsubmittedDraft: boolean): PluginSidebarThread {
  // A kind this build does not know keeps bb's own glyph, as before.
  if (!hasUnsubmittedDraft || !isKnownIndicator(thread.indicator)) return thread;
  const { indicator, label } = resolveThreadStatus({ thread, hiddenThreads: [], hasUnsubmittedDraft, rowStatus: null });
  // Kept from before the sidebar used bb's resolver: bb lets a draft on a
  // thread with a background agent or command replace an unread result or a
  // failed send; the sidebar keeps showing those.
  if (indicator === thread.indicator || thread.indicator === "unread-success" || thread.indicator === "queued-failed") {
    return thread;
  }
  return { ...thread, indicator, indicatorLabel: label };
}

/** The thread as its row should draw it, with this client's draft folded in. */
export function useThreadWithDraft(thread: PluginSidebarThread): PluginSidebarThread {
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  return useMemo(() => threadWithDraft(thread, hasUnsubmittedDraft), [thread, hasUnsubmittedDraft]);
}

/**
 * isThreadWorkingForDisplay with each thread's own row status, for lists and
 * rollups. One subscription to every row status.
 */
export function useWorkingForDisplay(): ThreadWorking {
  const rowStatuses = useSidebarThreadRowStatuses();
  return useCallback(
    (thread: PluginSidebarThread) => isThreadWorkingForDisplay(thread, rowStatuses.get(thread.id) ?? null),
    [rowStatuses],
  );
}

interface ShortStatus {
  label: string;
  className: string;
  /** Live work gets a running duration; a verdict or a request does not. */
  showsDuration: boolean;
  /** For statuses bb has no indicator for, so no accessible label either. */
  ariaLabel?: string;
}

function shortStatus(indicator: PluginSidebarThreadIndicator, indicatorLabel: string | null): ShortStatus | null {
  const className = statusToneClass(indicator);
  switch (indicator) {
    case "unread-error":
      return { label: "Failed", className, showsDuration: false };
    case "waiting-for-input":
      return { label: "Needs you", className, showsDuration: false };
    case "unread-success":
      return { label: "Unread", className, showsDuration: false };
    case "runtime":
      return {
        label: isMonitoringLabel(indicatorLabel) ? "Monitoring" : "Working",
        className,
        showsDuration: true,
      };
    case "workflow":
      return { label: "Workflow", className, showsDuration: true };
    case "background-agent":
      return { label: "Agent", className, showsDuration: true };
    case "background-command":
      return { label: "Command", className, showsDuration: true };
    case "plan-mode":
      return { label: "Planning", className, showsDuration: true };
    case "draft":
      return { label: "Draft", className, showsDuration: false };
    case "working-draft":
      return { label: "Drafting", className, showsDuration: true };
    case "queued-failed":
    case "queued-waiting":
      // Worded from `queuedWork` in threadShortStatus, which also covers a
      // queued send bb ranks below another indicator.
      return null;
    case "none":
      return null;
    default:
      // A kind bb added after this build; StatusOrTime draws bb's glyph for it.
      unhandledIndicator(indicator);
      return null;
  }
}

/**
 * A pending user interaction outranks any concurrently reported runtime, and a
 * message that failed to send outranks the rest. bb ranks its queued
 * indicators below live work, and a waiting message below an unread result
 * too, so this reads `queuedWork` itself rather than wait for the indicator;
 * a row would otherwise look idle or merely busy. A waiting message only
 * shows on an otherwise quiet row; a running turn already says more.
 */
export function threadShortStatus(thread: PluginSidebarThread): ShortStatus | null {
  if (thread.hasPendingInteraction) {
    return shortStatus("waiting-for-input", null);
  }
  if (thread.queuedWork === "failed") {
    return {
      label: "Send failed",
      className: statusToneClass("unread-error"),
      showsDuration: false,
      ariaLabel: "A queued message failed to send",
    };
  }
  const status = shortStatus(thread.indicator, thread.indicatorLabel);
  if (status === null && thread.queuedWork === "waiting") {
    return {
      label: "Queued",
      className: statusToneClass("draft"),
      showsDuration: false,
      ariaLabel: "A message is waiting to send",
    };
  }
  return status;
}

export function shortStatusLabel(status: ShortStatus, startedAt: number | undefined, now: number): string {
  return status.showsDuration ? statusWithDuration(status.label, startedAt, now) : status.label;
}

export function threadStatusLabel(
  thread: PluginSidebarThread,
  startedAt: number | undefined,
  now: number,
): string | null {
  const status = threadShortStatus(thread);
  return status === null ? null : shortStatusLabel(status, startedAt, now);
}

/**
 * A monitor is still a runtime, so the indicator keeps the usual spinner and
 * working duration. BB's accessible label carries the more precise state.
 */
function isMonitoringLabel(label: string | null): boolean {
  return label?.toLocaleLowerCase().includes("monitoring") ?? false;
}

/** Status palette shared by cards, child labels, and glyphs. */
export function statusToneClass(indicator: PluginSidebarThreadIndicator): string {
  switch (indicator) {
    case "unread-error":
      return "text-[color:var(--bb-sidebar-tone-error)]";
    case "waiting-for-input":
      return "text-[color:var(--bb-sidebar-tone-pending)]";
    case "unread-success":
      return "text-[color:var(--bb-sidebar-tone-success)]";
    case "runtime":
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
      return "text-[color:var(--bb-sidebar-tone-working)]";
    case "draft":
    case "working-draft":
    case "queued-waiting":
      return "text-[color:var(--bb-sidebar-tone-draft)]";
    case "queued-failed":
      return "text-[color:var(--bb-sidebar-tone-error)]";
    case "none":
      return "text-muted-foreground";
    default:
      unhandledIndicator(indicator);
      return "text-muted-foreground";
  }
}
