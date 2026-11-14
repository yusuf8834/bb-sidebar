import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./contract";
import { useSidebarRead } from "./bb-sdk";
import { currentSettingsOnly } from "./lib/settings-cache-codec";
import { cachedSidebarSettings, cacheSidebarSettings, type SidebarSettingsValues } from "./sidebar-settings";

/**
 * The saved sidebar settings, read-only, from bb's query cache: it rereads
 * when the server invalidates them and after a reconnect.
 *
 * The saved copy stands in until the first answer and through a failed read.
 * Null until the first answer when nothing is saved yet.
 */
export function useSidebarSettings(): SidebarSettingsValues | null {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [saved] = useState(() => cachedSidebarSettings(rpc));
  const { data } = useSidebarRead("getSidebarSettings");
  const current = useMemo(() => (data ? currentSettingsOnly(data) : null), [data]);
  useEffect(() => {
    if (data) cacheSidebarSettings(rpc, data);
  }, [data, rpc]);
  return current ?? saved;
}
