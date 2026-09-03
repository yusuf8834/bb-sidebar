import type { ThreadLifecycleRow } from "../lifecycle";

export const MAX_CACHED_LIFECYCLE_ROWS = 500;
export const MAX_CHILD_EXPANSION = 100;

// Keys managed by this plugin — ordered least-critical first for eviction.
const PLUGIN_STORAGE_KEYS = [
  "bb-sidebar:lifecycle-cache:v1",
  "bb-sidebar:child-expansion:v1",
  "bb-sidebar:shelf-expansion:v1",
  "bb-sidebar:active-sort:v1",
  "bb-sidebar:settings-cache:v1",
] as const;

function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22
    );
  }
  if (error instanceof Error) {
    return error.name === "QuotaExceededError";
  }
  return false;
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) return false;

    // Free the least-critical plugin keys and retry once.
    for (const candidate of PLUGIN_STORAGE_KEYS) {
      if (candidate === key) continue;
      try {
        window.localStorage.removeItem(candidate);
      } catch {
        void 0;
      }
    }

    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      // Last resort: the value itself may still be too large. Clear the
      // target key so the origin quota is not left full for BB core.
      try {
        window.localStorage.removeItem(key);
      } catch {
        void 0;
      }
      return false;
    }
  }
}

function lifecycleRecency(row: ThreadLifecycleRow): number {
  let max = 0;
  if (typeof row.snoozedUntil === "number" && Number.isFinite(row.snoozedUntil)) {
    max = Math.max(max, row.snoozedUntil);
  }
  if (typeof row.settledAt === "number" && Number.isFinite(row.settledAt)) {
    max = Math.max(max, row.settledAt);
  }
  if (typeof row.snoozedAt === "number" && Number.isFinite(row.snoozedAt)) {
    max = Math.max(max, row.snoozedAt);
  }
  return max;
}

export function pruneLifecycleRows(
  rows: readonly ThreadLifecycleRow[],
): ThreadLifecycleRow[] {
  if (rows.length <= MAX_CACHED_LIFECYCLE_ROWS) return [...rows];
  return [...rows]
    .sort((a, b) => lifecycleRecency(b) - lifecycleRecency(a))
    .slice(0, MAX_CACHED_LIFECYCLE_ROWS);
}

export function pruneChildExpansion(ids: readonly string[]): string[] {
  if (ids.length <= MAX_CHILD_EXPANSION) return [...ids];
  // Keep most recently added (last N in insertion order).
  return [...ids].slice(-MAX_CHILD_EXPANSION);
}
