import { z } from "zod";
import type { ServerContext } from "./server-context";
import { sidebarSettingsSchema } from "./contract";
import { DEFAULT_SIDEBAR_SETTINGS, threadDisplayOf, type SidebarSettingsValues } from "./sidebar-settings-values";

// Derive each field's fallback from the shared defaults. Adding a setting
// needs no repository change, and one invalid field cannot discard others.
const storedSettingsSchema = z.object(
  Object.fromEntries(
    Object.entries(sidebarSettingsSchema.shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).catch(DEFAULT_SIDEBAR_SETTINGS[key as keyof SidebarSettingsValues]),
    ]),
  ),
);

// Settling finished pull requests, and later settling quiet threads, became
// opt-in. Installs that already had sidebar data when each change shipped
// keep that setting on until they save their own settings; a new install has
// empty tables when these run, so it gets the new defaults. Append new names;
// the runner refuses a changed statement at an existing index.
export const INSTALL_DEFAULTS_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS install_defaults (name TEXT PRIMARY KEY)`,
  `INSERT OR IGNORE INTO install_defaults (name)
   SELECT 'settle-finished-pull-requests'
    WHERE EXISTS (SELECT 1 FROM thread_lifecycle)
       OR EXISTS (SELECT 1 FROM inbox_order)
       OR EXISTS (SELECT 1 FROM project_icons)
       OR EXISTS (SELECT 1 FROM project_colors)
       OR EXISTS (SELECT 1 FROM title_recovery_attempts)
       OR EXISTS (SELECT 1 FROM sidebar_settings WHERE settings_json IS NOT NULL)`,
  `INSERT OR IGNORE INTO install_defaults (name)
   SELECT 'settle-quiet-threads'
    WHERE EXISTS (SELECT 1 FROM thread_lifecycle)
       OR EXISTS (SELECT 1 FROM inbox_order)
       OR EXISTS (SELECT 1 FROM project_icons)
       OR EXISTS (SELECT 1 FROM project_colors)
       OR EXISTS (SELECT 1 FROM title_recovery_attempts)
       OR EXISTS (SELECT 1 FROM sidebar_settings WHERE settings_json IS NOT NULL)`,
];

function installKeeps(ctx: ServerContext, name: string): boolean {
  return ctx.db.prepare(`SELECT 1 FROM install_defaults WHERE name = ?`).get(name) !== undefined;
}

export async function createServerSettings(ctx: ServerContext) {
  const defaults: SidebarSettingsValues = { ...DEFAULT_SIDEBAR_SETTINGS };
  if (installKeeps(ctx, "settle-finished-pull-requests")) defaults.autoSettleOnMerge = true;
  if (installKeeps(ctx, "settle-quiet-threads")) defaults.autoSettleInactive = true;

  const readSidebarSettings = (): SidebarSettingsValues => {
    const row = ctx.db.prepare("SELECT settings_json FROM sidebar_settings WHERE id = 1").get() as
      | { settings_json: string | null }
      | undefined;
    if (row?.settings_json == null) return { ...defaults };
    try {
      const stored: unknown = JSON.parse(row.settings_json);
      if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
        throw new Error("Expected a JSON object");
      }
      // Merge defaults before parsing so older JSON also covers new fields.
      // Thread display falls back to the old switch, not the default.
      const threadDisplay = threadDisplayOf(stored);
      return sidebarSettingsSchema.parse(
        storedSettingsSchema.parse({
          ...defaults,
          ...stored,
          threadDisplay,
          compactWorkingThreads: threadDisplay !== "full",
        }),
      );
    } catch (error) {
      ctx.bb.log.warn(
        `Could not parse sidebar_settings.settings_json; using defaults: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ...defaults };
    }
  };

  const writeSidebarSettings = (values: SidebarSettingsValues): void => {
    ctx.db.prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1").run(JSON.stringify(values));
  };

  const hasStoredSidebarSettings =
    ctx.db.prepare(`SELECT 1 FROM sidebar_settings WHERE id = 1 AND settings_json IS NOT NULL`).get() !== undefined;
  if (!hasStoredSidebarSettings) {
    try {
      const legacy = await ctx.bb.sdk.plugins.getSettings({
        pluginId: ctx.bb.pluginId,
      });
      const values = legacy.values;
      const hasLegacyValues = [
        "snoozePresets",
        "inactiveThreadsEnabled",
        "inactiveAfterHours",
        "showRunningChildrenWhenCollapsed",
        "autoSettleInactive",
        "autoSettleAfterDays",
        "autoSettleOnMerge",
      ].some((key) => key in values);
      const migrated = sidebarSettingsSchema.safeParse({
        ...defaults,
        snoozePresets:
          typeof values.snoozePresets === "string" ? values.snoozePresets : DEFAULT_SIDEBAR_SETTINGS.snoozePresets,
        inactiveThreadsEnabled:
          typeof values.inactiveThreadsEnabled === "boolean"
            ? values.inactiveThreadsEnabled
            : DEFAULT_SIDEBAR_SETTINGS.inactiveThreadsEnabled,
        inactiveAfterHours:
          typeof values.inactiveAfterHours === "string"
            ? Number(values.inactiveAfterHours)
            : DEFAULT_SIDEBAR_SETTINGS.inactiveAfterHours,
        showRunningChildrenWhenCollapsed:
          typeof values.showRunningChildrenWhenCollapsed === "boolean"
            ? values.showRunningChildrenWhenCollapsed
            : DEFAULT_SIDEBAR_SETTINGS.showRunningChildrenWhenCollapsed,
        autoSettleInactive:
          typeof values.autoSettleInactive === "boolean" ? values.autoSettleInactive : defaults.autoSettleInactive,
        autoSettleAfterDays:
          typeof values.autoSettleAfterDays === "string"
            ? Number(values.autoSettleAfterDays)
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleAfterDays,
        autoSettleOnMerge:
          typeof values.autoSettleOnMerge === "boolean" ? values.autoSettleOnMerge : defaults.autoSettleOnMerge,
      });
      if (hasLegacyValues && migrated.success) {
        writeSidebarSettings(migrated.data);
      }
    } catch {
      // A new install has no previous settings generation to migrate.
    }
  }

  return { readSidebarSettings, writeSidebarSettings };
}
