export const SIDEBAR_SETTINGS_CHANNEL = "sidebar-settings";

export const CHILD_THREAD_SORT_FIELDS = ["created", "activity"] as const;
export type ChildThreadSortField = (typeof CHILD_THREAD_SORT_FIELDS)[number];
export const CHILD_THREAD_SORT_DIRECTIONS = ["ascending", "descending"] as const;
export type ChildThreadSortDirection =
  (typeof CHILD_THREAD_SORT_DIRECTIONS)[number];

export const CHILD_THREAD_ICON_STYLES = ["disc", "provider"] as const;
export type ChildThreadIconStyle = (typeof CHILD_THREAD_ICON_STYLES)[number];

export const PROJECT_COLOR_DISPLAYS = ["all", "full", "grouped"] as const;
export type ProjectColorDisplay = (typeof PROJECT_COLOR_DISPLAYS)[number];

export interface ChildThreadSort {
  field: ChildThreadSortField;
  direction: ChildThreadSortDirection;
}

export interface SidebarSettingsValues {
  snoozePresets: string;
  inactiveThreadsEnabled: boolean;
  inactiveAfterHours: number;
  showRunningChildrenWhenCollapsed: boolean;
  autoSettleInactive: boolean;
  autoSettleAfterDays: number;
  autoSettleOnMerge: boolean;
  childSortField: ChildThreadSortField;
  childSortDirection: ChildThreadSortDirection;
  childIconStyle: ChildThreadIconStyle;
  /** Experimental: fold threads with live work to one line. */
  compactWorkingThreads: boolean;
  /** Experimental: move threads with live work to their own shelf. */
  workingShelf: boolean;
  /** Experimental: keep the shelves below Active docked to the bottom. */
  dockShelves: boolean;
  projectColorsEnabled: boolean;
  projectColorDisplay: ProjectColorDisplay;
  archivedShelfEnabled: boolean;
}

import { safeSetItem } from "./lib/safe-storage";
import { DEFAULT_SNOOZE_PRESET_CONFIG } from "./lifecycle";

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettingsValues = {
  snoozePresets: DEFAULT_SNOOZE_PRESET_CONFIG,
  inactiveThreadsEnabled: true,
  inactiveAfterHours: 6,
  showRunningChildrenWhenCollapsed: true,
  autoSettleInactive: true,
  autoSettleAfterDays: 3,
  autoSettleOnMerge: true,
  childSortField: "created",
  childSortDirection: "ascending",
  childIconStyle: "disc",
  compactWorkingThreads: false,
  workingShelf: false,
  dockShelves: false,
  projectColorsEnabled: false,
  projectColorDisplay: "all",
  archivedShelfEnabled: false,
};

export function childThreadSortOf(
  settings: SidebarSettingsValues | null,
): ChildThreadSort {
  return {
    field: settings?.childSortField ?? DEFAULT_SIDEBAR_SETTINGS.childSortField,
    direction:
      settings?.childSortDirection ??
      DEFAULT_SIDEBAR_SETTINGS.childSortDirection,
  };
}

type ChildThreadSettings = Pick<
  SidebarSettingsValues,
  "childSortField" | "childSortDirection" | "childIconStyle"
>;

function oneOf<const T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function projectColorDisplayOf(value: unknown): ProjectColorDisplay {
  return oneOf(PROJECT_COLOR_DISPLAYS, value, DEFAULT_SIDEBAR_SETTINGS.projectColorDisplay);
}

/**
 * The child-thread settings from an untrusted record, such as a database row
 * or a cache written by an older version. Missing or unknown values fall back
 * to the defaults.
 */
export function childThreadSettingsOf(value: {
  [Key in keyof ChildThreadSettings]?: unknown;
}): ChildThreadSettings {
  return {
    childSortField: oneOf(
      CHILD_THREAD_SORT_FIELDS,
      value.childSortField,
      DEFAULT_SIDEBAR_SETTINGS.childSortField,
    ),
    childSortDirection: oneOf(
      CHILD_THREAD_SORT_DIRECTIONS,
      value.childSortDirection,
      DEFAULT_SIDEBAR_SETTINGS.childSortDirection,
    ),
    childIconStyle: oneOf(
      CHILD_THREAD_ICON_STYLES,
      value.childIconStyle,
      DEFAULT_SIDEBAR_SETTINGS.childIconStyle,
    ),
  };
}

const SIDEBAR_SETTINGS_CACHE_KEY = "bb-sidebar:settings-cache:v1";
const settingsByRpcClient = new WeakMap<object, SidebarSettingsValues>();

function readStoredSidebarSettings(): SidebarSettingsValues | null {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_SETTINGS_CACHE_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<SidebarSettingsValues>;
    if (
      typeof value.snoozePresets !== "string" ||
      typeof value.inactiveThreadsEnabled !== "boolean" ||
      typeof value.inactiveAfterHours !== "number" ||
      typeof value.showRunningChildrenWhenCollapsed !== "boolean" ||
      typeof value.autoSettleInactive !== "boolean" ||
      typeof value.autoSettleAfterDays !== "number" ||
      typeof value.autoSettleOnMerge !== "boolean"
    ) {
      return null;
    }
    // A cache written before the child-thread settings existed lacks them.
    // It is still good for everything else, so fill the gaps with defaults
    // instead of dropping it and flashing the old settings until the load.
    return {
      ...value,
      ...childThreadSettingsOf(value),
      compactWorkingThreads: value.compactWorkingThreads === true,
      workingShelf: value.workingShelf === true,
      dockShelves: value.dockShelves === true,
      projectColorsEnabled: value.projectColorsEnabled === true,
      projectColorDisplay: projectColorDisplayOf(value.projectColorDisplay),
      archivedShelfEnabled: value.archivedShelfEnabled === true,
    } as SidebarSettingsValues;
  } catch {
    return null;
  }
}

export function cachedSidebarSettings(
  rpcClient: object,
): SidebarSettingsValues | null {
  const cached = settingsByRpcClient.get(rpcClient);
  if (cached) return cached;
  const stored = readStoredSidebarSettings();
  if (stored) settingsByRpcClient.set(rpcClient, stored);
  return stored;
}

export function cacheSidebarSettings(
  rpcClient: object,
  values: SidebarSettingsValues,
): SidebarSettingsValues {
  settingsByRpcClient.set(rpcClient, values);
  safeSetItem(SIDEBAR_SETTINGS_CACHE_KEY, JSON.stringify(values));
  return values;
}
