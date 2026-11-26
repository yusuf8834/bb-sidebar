import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { ThreadLimitState } from "./contract";

type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

const zonedTimestamp = z.iso.datetime({ offset: true });

function reportedReset(message: string, createdAt: number) {
  // Match the recovery instruction so timestamps elsewhere in an error cannot schedule a Continue.
  const timestamps = message.matchAll(/\b(?:available|resets?|retry|try again)\s+at\s+(\d[\w:.+-]*)/gi);
  for (const [, token] of timestamps) {
    const timestamp = zonedTimestamp.safeParse(token!.replace(/\.$/, "").toUpperCase());
    if (timestamp.success) return Date.parse(timestamp.data);
  }

  const delay = /\b(?:available|resets?|retry|try again)(?:\s+at\s+\S+\s+\(|\s+)in\s+(\d+)\s+seconds?\b/i.exec(message);
  if (!delay) return null;
  const at = createdAt + Number(delay[1]) * 1000;
  return Number.isFinite(new Date(at).getTime()) ? at : null;
}

function localDateReset(message: string, timeZone: string | null) {
  const match = /try again at ([a-z]{3}) (\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i.exec(
    message,
  );
  if (!match || !timeZone) return { resetsAt: null, timeZone: null };
  const [, monthText, dayText, yearText, hourText, minuteText, period] = match;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
    monthText!.toLowerCase(),
  );
  const year = Number(yearText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = Date.UTC(year, month, day);
  if (month < 0 || new Date(date).getUTCMonth() !== month || day < 1 || hour < 1 || hour > 12 || minute > 59)
    return { resetsAt: null, timeZone: null };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(date);
    const hours = (hour % 12) + (period!.toLowerCase() === "pm" ? 12 : 0);
    const resetsAt = CronExpressionParser.parse(`${minute} ${hours} ${day} ${month + 1} *`, {
      currentDate: date - 2 * 86_400_000,
      tz: timeZone,
    })
      .next()
      .getTime();
    return { resetsAt, timeZone };
  } catch {
    return { resetsAt: null, timeZone: null };
  }
}

function messageReset(message: string, createdAt: number, hostTimeZone: string | null) {
  const reported = reportedReset(message, createdAt);
  if (reported !== null) return { resetsAt: reported, timeZone: null };
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (!match) return localDateReset(message, hostTimeZone);
  const [, hourText, minuteText, period, timeZone] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return { resetsAt: null, timeZone: null };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(createdAt);
    const hours = (hour % 12) + (period!.toLowerCase() === "pm" ? 12 : 0);
    const resetsAt = CronExpressionParser.parse(`${minute} ${hours} * * *`, {
      currentDate: createdAt,
      tz: timeZone,
    })
      .next()
      .getTime();
    return { resetsAt, timeZone: timeZone! };
  } catch {
    return { resetsAt: null, timeZone: null };
  }
}

/** Only the latest failed turn can supply a limit, even after its unread flag clears. */
export function rateLimitDetails(
  events: readonly Event[],
  hostTimeZone: string | null = null,
): ThreadLimitState | null {
  const rows = [...events].sort((a, b) => b.seq - a.seq);
  let failure: Extract<Event, { type: "provider/error" | "system/error" }> | undefined;
  let limits: Extract<Event, { type: "provider/rateLimits/updated" }> | undefined;
  for (const row of rows) {
    if (row.type === "turn/started") break;
    if (row.type === "turn/completed" && row.data.status !== "failed") break;
    if (row.type === "provider/rateLimits/updated" && !limits) limits = row;
    if (row.type === "provider/error" || row.type === "system/error") {
      if (row.type === "provider/error" && row.data.willRetry) continue;
      if (!failure || (failure.type === "system/error" && row.type === "provider/error")) failure = row;
    }
  }
  if (!failure) return null;
  const message = [failure.data.message, failure.type === "provider/error" ? failure.data.detail : null]
    .filter(Boolean)
    .join(": ");
  const category = failure.type === "provider/error" ? failure.data.errorInfo?.category : undefined;
  const isLimit =
    category === "rate-limit" ||
    category === "budget-exceeded" ||
    ((!category || category === "unknown" || category === "internal") &&
      /rate[_ -]?limit|(?:session|usage) limit|usage cap|no account pooler account is currently eligible/i.test(
        message,
      ));
  if (!isLimit) return null;
  const reset = messageReset(message, failure.createdAt, hostTimeZone);
  const blocked = limits?.data.rateLimits.windows.filter((window) => window.status === "blocked") ?? [];
  if (blocked.length > 0 && blocked.every((window) => window.resetsAtMs !== null)) {
    reset.resetsAt = Math.max(...blocked.map((window) => window.resetsAtMs!));
  }
  return { message, ...reset, scheduled: null, retry: null };
}
