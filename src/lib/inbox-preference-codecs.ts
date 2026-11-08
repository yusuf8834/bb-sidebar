import { isActiveSortMode } from "../inbox-layout";
import type { ActiveSortMode } from "../inbox-layout";
import type { ShelfExpansionState } from "../ThreadInboxView";
import { MAX_CHILD_EXPANSION, pruneChildExpansion } from "./safe-storage";
import { readStorageRaw } from "./storage-codec";
import { STORAGE_KEYS } from "./storage-keys";
import type { PreferenceCodec } from "./use-persisted-preference";

export const projectScopeCodec: PreferenceCodec<string[]> = {
  storage: "session",
  fallback: () => [],
  decode: (stored) => {
    const value: unknown = JSON.parse(stored ?? "null");
    return Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim().length > 0)
      ? [...new Set(value)]
      : null;
  },
  encode: JSON.stringify,
};

export const pinnedProjectsCodec: PreferenceCodec<string[]> = {
  ...projectScopeCodec,
  storage: "local",
};

export const projectOrderCodec: PreferenceCodec<string[]> = {
  ...projectScopeCodec,
  storage: "local",
};

export const environmentGroupingCodec: PreferenceCodec<boolean> = {
  fallback: () => false,
  decode: (stored) => (stored === "true" ? true : stored === "false" ? false : null),
  encode: String,
};

export const singleThreadProjectGroupingCodec: PreferenceCodec<boolean> = {
  ...environmentGroupingCodec,
  fallback: () => true,
};

export const projectCollapseCodec: PreferenceCodec<Set<string>> = {
  fallback: () => new Set(),
  decode: (stored) => {
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : null;
  },
  encode: (value) => JSON.stringify([...value]),
};

export const childExpansionCodec: PreferenceCodec<Set<string>> = {
  ...projectCollapseCodec,
  decode: (stored) => {
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((value): value is string => typeof value === "string");
    // Trim before deduplication, matching the older stored-array reader.
    return new Set(ids.length > MAX_CHILD_EXPANSION ? ids.slice(-MAX_CHILD_EXPANSION) : ids);
  },
  prune: (value) => new Set(pruneChildExpansion([...value])),
};

const DEFAULT_SHELF_EXPANSION: ShelfExpansionState = {
  active: true,
  pinned: true,
  working: true,
  inactive: false,
  parked: false,
  snoozed: false,
  settled: false,
};
export const shelfExpansionCodec: PreferenceCodec<ShelfExpansionState> = {
  fallback: () => DEFAULT_SHELF_EXPANSION,
  decode: (stored) => {
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<ShelfExpansionState>;
    return {
      // Older shapes did not include independently collapsible Active or Pinned.
      active: parsed.active !== false,
      pinned: parsed.pinned !== false,
      working: parsed.working !== false,
      inactive: parsed.inactive === true,
      parked: parsed.parked === true,
      snoozed: parsed.snoozed === true,
      settled: parsed.settled === true,
    };
  },
  encode: JSON.stringify,
};

export const activeSortCodec: PreferenceCodec<ActiveSortMode> = {
  fallback: () => "manual",
  decode: (stored) => {
    if (stored && isActiveSortMode(stored)) return stored;
    // Read-only migration from the fifth inbox preference. Never write this key.
    return readStorageRaw(STORAGE_KEYS.activeGrouping.key) === "true" ? "project" : "manual";
  },
  encode: (value) => value,
};
