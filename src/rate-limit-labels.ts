import type { ThreadLimitState } from "./contract";

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
    return limit.retry.sendAt === null ? "Retrying" : `Retrying at ${limitTime(limit.retry.sendAt, limit.timeZone)}`;
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
