import { createContext, useContext, useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Disc } from "./Disc";
import { ProviderGlyph, type SidebarProvider } from "./ProviderGlyph";
import {
  childThreadSortOf,
  DEFAULT_SIDEBAR_SETTINGS,
  type ChildThreadIconStyle,
  type ChildThreadSort,
  type SidebarSettingsValues,
} from "./sidebar-settings";

/**
 * How child threads are drawn and ordered wherever they appear: the sidebar
 * list, the parent's badge, and hover cards.
 */
export interface ChildThreadDisplay {
  iconStyle: ChildThreadIconStyle;
  providerById: ReadonlyMap<string, SidebarProvider>;
  sort: ChildThreadSort;
}

export const ChildThreadDisplayContext = createContext<ChildThreadDisplay>({
  iconStyle: DEFAULT_SIDEBAR_SETTINGS.childIconStyle,
  providerById: new Map(),
  sort: childThreadSortOf(null),
});

export function useChildThreadDisplay(): ChildThreadDisplay {
  return useContext(ChildThreadDisplayContext);
}

/** The context value for one surface, stable while its inputs are. */
export function useChildThreadDisplayValue(
  settings: SidebarSettingsValues | null,
  providerById: ReadonlyMap<string, SidebarProvider>,
): ChildThreadDisplay {
  const iconStyle = settings?.childIconStyle ?? DEFAULT_SIDEBAR_SETTINGS.childIconStyle;
  const { field, direction } = childThreadSortOf(settings);
  // Kept apart so a provider refresh does not re-sort every child list.
  const sort = useMemo(() => ({ field, direction }), [field, direction]);
  return useMemo(() => ({ iconStyle, providerById, sort }), [iconStyle, providerById, sort]);
}

export function compareChildThreads(
  sort: ChildThreadSort,
): (left: PluginSidebarThread, right: PluginSidebarThread) => number {
  const key = sort.field === "activity" ? "updatedAt" : "createdAt";
  const sign = sort.direction === "descending" ? -1 : 1;
  return (left, right) =>
    sign * (left[key] - right[key] || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/**
 * The mark before a child thread: its colour disc, or the agent it runs on
 * when the user prefers to tell children apart by provider.
 */
export function ChildThreadIcon({ thread, discClassName }: { thread: PluginSidebarThread; discClassName?: string }) {
  const { iconStyle, providerById } = useChildThreadDisplay();
  if (iconStyle === "provider") {
    return <ProviderGlyph providerId={thread.providerId} provider={providerById.get(thread.providerId) ?? null} />;
  }
  return <Disc thread={thread} className={discClassName} />;
}
