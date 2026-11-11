import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerContext } from "./server-context";
import { bbSidebarRpcContract } from "./contract";
import { INBOX_ORDER_CHANNEL } from "./contract";
import { createPortDiscovery } from "./port-discovery";
import { createThreadPortActions } from "./thread-ports";
import { createThreadPullRequests } from "./thread-pull-requests";
import { createTitleRegenerator } from "./regenerate-title";
import { AUTO_TITLE_RECOVERY_MIGRATION, createAutoTitleRecovery } from "./auto-title";
import { createServerSettings, INSTALL_DEFAULTS_MIGRATIONS } from "./server-settings";
import { createServerLifecycle, LIFECYCLE_BACKFILLS_MIGRATION } from "./server-lifecycle";
import { createServerProjectIcons } from "./server-project-icons";
import { PROJECT_ICON_MISSING_HEADER } from "./project-icons";
import { createServerProjectColors } from "./server-project-colors";
import { createServerProjectManagement } from "./server-project-management";
import { createServerSettleCleanup } from "./server-settle-cleanup";
import { createServerSettleActions } from "./server-settle-actions";
import { createServerPolicy } from "./server-policy";
import { createServerHandlers } from "./server-handlers";
import { createServerRateLimits } from "./server-rate-limits";
import { createServerCli } from "./server-cli";

export type { StoredLifecycleRow } from "./server-lifecycle";

const migrations = [
  `CREATE TABLE IF NOT EXISTS thread_lifecycle (
     thread_id      TEXT PRIMARY KEY,
     settled_at     INTEGER,
     snoozed_until  INTEGER,
     snoozed_at     INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS inbox_order (
     thread_id   TEXT PRIMARY KEY,
     sort_index  INTEGER NOT NULL
   )`,
  `ALTER TABLE thread_lifecycle
     ADD COLUMN settled_override TEXT
     CHECK (settled_override IN ('active', 'settled') OR settled_override IS NULL)`,
  `UPDATE thread_lifecycle
      SET settled_override = 'settled'
    WHERE settled_at IS NOT NULL AND settled_override IS NULL`,
  `CREATE TABLE IF NOT EXISTS project_icons (
     project_id  TEXT PRIMARY KEY,
     path        TEXT NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sidebar_settings (
     id                         INTEGER PRIMARY KEY CHECK (id = 1),
     snooze_presets             TEXT NOT NULL,
     inactive_threads_enabled   INTEGER NOT NULL,
     inactive_after_hours       INTEGER NOT NULL,
     auto_settle_inactive       INTEGER NOT NULL,
     auto_settle_after_days     INTEGER NOT NULL,
     auto_settle_on_merge       INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS project_icon_uploads (
     project_id       TEXT PRIMARY KEY,
     filename         TEXT NOT NULL,
     mime_type        TEXT NOT NULL,
     content_base64   TEXT NOT NULL,
     size_bytes       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   )`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN show_running_children_when_collapsed INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE thread_lifecycle ADD COLUMN parked_at INTEGER`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN child_sort_field TEXT NOT NULL DEFAULT 'created'`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN child_sort_direction TEXT NOT NULL DEFAULT 'ascending'`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN child_icon_style TEXT NOT NULL DEFAULT 'disc'`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN compact_working_threads INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN working_shelf INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sidebar_settings
     ADD COLUMN dock_shelves INTEGER NOT NULL DEFAULT 0`,
  AUTO_TITLE_RECOVERY_MIGRATION,
  `ALTER TABLE sidebar_settings ADD COLUMN project_colors_enabled INTEGER NOT NULL DEFAULT 0`,
  // Retained to preserve migration indices for installations of the archive preview.
  `ALTER TABLE sidebar_settings ADD COLUMN archived_shelf_enabled INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS project_colors (
     project_id TEXT PRIMARY KEY,
     color TEXT NOT NULL
   )`,
  `ALTER TABLE sidebar_settings ADD COLUMN project_color_display TEXT NOT NULL DEFAULT 'all'`,
  // Old columns stay for compatibility; drop them with a table rebuild in a
  // later major. All settings reads and writes now use settings_json only.
  `ALTER TABLE sidebar_settings ADD COLUMN settings_json TEXT`,
  `UPDATE sidebar_settings SET settings_json = json_object(
     'snoozePresets', snooze_presets,
     'inactiveThreadsEnabled', json(CASE WHEN inactive_threads_enabled = 1 THEN 'true' ELSE 'false' END),
     'inactiveAfterHours', inactive_after_hours,
     'showRunningChildrenWhenCollapsed', json(CASE WHEN show_running_children_when_collapsed = 1 THEN 'true' ELSE 'false' END),
     'autoSettleInactive', json(CASE WHEN auto_settle_inactive = 1 THEN 'true' ELSE 'false' END),
     'autoSettleAfterDays', auto_settle_after_days,
     'autoSettleOnMerge', json(CASE WHEN auto_settle_on_merge = 1 THEN 'true' ELSE 'false' END),
     'childSortField', child_sort_field,
     'childSortDirection', child_sort_direction,
     'childIconStyle', child_icon_style,
     'compactWorkingThreads', json(CASE WHEN compact_working_threads = 1 THEN 'true' ELSE 'false' END),
     'workingShelf', json(CASE WHEN working_shelf = 1 THEN 'true' ELSE 'false' END),
     'dockShelves', json(CASE WHEN dock_shelves = 1 THEN 'true' ELSE 'false' END),
     'projectColorsEnabled', json(CASE WHEN project_colors_enabled = 1 THEN 'true' ELSE 'false' END),
     'projectColorDisplay', project_color_display
   ) WHERE id = 1`,
  // The original NOT NULL columns have no defaults. Seed their required
  // placeholders once so later saves can UPDATE JSON only. NULL JSON still
  // means no stored settings, preserving the legacy import on new installs.
  `INSERT OR IGNORE INTO sidebar_settings
     (id, snooze_presets, inactive_threads_enabled, inactive_after_hours,
      auto_settle_inactive, auto_settle_after_days, auto_settle_on_merge)
   VALUES (1, '', 1, 6, 1, 3, 1)`,
  LIFECYCLE_BACKFILLS_MIGRATION,
  ...INSTALL_DEFAULTS_MIGRATIONS,
];

export default async function plugin(bb: BbPluginApi) {
  const ctx: ServerContext = { bb, db: bb.storage.database() };
  const getOpenPorts = createPortDiscovery(ctx.bb);

  const threadPortActions = createThreadPortActions(ctx.bb);

  const threadPullRequests = createThreadPullRequests(ctx.bb);

  const regenerateTitle = createTitleRegenerator(ctx.bb);
  ctx.bb.storage.migrate(ctx.db, migrations);
  createAutoTitleRecovery(ctx.bb, regenerateTitle);
  const settings = await createServerSettings(ctx);
  const icons = createServerProjectIcons(ctx);
  const colors = createServerProjectColors(ctx);
  const projects = createServerProjectManagement(ctx, icons);
  const lifecycle = createServerLifecycle(ctx);
  const cleanup = createServerSettleCleanup(ctx, lifecycle, threadPortActions, getOpenPorts);
  const settle = createServerSettleActions(ctx, lifecycle, cleanup);
  const policy = createServerPolicy(ctx, lifecycle, settings, cleanup, threadPortActions);
  const handlers = createServerHandlers(
    ctx,
    lifecycle,
    settings,
    policy,
    cleanup,
    threadPortActions,
    getOpenPorts,
    threadPullRequests,
    regenerateTitle,
    { icons, colors, projects, settle },
  );
  const { resolveProjectIcon } = icons;
  const { wakeAncestors, clearSettlingState, clear } = lifecycle;
  ctx.bb.http.route("GET", "/project-icon", async (context) => {
    const projectId = context.req.query("projectId")?.trim();
    const environmentId = context.req.query("environmentId")?.trim() || null;
    if (!projectId) return context.text("Missing projectId", 400);
    let icon: Awaited<ReturnType<typeof resolveProjectIcon>>;
    try {
      icon = await resolveProjectIcon(projectId, environmentId);
    } catch {
      return context.body(null, 503, { "cache-control": "no-store" });
    }
    // Marked so the app can tell "this project has no icon" from a 404 bb
    // answers while the plugin is still loading (see ProjectFavicon).
    if (!icon) return context.body(null, 404, { "cache-control": "no-store", [PROJECT_ICON_MISSING_HEADER]: "1" });
    const body =
      icon.contentEncoding === "base64" ? Uint8Array.from(Buffer.from(icon.content, "base64")).buffer : icon.content;
    return new Response(body, {
      headers: {
        "cache-control": "private, max-age=0, must-revalidate",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "content-type": icon.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  });
  ctx.bb.background.schedule("auto-settle", "*/5 * * * *", async () => {
    await policy.evaluatePolicies();
  });
  const rateLimits = createServerRateLimits(ctx, lifecycle);
  ctx.bb.rpc.register(bbSidebarRpcContract, { ...handlers, ...rateLimits });
  ctx.bb.cli.register(createServerCli(lifecycle, handlers, rateLimits.getThreadLimits));
  // New or resumed child work reopens the ancestor path, keeping its existing
  // sidebar nesting reachable. Siblings retain their own settled state.
  ctx.bb.events.on("thread.created", async ({ thread }) => {
    await wakeAncestors(thread);
  });

  ctx.bb.events.on("thread.active", async ({ thread }) => {
    clearSettlingState(thread.id);
    await wakeAncestors(thread);
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  ctx.bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
    const removed = ctx.db.prepare(`DELETE FROM inbox_order WHERE thread_id = ?`).run(thread.id);
    if (removed.changes > 0) {
      ctx.bb.realtime.publish(INBOX_ORDER_CHANNEL, {});
    }
  });
}
