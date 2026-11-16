import { useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useSidebarRead } from "./bb-sdk";
import { withSideChats } from "./side-chats";
import type { SidebarSettingsValues } from "./sidebar-settings-values";

/**
 * bb's threads plus side chats as children, when the setting is on. bb's
 * sidebar view leaves hidden threads out, so the sidebar's server lists them.
 * Off, or before settings are known, nothing is read.
 */
export function useThreadsWithSideChats(
  threads: readonly PluginSidebarThread[],
  settings: SidebarSettingsValues | null,
): readonly PluginSidebarThread[] {
  const enabled = settings?.showSideChatsAsChildren === true;
  const { data } = useSidebarRead("listSideChats", { enabled });
  const rows = enabled ? data?.sideChats : undefined;
  return useMemo(() => (rows ? withSideChats(threads, rows) : threads), [threads, rows]);
}
