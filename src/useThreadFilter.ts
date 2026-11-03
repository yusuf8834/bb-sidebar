import { useCallback } from "react";
import { recentFiltersCodec, threadFilterCodec } from "./lib/inbox-preference-codecs";
import { rememberRecent } from "./thread-filter";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";

/** The filter bar's machines, states, shelves, and keyword; projects live in the project scope. */
export function useThreadFilter() {
  return usePersistedPreference(STORAGE_KEYS.threadFilter.key, threadFilterCodec);
}

/** Recently used filter suggestions on this device, and a way to add one. */
export function useRecentFilters() {
  const [recents, setRecents] = usePersistedPreference(STORAGE_KEYS.recentFilters.key, recentFiltersCodec);
  const remember = useCallback((key: string) => setRecents((current) => rememberRecent(current, key)), [setRecents]);
  return [recents, remember] as const;
}
