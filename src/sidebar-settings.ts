export const SIDEBAR_SETTINGS_CHANNEL = "sidebar-settings";

export interface SidebarSettingsValues {
  snoozePresets: string;
  inactiveThreadsEnabled: boolean;
  inactiveAfterHours: number;
  autoSettleInactive: boolean;
  autoSettleAfterDays: number;
  autoSettleOnMerge: boolean;
}

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettingsValues = {
  snoozePresets: "30m, 2h, 1d, 1w",
  inactiveThreadsEnabled: true,
  inactiveAfterHours: 6,
  autoSettleInactive: true,
  autoSettleAfterDays: 3,
  autoSettleOnMerge: true,
};

const settingsByRpcClient = new WeakMap<object, SidebarSettingsValues>();

export function cachedSidebarSettings(
  rpcClient: object,
): SidebarSettingsValues | null {
  return settingsByRpcClient.get(rpcClient) ?? null;
}

export function cacheSidebarSettings(
  rpcClient: object,
  values: SidebarSettingsValues,
): SidebarSettingsValues {
  settingsByRpcClient.set(rpcClient, values);
  return values;
}
