import type { QueuedRetry, ThreadLimitState, ThreadRecoveryState } from "./contract";

/** The provider limit in a lookup's answer; null when bb only queued a retry of another failure. */
export function limitOf(state: ThreadRecoveryState | null | undefined): ThreadLimitState | null {
  return state && "message" in state ? state : null;
}

export function limitTime(at: number, timeZone: string | null) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  })
    .format(at)
    .replace(":00", "")
    .replace(/\s/g, "")
    .toLowerCase();
}

export function limitStatus(limit: ThreadLimitState) {
  // bb's queued retry resends the failed turn, so it leads even when the sidebar's own Continue is also queued.
  if (limit.retry) {
    if (limit.retry.failed) return "Retry failed";
    return retryLabel(limit.retry, limit.timeZone);
  }
  if (!limit.scheduled) return "Limit reached";
  if (limit.scheduled.failed) return "Schedule failed";
  return `Scheduled · ${limitTime(limit.scheduled.sendAt, limit.timeZone)}`;
}

export function limitDescription(limit: ThreadLimitState) {
  const [label, at] =
    limit.retry?.sendAt != null
      ? ["bb retries at", limit.retry.sendAt]
      : limit.scheduled
        ? ["Continue scheduled for", limit.scheduled.sendAt]
        : ["Resets", limit.resetsAt];
  const date =
    at === null
      ? null
      : new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          ...(limit.timeZone ? { timeZone: limit.timeZone } : {}),
        }).format(at);
  return [limit.message, date ? `${label} ${date}` : null, limit.timeZone].filter(Boolean).join(" · ");
}

/** bb's queued retry, worded the same with or without a provider limit: "Retrying at 11:30am". */
export function retryLabel(retry: QueuedRetry, timeZone: string | null) {
  return retry.sendAt === null ? "Retrying" : `Retrying at ${limitTime(retry.sendAt, timeZone)}`;
}
