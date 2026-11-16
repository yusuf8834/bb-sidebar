import type { StorageCodec } from "./storage-codec";
import {
  childThreadSettingsOf,
  DEFAULT_SIDEBAR_SETTINGS,
  projectColorDisplayOf,
  threadDisplayOf,
  type SidebarSettingsValues,
} from "../sidebar-settings-values";

// Old previews may have cached removed settings. Never forward unknown keys
// from storage (or an older server response) to the strict settings RPC.
export function currentSettingsOnly(value: SidebarSettingsValues): SidebarSettingsValues {
  return Object.fromEntries(
    Object.keys(DEFAULT_SIDEBAR_SETTINGS).map((key) => [
      key,
      value[key as keyof SidebarSettingsValues] ?? DEFAULT_SIDEBAR_SETTINGS[key as keyof SidebarSettingsValues],
    ]),
  ) as unknown as SidebarSettingsValues;
}

export function decodeSettingsCache(input: unknown): SidebarSettingsValues | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Partial<SidebarSettingsValues>;
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
  return currentSettingsOnly({
    ...value,
    ...childThreadSettingsOf(value),
    threadDisplay: threadDisplayOf(value),
    compactProjectIconOnly: value.compactProjectIconOnly === true,
    keepPinnedThreadsFull: value.keepPinnedThreadsFull === true,
    keepWokeThreadsFull: value.keepWokeThreadsFull === true,
    // On by default, so a cache from before the setting keeps it on.
    showSideChatsAsChildren: value.showSideChatsAsChildren !== false,
    compactWorkingThreads: threadDisplayOf(value) !== "full",
    workingShelf: value.workingShelf === true,
    dockShelves: value.dockShelves === true,
    projectColorsEnabled: value.projectColorsEnabled === true,
    projectColorDisplay: projectColorDisplayOf(value.projectColorDisplay),
  } as SidebarSettingsValues);
}

export const settingsCacheCodec: StorageCodec<SidebarSettingsValues> = {
  decode: (stored) => (stored ? decodeSettingsCache(JSON.parse(stored)) : null),
  encode: JSON.stringify,
};
