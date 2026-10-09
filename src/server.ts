// BB Sidebar backend: the settled and snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  autoSettleNeedsPullRequest,
  decideAutoSettle,
  parseAutoSettleAfterDays,
  type AutoSettlePullRequest,
  type SettledOverride,
} from "./auto-settle";
import { runThreadTasks } from "./thread-tasks";
import {
  EMPTY_RECLAIM,
  planTerminalReclaim,
  type ReclaimSummary,
} from "./reclaim";
import { createTitleRegenerator } from "./regenerate-title";
import { AUTO_TITLE_RECOVERY_MIGRATION, createAutoTitleRecovery } from "./auto-title";
import {
  PROJECT_ICON_CANDIDATES,
  PROJECT_ICONS_CHANNEL,
  extractProjectIconHref,
  iconPathsForHref,
  normalizeProjectIconPath,
} from "./project-icons";
import {
  CHILD_THREAD_ICON_STYLES,
  CHILD_THREAD_SORT_DIRECTIONS,
  CHILD_THREAD_SORT_FIELDS,
  childThreadSettingsOf,
  DEFAULT_SIDEBAR_SETTINGS,
  SIDEBAR_SETTINGS_CHANNEL,
  type SidebarSettingsValues,
} from "./sidebar-settings";
import { canPark, configuredSnoozePresetError, hasLiveWork, isTurnInFlight } from "./lifecycle";
import { portSnapshotSchema } from "./open-ports";
import { createPortDiscovery } from "./port-discovery";
import { createThreadPortActions } from "./thread-ports";
import { createThreadPullRequests } from "./thread-pull-requests";
import { threadPullRequestSchema } from "./pull-requests";
import { ownedPortTargetSchema, closePortsResultSchema } from "./close-owned-ports";

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
];

export interface StoredLifecycleRow {
  threadId: string;
  parkedAt?: number | null;
  settledAt: number | null;
  settledOverride: SettledOverride | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  parked_at: number | null;
  settled_at: number | null;
  settled_override: SettledOverride | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
}

interface SidebarSettingsDbRow {
  snooze_presets: string;
  inactive_threads_enabled: number;
  inactive_after_hours: number;
  show_running_children_when_collapsed: number;
  auto_settle_inactive: number;
  auto_settle_after_days: number;
  auto_settle_on_merge: number;
  child_sort_field: string;
  child_sort_direction: string;
  child_icon_style: string;
  compact_working_threads: number;
  working_shelf: number;
  dock_shelves: number;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });

/**
 * What parking a thread released. These counts are what the toast reminds the
 * user about, so they travel back with the acknowledgement rather than on the
 * realtime channel, which every other client would also receive.
 */
const reclaimSchema = z.object({
  closedTerminals: z.number().int().nonnegative(),
  keptTerminals: z.number().int().nonnegative(),
  stoppedRuntime: z.boolean(),
});
const orderedThreadIdsSchema = z
  .array(z.string().trim().min(1))
  .max(10_000)
  .superRefine((threadIds, context) => {
    if (new Set(threadIds).size !== threadIds.length) {
      context.addIssue({
        code: "custom",
        message: "Thread ids must be unique",
      });
    }
  });
const threadIdsSchema = orderedThreadIdsSchema.min(1);
const cleanupIssueSchema = z.object({
  threadId: z.string(),
  resource: z.enum(["thread", "terminal", "port"]),
  message: z.string(),
});
const cleanupPreviewSchema = z.object({
  token: z.string(),
  threads: z.array(z.object({
    threadId: z.string(),
    title: z.string(),
    terminalCount: z.number().int().nonnegative(),
    ports: z.array(z.number().int()),
  })),
  skipped: z.array(cleanupIssueSchema),
});
const cleanupResultSchema = z.object({
  closedTerminals: z.number().int().nonnegative(),
  signalledPorts: z.array(z.object({ threadId: z.string(), port: z.number().int() })),
  remainingPorts: z.array(z.object({ threadId: z.string(), port: z.number().int() })),
  skipped: z.array(cleanupIssueSchema),
  failed: z.array(cleanupIssueSchema),
});
export type SettledCleanupPreview = z.infer<typeof cleanupPreviewSchema>;
export type SettledCleanupResult = z.infer<typeof cleanupResultSchema>;
const projectIdSchema = z.string().trim().min(1);
const projectIconPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((path) => normalizeProjectIconPath(path) !== null, {
    message: "Choose a relative SVG, PNG, ICO, JPEG, GIF, AVIF, or WebP path",
  });
const sidebarSettingsSchema = z
  .object({
    snoozePresets: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => configuredSnoozePresetError(value) === null, {
        message: "Use one to eight valid snooze shortcuts",
      }),
    inactiveThreadsEnabled: z.boolean(),
    inactiveAfterHours: z.number().int().min(1).max(720),
    showRunningChildrenWhenCollapsed: z.boolean(),
    autoSettleInactive: z.boolean(),
    autoSettleAfterDays: z.number().int().min(1).max(90),
    autoSettleOnMerge: z.boolean(),
    childSortField: z.enum(CHILD_THREAD_SORT_FIELDS),
    childSortDirection: z.enum(CHILD_THREAD_SORT_DIRECTIONS),
    childIconStyle: z.enum(CHILD_THREAD_ICON_STYLES),
    compactWorkingThreads: z.boolean(),
    workingShelf: z.boolean(),
    dockShelves: z.boolean(),
  })
  .strict();
const uploadFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (filename) =>
      !filename.includes("/") &&
      !filename.includes("\\") &&
      normalizeProjectIconPath(filename) !== null,
    { message: "Choose a supported image file" },
  );
const iconBase64Schema = z
  .string()
  .min(1)
  .max(1_400_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Invalid image data");
export const bbSidebarRpcContract = defineRpcContract({
  getThreadPorts: {
    input: threadIdSchema,
    output: z.object({ ports: z.array(ownedPortTargetSchema) }),
  },
  closeThreadPorts: {
    input: threadIdSchema.extend({ ports: z.array(ownedPortTargetSchema).min(1).max(1000) }),
    output: closePortsResultSchema,
  },
  previewSettledCleanup: {
    input: z.object({ threadIds: threadIdsSchema }).strict(),
    output: cleanupPreviewSchema,
  },
  cleanSettled: {
    input: z.object({ token: z.string().uuid() }).strict(),
    output: cleanupResultSchema,
  },
  stopWorkspacePort: {
    input: threadIdSchema.extend({ port: ownedPortTargetSchema }).strict(),
    output: closePortsResultSchema,
  },
  getOpenPorts: {
    input: z.object({}).strict(),
    output: portSnapshotSchema,
  },
  getThreadPullRequests: {
    input: threadIdSchema.strict(),
    output: z.object({ pullRequests: z.array(threadPullRequestSchema) }).strict(),
  },
  getThreadExecutionDetails: {
    input: threadIdSchema.strict(),
    output: z.object({
      model: z.string(),
      reasoningLevel: z.string(),
    }).strict().nullable(),
  },
  setThreadParent: {
    input: threadIdSchema.extend({ parentThreadId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ ok: z.boolean(), unpinFailed: z.literal(true).optional() }),
  },
  deleteThread: {
    input: threadIdSchema.extend({ childThreadsConfirmed: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  archiveThreads: {
    input: z.object({ threadIds: threadIdsSchema }).strict(),
    output: z.object({
      archived: z.number(),
      failures: z.array(z.object({ threadId: z.string(), error: z.string() })),
    }),
  },
  unarchiveThread: {
    input: threadIdSchema.strict(),
    output: z.object({ ok: z.boolean() }),
  },
  regenerateTitle: {
    input: threadIdSchema.strict(),
    output: z.object({ title: z.string().min(1).max(100) }).strict(),
  },
  getSidebarSettings: {
    input: z.object({}).strict(),
    output: sidebarSettingsSchema,
  },
  updateSidebarSettings: {
    // A client built before a setting existed leaves it out; keep what is stored.
    input: sidebarSettingsSchema.partial({
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
    }),
    output: sidebarSettingsSchema,
  },
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          parkedAt: z.number().nullable().optional(),
          settledAt: z.number().nullable(),
          settledOverride: z.enum(["active", "settled"]).nullable().optional(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  pin: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  settle: {
    input: threadIdSchema,
    output: z.object({ ok: z.boolean(), reclaim: reclaimSchema }),
  },
  park: {
    input: threadIdSchema,
    output: z.object({ ok: z.boolean(), reclaim: reclaimSchema }),
  },
  resume: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
    output: z.object({ ok: z.boolean(), reclaim: reclaimSchema }),
  },
  releaseRuntimes: {
    input: z.object({ threadIds: threadIdsSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  unsnooze: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  acknowledgeWake: {
    input: threadIdSchema,
    output: z.object({ ok: z.boolean() }),
  },
  reorderPinned: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        previousThreadId: z.string().trim().min(1).nullable(),
        nextThreadId: z.string().trim().min(1).nullable(),
      })
      .strict(),
    output: z.object({ pinnedThreadIds: z.array(z.string()) }).strict(),
  },
  listInboxOrder: {
    input: z.object({}).strict(),
    output: z.object({ inboxThreadIds: z.array(z.string()) }).strict(),
  },
  reorderInbox: {
    input: z.object({ inboxThreadIds: orderedThreadIdsSchema }).strict(),
    output: z.object({ inboxThreadIds: z.array(z.string()) }).strict(),
  },
  evaluateAutoSettle: {
    input: z.object({}).strict(),
    output: z.object({ changedThreadIds: z.array(z.string()) }).strict(),
  },
  listProjectIconSettings: {
    input: z.object({}).strict(),
    output: z
      .object({
        projects: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              customPath: z.string().nullable(),
              customUploadName: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  listProjects: {
    input: z.object({}).strict(),
    output: z
      .object({
        projects: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  renameProject: {
    input: z.object({ projectId: projectIdSchema, name: z.string().trim().min(1).max(500) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  projectPathHosts: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() }).strict()) }).strict(),
  },
  addProjectPath: {
    input: z.object({
      projectId: projectIdSchema,
      hostId: z.string().trim().min(1),
      path: z.string().trim().min(1).max(4096),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  removeProject: {
    input: z
      .object({
        projectId: projectIdSchema,
        confirmation: z.string().max(500),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  searchProjectIconFiles: {
    input: z
      .object({
        projectId: projectIdSchema,
        query: z.string().trim().max(200),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }).strict(),
  },
  setProjectIcon: {
    input: z
      .object({
        projectId: projectIdSchema,
        path: projectIconPathSchema.nullable(),
      })
      .strict(),
    output: z
      .object({
        customPath: z.string().nullable(),
        customUploadName: z.string().nullable(),
      })
      .strict(),
  },
  uploadProjectIcon: {
    input: z
      .object({
        projectId: projectIdSchema,
        filename: uploadFilenameSchema,
        mimeType: z.string().max(100),
        contentBase64: iconBase64Schema,
      })
      .strict(),
    output: z
      .object({
        customPath: z.string().nullable(),
        customUploadName: z.string().nullable(),
      })
      .strict(),
  },
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";
export const INBOX_ORDER_CHANNEL = "inbox-order";
interface StoredProjectIconRow {
  project_id: string;
  path: string;
  updated_at: number;
}

interface StoredProjectIconUploadRow {
  project_id: string;
  filename: string;
  mime_type: string;
  content_base64: string;
  size_bytes: number;
  updated_at: number;
}

interface ResolvedProjectIcon {
  content: string;
  contentEncoding: "base64" | "utf8";
  mimeType: string;
  path: string;
  sizeBytes: number;
}

const PROJECT_ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;
const PROJECT_ICON_MAX_BYTES = 1_000_000;
const PROJECT_ICON_CACHE_MS = 5 * 60_000;
const PROJECT_ICON_MISS_CACHE_MS = 30_000;

// Only a file that does not exist is a real miss. Any other read failure, such
// as a host that is still connecting, must not be cached as "no icon".
function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code, message } = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    status === 404 ||
    code === "ENOENT" ||
    (typeof message === "string" &&
      /ENOENT|not found|does not exist/i.test(message))
  );
}

function iconMimeType(path: string, reported: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".webp")) return "image/webp";
  return reported;
}

export default async function plugin(bb: BbPluginApi) {
  const getOpenPorts = createPortDiscovery(bb);
  const threadPortActions = createThreadPortActions(bb);
  const threadPullRequests = createThreadPullRequests(bb);
  const regenerateTitle = createTitleRegenerator(bb);
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  createAutoTitleRecovery(bb, regenerateTitle);

  const readSidebarSettings = (): SidebarSettingsValues => {
    const row = db
      .prepare(
        `SELECT snooze_presets, inactive_threads_enabled,
                inactive_after_hours, show_running_children_when_collapsed,
                auto_settle_inactive,
                auto_settle_after_days, auto_settle_on_merge,
                child_sort_field, child_sort_direction, child_icon_style,
                compact_working_threads, working_shelf, dock_shelves
           FROM sidebar_settings
          WHERE id = 1`,
      )
      .get() as SidebarSettingsDbRow | undefined;
    return row
      ? {
          snoozePresets: row.snooze_presets,
          inactiveThreadsEnabled: row.inactive_threads_enabled === 1,
          inactiveAfterHours: row.inactive_after_hours,
          showRunningChildrenWhenCollapsed:
            row.show_running_children_when_collapsed === 1,
          autoSettleInactive: row.auto_settle_inactive === 1,
          autoSettleAfterDays: row.auto_settle_after_days,
          autoSettleOnMerge: row.auto_settle_on_merge === 1,
          ...childThreadSettingsOf({
            childSortField: row.child_sort_field,
            childSortDirection: row.child_sort_direction,
            childIconStyle: row.child_icon_style,
          }),
          compactWorkingThreads: row.compact_working_threads === 1,
          workingShelf: row.working_shelf === 1,
          dockShelves: row.dock_shelves === 1,
        }
      : { ...DEFAULT_SIDEBAR_SETTINGS };
  };
  const writeSidebarSettings = (values: SidebarSettingsValues): void => {
    db.prepare(
      `INSERT INTO sidebar_settings (
         id, snooze_presets, inactive_threads_enabled,
         inactive_after_hours, show_running_children_when_collapsed,
         auto_settle_inactive,
         auto_settle_after_days, auto_settle_on_merge,
         child_sort_field, child_sort_direction, child_icon_style,
         compact_working_threads, working_shelf, dock_shelves
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         snooze_presets = excluded.snooze_presets,
         inactive_threads_enabled = excluded.inactive_threads_enabled,
         inactive_after_hours = excluded.inactive_after_hours,
         show_running_children_when_collapsed =
           excluded.show_running_children_when_collapsed,
         auto_settle_inactive = excluded.auto_settle_inactive,
         auto_settle_after_days = excluded.auto_settle_after_days,
         auto_settle_on_merge = excluded.auto_settle_on_merge,
         child_sort_field = excluded.child_sort_field,
         child_sort_direction = excluded.child_sort_direction,
         child_icon_style = excluded.child_icon_style,
         compact_working_threads = excluded.compact_working_threads,
         working_shelf = excluded.working_shelf,
         dock_shelves = excluded.dock_shelves`,
    ).run(
      values.snoozePresets,
      values.inactiveThreadsEnabled ? 1 : 0,
      values.inactiveAfterHours,
      values.showRunningChildrenWhenCollapsed ? 1 : 0,
      values.autoSettleInactive ? 1 : 0,
      values.autoSettleAfterDays,
      values.autoSettleOnMerge ? 1 : 0,
      values.childSortField,
      values.childSortDirection,
      values.childIconStyle,
      values.compactWorkingThreads ? 1 : 0,
      values.workingShelf ? 1 : 0,
      values.dockShelves ? 1 : 0,
    );
  };

  const hasStoredSidebarSettings =
    db.prepare(`SELECT 1 FROM sidebar_settings WHERE id = 1`).get() !==
    undefined;
  if (!hasStoredSidebarSettings) {
    try {
      const legacy = await bb.sdk.plugins.getSettings({
        pluginId: bb.pluginId,
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
        snoozePresets:
          typeof values.snoozePresets === "string"
            ? values.snoozePresets
            : DEFAULT_SIDEBAR_SETTINGS.snoozePresets,
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
          typeof values.autoSettleInactive === "boolean"
            ? values.autoSettleInactive
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleInactive,
        autoSettleAfterDays:
          typeof values.autoSettleAfterDays === "string"
            ? Number(values.autoSettleAfterDays)
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleAfterDays,
        autoSettleOnMerge:
          typeof values.autoSettleOnMerge === "boolean"
            ? values.autoSettleOnMerge
            : DEFAULT_SIDEBAR_SETTINGS.autoSettleOnMerge,
        childSortField: DEFAULT_SIDEBAR_SETTINGS.childSortField,
        childSortDirection: DEFAULT_SIDEBAR_SETTINGS.childSortDirection,
        childIconStyle: DEFAULT_SIDEBAR_SETTINGS.childIconStyle,
        compactWorkingThreads: DEFAULT_SIDEBAR_SETTINGS.compactWorkingThreads,
        workingShelf: DEFAULT_SIDEBAR_SETTINGS.workingShelf,
        dockShelves: DEFAULT_SIDEBAR_SETTINGS.dockShelves,
      });
      if (hasLegacyValues && migrated.success) {
        writeSidebarSettings(migrated.data);
      }
    } catch {
      // A new install has no previous settings generation to migrate.
    }
  }

  const projectIconCache = new Map<
    string,
    { expiresAt: number; icon: ResolvedProjectIcon | null }
  >();
  const pendingProjectIconResolutions = new Map<
    string,
    Promise<ResolvedProjectIcon | null>
  >();
  const projectIconGenerations = new Map<string, number>();
  const defaultProjectHostIds = new Map<string, Promise<string | null>>();
  const readProjectIconOverride = (projectId: string): string | null =>
    (
      db
        .prepare(
          `SELECT project_id, path, updated_at
             FROM project_icons
            WHERE project_id = ?`,
        )
        .get(projectId) as StoredProjectIconRow | undefined
    )?.path ?? null;
  const readProjectIconUpload = (
    projectId: string,
  ): StoredProjectIconUploadRow | null =>
    (db
      .prepare(
        `SELECT project_id, filename, mime_type, content_base64,
                size_bytes, updated_at
           FROM project_icon_uploads
          WHERE project_id = ?`,
      )
      .get(projectId) as StoredProjectIconUploadRow | undefined) ?? null;
  const clearProjectIconCache = (projectId: string): void => {
    projectIconGenerations.set(
      projectId,
      (projectIconGenerations.get(projectId) ?? 0) + 1,
    );
    for (const key of projectIconCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) projectIconCache.delete(key);
    }
    for (const key of pendingProjectIconResolutions.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        pendingProjectIconResolutions.delete(key);
      }
    }
  };

  const projectIconGeneration = (projectId: string): number =>
    projectIconGenerations.get(projectId) ?? 0;

  const defaultProjectHostId = async (
    projectId: string,
  ): Promise<string | null> => {
    let pending = defaultProjectHostIds.get(projectId);
    if (!pending) {
      pending = bb.sdk.projects.get({ projectId }).then(
        (project) =>
          project.sources.find((source) => source.isDefault)?.hostId ??
          project.sources[0]?.hostId ??
          null,
      );
      defaultProjectHostIds.set(projectId, pending);
      void pending.catch(() => defaultProjectHostIds.delete(projectId));
    }
    return pending;
  };

  const readProjectFile = async (
    projectId: string,
    environmentId: string | null,
    path: string,
  ) => {
    if (environmentId) {
      return bb.sdk.projects.fileContent({ projectId, environmentId, path });
    }
    const hostId = await defaultProjectHostId(projectId);
    return hostId
      ? bb.sdk.projects.fileContent({ projectId, hostId, path })
      : bb.sdk.projects.fileContent({ projectId, path });
  };

  const tryProjectIcon = async (
    projectId: string,
    environmentId: string | null,
    path: string,
  ): Promise<ResolvedProjectIcon | null> => {
    const normalized = normalizeProjectIconPath(path);
    if (!normalized) return null;
    try {
      const file = await readProjectFile(projectId, environmentId, normalized);
      if (file.sizeBytes > PROJECT_ICON_MAX_BYTES) return null;
      return {
        ...file,
        mimeType: iconMimeType(normalized, file.mimeType),
        path: normalized,
      };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  };

  const resolveProjectIconUncached = async (
    projectId: string,
    environmentId: string | null,
    generation: number,
  ): Promise<ResolvedProjectIcon | null> => {
    const cacheKey = `${projectId}\0${environmentId ?? ""}`;
    const upload = readProjectIconUpload(projectId);
    if (upload) {
      const icon = {
        content: upload.content_base64,
        contentEncoding: "base64" as const,
        mimeType: upload.mime_type,
        path: upload.filename,
        sizeBytes: upload.size_bytes,
      };
      if (projectIconGeneration(projectId) === generation) {
        projectIconCache.set(cacheKey, {
          expiresAt: Date.now() + PROJECT_ICON_CACHE_MS,
          icon,
        });
      }
      return icon;
    }
    const candidates: string[] = [];
    const customPath = readProjectIconOverride(projectId);
    if (customPath) candidates.push(customPath);
    candidates.push(...PROJECT_ICON_CANDIDATES);

    let icon: ResolvedProjectIcon | null = null;
    let unavailable = false;
    for (const candidate of new Set(candidates)) {
      try {
        icon = await tryProjectIcon(projectId, environmentId, candidate);
      } catch {
        unavailable = true;
        continue;
      }
      if (icon) break;
    }

    if (!icon) {
      for (const sourcePath of PROJECT_ICON_SOURCE_FILES) {
        try {
          const source = await readProjectFile(
            projectId,
            environmentId,
            sourcePath,
          );
          if (
            source.contentEncoding !== "utf8" ||
            source.sizeBytes > PROJECT_ICON_MAX_BYTES
          ) {
            continue;
          }
          const href = extractProjectIconHref(source.content);
          if (!href) continue;
          for (const path of iconPathsForHref(href)) {
            icon = await tryProjectIcon(projectId, environmentId, path);
            if (icon) break;
          }
          if (icon) break;
        } catch (error) {
          // Each source file is optional.
          if (!isMissingFileError(error)) unavailable = true;
        }
      }
    }
    if (!icon && unavailable) {
      throw new Error(`Project icon files for ${projectId} could not be read`);
    }

    if (projectIconGeneration(projectId) === generation) {
      projectIconCache.set(cacheKey, {
        expiresAt:
          Date.now() + (icon ? PROJECT_ICON_CACHE_MS : PROJECT_ICON_MISS_CACHE_MS),
        icon,
      });
    }
    return icon;
  };

  const resolveProjectIcon = (
    projectId: string,
    environmentId: string | null,
  ): Promise<ResolvedProjectIcon | null> => {
    const cacheKey = `${projectId}\0${environmentId ?? ""}`;
    const cached = projectIconCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.icon);
    }
    const pending = pendingProjectIconResolutions.get(cacheKey);
    if (pending) return pending;
    const generation = projectIconGeneration(projectId);
    const resolution = resolveProjectIconUncached(
      projectId,
      environmentId,
      generation,
    ).finally(() => {
      if (pendingProjectIconResolutions.get(cacheKey) === resolution) {
        pendingProjectIconResolutions.delete(cacheKey);
      }
    });
    pendingProjectIconResolutions.set(cacheKey, resolution);
    return resolution;
  };

  bb.http.route("GET", "/project-icon", async (context) => {
    const projectId = context.req.query("projectId")?.trim();
    const environmentId = context.req.query("environmentId")?.trim() || null;
    if (!projectId) return context.text("Missing projectId", 400);
    let icon: ResolvedProjectIcon | null;
    try {
      icon = await resolveProjectIcon(projectId, environmentId);
    } catch {
      return context.body(null, 503, { "cache-control": "no-store" });
    }
    if (!icon) return context.body(null, 404, { "cache-control": "no-store" });
    const body =
      icon.contentEncoding === "base64"
        ? Uint8Array.from(Buffer.from(icon.content, "base64")).buffer
        : icon.content;
    return new Response(body, {
      headers: {
        "cache-control": "private, max-age=0, must-revalidate",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "content-type": icon.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  });

  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, settled_override,
                  snoozed_until, snoozed_at, parked_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      parkedAt: row.parked_at,
      settledAt: row.settled_at,
      settledOverride: row.settled_override,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    }));

  const readOne = (threadId: string): StoredLifecycleRow | null => {
    const row = db
      .prepare(
        `SELECT thread_id, settled_at, settled_override,
                snoozed_until, snoozed_at, parked_at
           FROM thread_lifecycle
          WHERE thread_id = ?`,
      )
      .get(threadId) as LifecycleDbRow | undefined;
    return row
      ? {
          threadId: row.thread_id,
          parkedAt: row.parked_at,
          settledAt: row.settled_at,
          settledOverride: row.settled_override,
          snoozedUntil: row.snoozed_until,
          snoozedAt: row.snoozed_at,
        }
      : null;
  };

  const write = (row: StoredLifecycleRow, publish = true): void => {
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         settled_override = excluded.settled_override,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at,
         parked_at = excluded.parked_at`,
    ).run(
      row.threadId,
      row.settledAt,
      row.settledOverride,
      row.snoozedUntil,
      row.snoozedAt,
      row.parkedAt ?? null,
    );
    if (publish) {
      bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
    }
  };

  const writeMany = db.transaction((rows: readonly StoredLifecycleRow[]) => {
    for (const row of rows) write(row, false);
  });

  const publishLifecycleChanges = (threadIds: readonly string[]): void => {
    if (threadIds.length === 0) return;
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadIds });
  };

  const clear = (threadId: string): void => {
    db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(
      threadId,
    );
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
  };

  const clearSettlingState = (threadId: string): boolean => {
    const row = readOne(threadId);
    if (
      row === null ||
      (row.settledAt === null && row.settledOverride === null && row.parkedAt == null)
    ) {
      return false;
    }
    if (row.snoozedUntil === null) {
      db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(
        threadId,
      );
    } else {
      write(
        {
          ...row,
          settledAt: null,
          settledOverride: null,
        },
        false,
      );
    }
    bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId });
    return true;
  };

  // Pin and reparent must not both validate the same old root state.
  const pinParentChanges = new Set<string>();
  const withPinParentChange = async <T>(threadId: string, change: () => Promise<T>): Promise<T> => {
    if (pinParentChanges.has(threadId)) {
      throw new Error("Thread update already in progress. Try again.");
    }
    pinParentChanges.add(threadId);
    try {
      return await change();
    } finally {
      pinParentChanges.delete(threadId);
    }
  };

  const readInboxOrder = (): string[] =>
    (
      db
        .prepare(
          `SELECT thread_id
             FROM inbox_order
            ORDER BY sort_index ASC, thread_id ASC`,
        )
        .all() as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);

  const replaceInboxOrder = db.transaction((inboxThreadIds: string[]) => {
    db.prepare(`DELETE FROM inbox_order`).run();
    const insert = db.prepare(
      `INSERT INTO inbox_order (thread_id, sort_index) VALUES (?, ?)`,
    );
    inboxThreadIds.forEach((threadId, index) => insert.run(threadId, index));
  });

  // Project rows, not plain thread rows: only they carry every kind of live
  // work the sidebar checks (workflows, background commands, plan mode, goals,
  // a pending interaction, queued messages). One unpaged request covers the
  // same unarchived, visible threads the old paged thread list did.
  const loadPolicyThreads = async (includeHidden = false) => {
    const projects = await bb.sdk.projects.list({
      include: "threads",
      includePersonal: true,
    });
    return projects.flatMap((project) =>
      "threads" in project
        ? project.threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              thread.deletedAt === null &&
              (includeHidden || thread.visibility === "visible"),
          )
        : [],
    );
  };

  type CleanupThread = Awaited<ReturnType<typeof loadPolicyThreads>>[number];
  type CleanupIssue = z.infer<typeof cleanupIssueSchema>;
  type CleanupPlanThread = {
    threadId: string;
    terminalIds: string[];
    ports: Array<z.infer<typeof ownedPortTargetSchema>>;
    workspace: { environmentId: string; hostId: string; path: string } | null;
  };
  const sameCleanupWorkspace = (
    left: CleanupPlanThread["workspace"],
    right: CleanupPlanThread["workspace"],
  ) => left === null ? right === null : right !== null &&
    left.environmentId === right.environmentId && left.hostId === right.hostId && left.path === right.path;
  const terminalInCleanupWorkspace = (
    session: { environmentId: string | null; hostId: string | null },
    workspace: CleanupPlanThread["workspace"],
  ) => workspace === null ? session.environmentId === null :
    session.environmentId === workspace.environmentId && session.hostId === workspace.hostId;
  const cleanupPlans = new Map<string, { expiresAt: number; threads: CleanupPlanThread[]; skipped: CleanupIssue[] }>();
  bb.onDispose(() => cleanupPlans.clear());

  const canCleanSettledThread = (thread: CleanupThread, row: StoredLifecycleRow | null) => {
    if (!row || thread.visibility !== "visible" || row.settledAt === null || row.parkedAt != null ||
        row.snoozedUntil !== null || thread.pinnedAt !== null ||
        thread.latestAttentionAt > row.settledAt) return false;
    const activity = thread.activity;
    return canPark({
      hasPendingInteraction: thread.hasPendingInteraction,
      hasQueuedWork: thread.queuedWork !== "none",
      isWorking: hasLiveWork({
        workflows: activity.activeWorkflowCount,
        backgroundAgents: activity.activeBackgroundAgentCount,
        backgroundCommands: activity.activeBackgroundCommandCount,
        planMode: activity.activePlanModeCount,
        goals: activity.activeGoalCount,
      }, isTurnInFlight(thread.status)),
    });
  };
  const cleanupContext = async (targetThreadId?: string) => {
    const beforeLookup = await loadPolicyThreads(true);
    const target = targetThreadId ? beforeLookup.find((thread) => thread.id === targetThreadId) : undefined;
    const lookupThreads = target ? beforeLookup.filter((thread) =>
      thread.environmentId === target.environmentId ||
      (target.environmentHostId && thread.environmentHostId === target.environmentHostId),
    ) : beforeLookup;
    const { paths, failedHosts } = await threadPortActions.canonicalWorkspacePaths(lookupThreads);
    // Host path lookup can take seconds. Policy and activity must be read
    // again after it, before any cleanup decision is made.
    const threads = await loadPolicyThreads(true);
    const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const currentTarget = targetThreadId ? byId.get(targetThreadId) : undefined;
    const relevant = currentTarget ? threads.filter((thread) =>
      thread.environmentId === currentTarget.environmentId ||
      (currentTarget.environmentHostId && thread.environmentHostId === currentTarget.environmentHostId),
    ) : threads;
    const workspaceKeys = (thread: CleanupThread): string[] => {
      if (!thread.environmentId) return [];
      const path = paths.get(thread.environmentId);
      return [
        `environment:${thread.environmentId}`,
        ...(thread.environmentHostId && path ? [`path:${thread.environmentHostId}\0${path}`] : []),
      ];
    };
    const protectedWorkspaces = new Set(relevant.flatMap((thread) => {
      if (canCleanSettledThread(thread, readOne(thread.id))) return [];
      return workspaceKeys(thread);
    }));
    const unresolvedProtectedHosts = new Set(relevant.flatMap((thread) => {
      if (canCleanSettledThread(thread, readOne(thread.id))) return [];
      if (!thread.environmentHostId || !thread.environmentPath ||
          !thread.environmentId || !paths.has(thread.environmentId)) {
        return thread.environmentHostId ? [thread.environmentHostId] : [];
      }
      return [];
    }));
    const isProtectedWorkspace = (thread: CleanupThread) => {
      if (!thread.environmentId) return false;
      if (!thread.environmentHostId || !thread.environmentPath ||
          failedHosts.has(thread.environmentHostId) || !paths.has(thread.environmentId) ||
          unresolvedProtectedHosts.has(thread.environmentHostId)) return true;
      return workspaceKeys(thread).some((key) => protectedWorkspaces.has(key));
    };
    return { byId, isProtectedWorkspace };
  };
  const cleanupError = (error: unknown): string =>
    error instanceof Error && error.message.trim() ? error.message : String(error);

  const loadPullRequests = async (environmentIds: readonly string[]) => {
    const results = new Map<string, AutoSettlePullRequest>();
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(4, environmentIds.length) },
      async () => {
        while (nextIndex < environmentIds.length) {
          const environmentId = environmentIds[nextIndex++]!;
          try {
            const result = await bb.sdk.environments.pullRequest({
              environmentId,
            });
            if (result.outcome === "available") {
              results.set(environmentId, {
                outcome: "available",
                state: result.pullRequest.state,
                updatedAt: result.pullRequest.updatedAt,
              });
            } else if (result.outcome === "absent") {
              results.set(environmentId, { outcome: "absent" });
            } else {
              results.set(environmentId, { outcome: "unknown" });
            }
          } catch {
            results.set(environmentId, { outcome: "unknown" });
          }
        }
      },
    );
    await Promise.all(workers);
    return results;
  };

  /**
   * Release what a settled thread was still holding.
   *
   * Both settle paths refuse to park live work — the manual one through
   * `canPark`, the policy one through `cannotAutoSettle` — so stopping the
   * thread here can never interrupt a turn in flight. Every failure is
   * swallowed: the lifecycle row is already written by the time this runs, and
   * a host that cannot be reached is a missed reclaim, not a broken settle.
   */
  const reclaimThreadResources = async (
    threadId: string,
  ): Promise<ReclaimSummary> => {
    let stoppedRuntime = false;
    try {
      await bb.sdk.threads.stop({ threadId });
      stoppedRuntime = true;
    } catch {
      // A thread with no loaded runtime is the common case, not an error.
    }

    let closedTerminals = 0;
    let keptTerminals = 0;
    try {
      const { sessions } = await bb.sdk.terminals.list({
        scope: { kind: "thread", threadId },
      });
      const plan = planTerminalReclaim(sessions);
      keptTerminals = plan.keep;
      for (const terminalId of plan.close) {
        try {
          await bb.sdk.terminals.close({ terminalId, mode: "if-clean" });
          closedTerminals += 1;
        } catch {
          // Someone typed into it between the list and the close.
        }
      }
    } catch {
      // Leave the counts at zero rather than reporting a number we did not see.
    }

    return { closedTerminals, keptTerminals, stoppedRuntime };
  };

  const applyPolicyChanges = db.transaction(
    (
      changes: ReadonlyArray<{
        decision: "settle" | "unsettle";
        row: StoredLifecycleRow | null;
        threadId: string;
      }>,
      now: number,
    ) => {
      for (const { decision, row, threadId } of changes) {
        if (decision === "settle") {
          write(
            {
              threadId,
              settledAt: now,
              settledOverride: null,
              snoozedUntil: row?.snoozedUntil ?? null,
              snoozedAt: row?.snoozedAt ?? null,
            },
            false,
          );
        } else if (row?.snoozedUntil != null) {
          write(
            {
              ...row,
              settledAt: null,
              settledOverride: null,
            },
            false,
          );
        } else {
          db.prepare(`DELETE FROM thread_lifecycle WHERE thread_id = ?`).run(
            threadId,
          );
        }
      }
    },
  );

  let policyEvaluation: Promise<string[]> | null = null;
  let policyEvaluationQueued = false;
  const evaluatePolicies = (): Promise<string[]> => {
    if (policyEvaluation !== null) {
      policyEvaluationQueued = true;
      return policyEvaluation;
    }
    const evaluation = (async () => {
      const configured = readSidebarSettings();
      const threads = await loadPolicyThreads();
      const lifecycleByThreadId = new Map(
        readAll().map((row) => [row.threadId, row]),
      );
      const environmentIds = [
        ...new Set(
          threads.flatMap((thread) => {
            if (
              thread.environmentId === null ||
              !autoSettleNeedsPullRequest(
                lifecycleByThreadId.get(thread.id) ?? null,
                thread,
              )
            ) {
              return [];
            }
            return [thread.environmentId];
          }),
        ),
      ];
      const pullRequests = await loadPullRequests(environmentIds);
      const now = Date.now();
      const policySettings = {
        afterDays: parseAutoSettleAfterDays(
          configured.autoSettleInactive,
          String(configured.autoSettleAfterDays),
        ),
        onMerge: configured.autoSettleOnMerge,
      };
      const decide = (keepThreadIds: ReadonlySet<string>) =>
        threads.flatMap((thread) => {
          if (keepThreadIds.has(thread.id)) return [];
          // Re-read after every lookup so a concurrent Park action wins.
          const row = readOne(thread.id);
          const decision = decideAutoSettle({
            lifecycle: row,
            now,
            pullRequest:
              thread.environmentId === null
                ? { outcome: "absent" }
                : (pullRequests.get(thread.environmentId) ?? {
                    outcome: "unknown",
                  }),
            settings: policySettings,
            thread,
          });
          return decision === "keep"
            ? []
            : [{ decision, row, threadId: thread.id }];
        });
      let changes = decide(new Set());
      // Settling stops the runtime, which kills what its agent left running in
      // the background, and bb cannot see that work when the provider does not
      // report it. A thread still serving a port, such as a dev server, stays
      // out of policy reach until it stops.
      const settling = new Set(
        changes.flatMap((change) =>
          change.decision === "settle" ? [change.threadId] : [],
        ),
      );
      if (settling.size > 0) {
        changes = decide(
          await threadPortActions.threadsServingPorts(
            threads.filter((thread) => settling.has(thread.id)),
            threads,
          ),
        );
      }
      if (changes.length === 0) return [];
      applyPolicyChanges(changes, now);
      const changedThreadIds = changes.map((change) => change.threadId);
      bb.realtime.publish(LIFECYCLE_CHANNEL, { threadIds: changedThreadIds });
      // Outside the transaction, because releasing a runtime is a network call
      // and holding a write lock open across one would block every other write.
      await runThreadTasks(
        changes.flatMap((change) =>
          change.decision === "settle" ? [change.threadId] : [],
        ),
        async (threadId) => {
          await reclaimThreadResources(threadId);
        },
        4,
      );
      return changedThreadIds;
    })();
    const settledEvaluation = evaluation.finally(() => {
      if (policyEvaluation !== settledEvaluation) return;
      policyEvaluation = null;
      if (!policyEvaluationQueued) return;
      policyEvaluationQueued = false;
      void evaluatePolicies().catch((error) => {
        bb.log.error(
          `Queued automatic settle evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    policyEvaluation = settledEvaluation;
    return settledEvaluation;
  };

  bb.background.schedule("auto-settle", "*/5 * * * *", async () => {
    await evaluatePolicies();
  });

  bb.rpc.register(bbSidebarRpcContract, {
    getOpenPorts,
    getThreadPorts: threadPortActions.getThreadPorts,
    getThreadPullRequests: threadPullRequests.getThreadPullRequests,
    async previewSettledCleanup({ threadIds }) {
      const { byId, isProtectedWorkspace } = await cleanupContext();
      const threads: z.infer<typeof cleanupPreviewSchema>["threads"] = [];
      const skipped: CleanupIssue[] = [];
      const planned: CleanupPlanThread[] = [];
      const work = await runThreadTasks(threadIds, async (threadId) => {
        const thread = byId.get(threadId);
        if (!thread || !canCleanSettledThread(thread, readOne(threadId))) {
          skipped.push({ threadId, resource: "thread", message: "Thread is no longer in Settled or has active work" });
          return;
        }
        if (isProtectedWorkspace(thread)) return;
        let workspace: CleanupPlanThread["workspace"];
        try {
          workspace = await threadPortActions.getThreadWorkspace({ threadId });
        } catch (error) {
          skipped.push({ threadId, resource: "thread", message: `Could not verify workspace: ${cleanupError(error)}` });
          return;
        }
        const terminalIds: string[] = [];
        try {
          const { sessions } = await bb.sdk.terminals.list({ scope: { kind: "thread", threadId } });
          terminalIds.push(...sessions.filter((session) =>
            session.threadId === threadId &&
            terminalInCleanupWorkspace(session, workspace) &&
            (session.status === "running" || session.status === "starting"),
          ).map((session) => session.id));
        } catch (error) {
          skipped.push({ threadId, resource: "terminal", message: `Could not inspect terminals: ${cleanupError(error)}` });
        }
        let ports: CleanupPlanThread["ports"] = [];
        if (thread.environmentId) {
          try {
            const found = await threadPortActions.getThreadPorts({ threadId });
            ports = found.ports.filter((port) => port.processStartedAt);
            if (!sameCleanupWorkspace(workspace, found.workspace)) {
              skipped.push({ threadId, resource: "port", message: "Thread workspace changed during preview" });
              ports = [];
            }
          } catch (error) {
            skipped.push({ threadId, resource: "port", message: `Could not inspect ports: ${cleanupError(error)}` });
          }
        }
        if (terminalIds.length > 0 || ports.length > 0) {
          planned.push({ threadId, terminalIds, ports, workspace });
          threads.push({
            threadId,
            title: thread.title ?? thread.titleFallback ?? threadId,
            terminalCount: terminalIds.length,
            ports: [...new Set(ports.map((port) => port.port))],
          });
        }
      }, 4);
      skipped.push(...work.failures.map(({ threadId, error }) => ({ threadId, resource: "thread" as const, message: error })));
      const token = randomUUID();
      const now = Date.now();
      for (const [oldToken, plan] of cleanupPlans) if (plan.expiresAt <= now) cleanupPlans.delete(oldToken);
      cleanupPlans.set(token, { expiresAt: now + 2 * 60_000, threads: planned, skipped });
      const order = new Map(threadIds.map((id, index) => [id, index]));
      threads.sort((a, b) => order.get(a.threadId)! - order.get(b.threadId)!);
      return { token, threads, skipped };
    },
    async cleanSettled({ token }) {
      const plan = cleanupPlans.get(token);
      cleanupPlans.delete(token);
      if (!plan || plan.expiresAt <= Date.now()) throw new Error("Cleanup preview expired. Review the resources again.");
      const result: z.infer<typeof cleanupResultSchema> = {
        closedTerminals: 0,
        signalledPorts: [],
        remainingPorts: [],
        skipped: [...plan.skipped],
        failed: [],
      };
      const plannedById = new Map(plan.threads.map((thread) => [thread.threadId, thread]));
      const work = await runThreadTasks(plan.threads.map((thread) => thread.threadId), async (threadId) => {
        const { byId, isProtectedWorkspace } = await cleanupContext(threadId);
        const thread = byId.get(threadId);
        if (!thread || !canCleanSettledThread(thread, readOne(threadId)) || isProtectedWorkspace(thread)) {
          result.skipped.push({ threadId, resource: "thread", message: "Thread returned to Active or Working, or shares a protected workspace" });
          return;
        }
        const plannedThread = plannedById.get(threadId)!;
        if (plannedThread.terminalIds.length > 0) {
          try {
            const { sessions } = await bb.sdk.terminals.list({ scope: { kind: "thread", threadId } });
            const current = new Map(sessions.map((session) => [session.id, session]));
            for (const terminalId of plannedThread.terminalIds) {
              const latestWorkspace = await threadPortActions.getThreadWorkspace({ threadId });
              const latest = await cleanupContext(threadId);
              const latestThread = latest.byId.get(threadId);
              if (!latestThread || !canCleanSettledThread(latestThread, readOne(threadId)) ||
                  latest.isProtectedWorkspace(latestThread) ||
                  !sameCleanupWorkspace(plannedThread.workspace, latestWorkspace)) {
                result.skipped.push({ threadId, resource: "terminal", message: `Terminal ${terminalId} is now protected by active work or a shared workspace` });
                break;
              }
              const session = current.get(terminalId);
              if (!session || session.threadId !== threadId ||
                  !terminalInCleanupWorkspace(session, latestWorkspace) ||
                  (session.status !== "running" && session.status !== "starting")) {
                result.skipped.push({ threadId, resource: "terminal", message: `Terminal ${terminalId} is no longer owned by this settled thread` });
                continue;
              }
              try {
                await bb.sdk.terminals.close({ terminalId, mode: "force" });
                result.closedTerminals += 1;
              } catch (error) {
                result.failed.push({ threadId, resource: "terminal", message: `Terminal ${terminalId}: ${cleanupError(error)}` });
              }
            }
          } catch (error) {
            result.failed.push({ threadId, resource: "terminal", message: `Could not recheck terminals: ${cleanupError(error)}` });
          }
        }
        if (plannedThread.ports.length === 0) return;
        try {
          const current = await threadPortActions.getThreadPorts({ threadId });
          if (!plannedThread.workspace || !sameCleanupWorkspace(plannedThread.workspace, current.workspace)) {
            result.skipped.push({ threadId, resource: "port", message: "Thread workspace changed since preview" });
            return;
          }
          const targets = plannedThread.ports.filter((target) => current.ports.some((port) =>
            port.pid === target.pid && port.port === target.port && port.processStartedAt === target.processStartedAt,
          ));
          if (targets.length < plannedThread.ports.length) {
            result.skipped.push({ threadId, resource: "port", message: "Some previewed ports changed ownership or closed" });
          }
          if (targets.length === 0) return;
          const beforeSignal = await cleanupContext(threadId);
          const signalThread = beforeSignal.byId.get(threadId);
          if (!signalThread || !canCleanSettledThread(signalThread, readOne(threadId)) ||
              beforeSignal.isProtectedWorkspace(signalThread)) {
            result.skipped.push({ threadId, resource: "port", message: "Thread or shared workspace became active before shutdown" });
            return;
          }
          const closed = await threadPortActions.closeThreadPorts({ threadId, ports: targets, expectedWorkspace: plannedThread.workspace });
          result.signalledPorts.push(...closed.signalled.map((port) => ({ threadId, port })));
          result.skipped.push(...closed.skipped.map((port) => ({ threadId, resource: "port" as const, message: `Port :${port} changed before shutdown` })));
          result.failed.push(...closed.failed.map((port) => ({ threadId, resource: "port" as const, message: `Could not signal port :${port}` })));
          if (closed.signalled.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 750));
            const after = await threadPortActions.getThreadPorts({ threadId });
            result.remainingPorts.push(...after.ports.filter((port) => closed.signalled.includes(port.port)).map((port) => ({ threadId, port: port.port })));
          }
        } catch (error) {
          result.failed.push({ threadId, resource: "port", message: cleanupError(error) });
        }
      }, 4);
      result.failed.push(...work.failures.map(({ threadId, error }) => ({ threadId, resource: "thread" as const, message: error })));
      getOpenPorts.invalidate();
      return result;
    },
    async closeThreadPorts(input) {
      if (readOne(input.threadId)?.settledOverride !== "settled") {
        throw new Error("Thread is no longer settled");
      }
      try {
        return await threadPortActions.closeThreadPorts(input);
      } finally {
        getOpenPorts.invalidate();
      }
    },
    async stopWorkspacePort({ threadId, port }) {
      try {
        return await threadPortActions.closeThreadPorts({ threadId, ports: [port], scope: "workspace" });
      } finally {
        getOpenPorts.invalidate();
      }
    },
    async getThreadExecutionDetails({ threadId }) {
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      return options
        ? { model: options.model, reasoningLevel: options.reasoningLevel }
        : null;
    },
    async setThreadParent({ threadId, parentThreadId }) {
      return withPinParentChange(threadId, async () => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (parentThreadId === thread.parentThreadId) return { ok: true };
        // Validate the parent before unpinning: a rejected update must keep the pin.
        await bb.sdk.threads.update({ threadId, parentThreadId });
        if (parentThreadId != null && thread.pinnedAt != null) {
          try {
            await bb.sdk.threads.unpin({ threadId });
          } catch (error) {
            bb.log.error(
              `Parent updated but unpinning failed for thread ${threadId}, parent ${parentThreadId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { ok: true, unpinFailed: true as const };
          }
        }
        return { ok: true };
      });
    },
    async deleteThread({ threadId, childThreadsConfirmed }) {
      // The sidebar shows its own confirmation naming the thread and project,
      // so bb's generic one is skipped. Deletion is recursive; bb refuses it
      // unless the caller confirmed the children too.
      await bb.sdk.threads.delete({ threadId, childThreadsConfirmed });
      return { ok: true };
    },
    async archiveThreads({ threadIds }) {
      // Archive Settled in one go. The sidebar shows its own confirmation, so
      // bb's per-thread dialog is skipped. Archive takes children with it but
      // leaves an idle agent session loaded, hence the stop (see
      // releaseRuntimes); a failed stop only misses a reclaim.
      const result = await runThreadTasks(threadIds, async (threadId) => {
        await bb.sdk.threads.archive({ threadId });
        await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      });
      return { archived: result.succeededThreadIds.length, failures: result.failures };
    },
    async unarchiveThread({ threadId }) {
      await bb.sdk.threads.unarchive({ threadId });
      return { ok: true };
    },
    regenerateTitle: ({ threadId }) => regenerateTitle(threadId),
    async getSidebarSettings() {
      return readSidebarSettings();
    },
    async updateSidebarSettings(values) {
      const stored = readSidebarSettings();
      writeSidebarSettings({
        ...values,
        compactWorkingThreads:
          values.compactWorkingThreads ?? stored.compactWorkingThreads,
        workingShelf: values.workingShelf ?? stored.workingShelf,
        dockShelves: values.dockShelves ?? stored.dockShelves,
      });
      bb.realtime.publish(SIDEBAR_SETTINGS_CHANNEL, {});
      void evaluatePolicies().catch((error) => {
        bb.log.error(
          `Automatic settle evaluation failed after a settings change: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return readSidebarSettings();
    },
    async listLifecycle() {
      return { rows: readAll() };
    },
    async pin({ threadId }) {
      return withPinParentChange(threadId, async () => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.parentThreadId != null) {
          throw new Error("Child threads cannot be pinned");
        }
        // Preserve the previous shelf if the native pin fails.
        await bb.sdk.threads.pin({ threadId });
        write({
          threadId,
          parkedAt: null,
          settledAt: null,
          settledOverride: "active",
          snoozedUntil: null,
          snoozedAt: null,
        });
        return { ok: true };
      });
    },
    async park({ threadId }) {
      await bb.sdk.threads.unpin({ threadId });
      write({
        threadId,
        parkedAt: Date.now(),
        settledAt: null,
        settledOverride: null,
        snoozedUntil: null,
        snoozedAt: null,
      });
      return { ok: true, reclaim: await reclaimThreadResources(threadId) };
    },
    async resume({ threadId }) {
      write({
        threadId,
        settledAt: null,
        settledOverride: "active",
        snoozedUntil: null,
        snoozedAt: null,
      });
      return { ok: true };
    },
    async settle({ threadId }) {
      // Native pinning and this plugin's settled shelf are competing ways to
      // keep a thread out of the ordinary inbox. Settling wins, and a failed
      // unpin leaves the lifecycle row untouched instead of half-applying it.
      await bb.sdk.threads.unpin({ threadId });
      // Settling clears any snooze: they are two answers to the same
      // question, and holding both would make the shelf order ambiguous.
      const now = Date.now();
      write({
        threadId,
        settledAt: now,
        settledOverride: "settled",
        snoozedUntil: null,
        snoozedAt: null,
      });
      // The shelf move is durable before anything is released, so a slow or
      // unreachable host delays the reminder without holding up the settle.
      return { ok: true, reclaim: await reclaimThreadResources(threadId) };
    },
    async unsettle({ threadId }) {
      const current = readOne(threadId);
      write({
        threadId,
        settledAt: null,
        settledOverride: "active",
        snoozedUntil: current?.snoozedUntil ?? null,
        snoozedAt: current?.snoozedAt ?? null,
      });
      return { ok: true };
    },
    async snooze({ threadId, snoozedUntil }) {
      await bb.sdk.threads.unpin({ threadId });
      const now = Date.now();
      write({
        threadId,
        settledAt: null,
        settledOverride: null,
        snoozedUntil,
        snoozedAt: now,
      });
      // A snooze is a parked thread with a return date, and the shortest
      // preset is half an hour. Nobody snoozes a conversation they are in the
      // middle of, so the wake time is not worth keeping a runtime warm for.
      return { ok: true, reclaim: await reclaimThreadResources(threadId) };
    },
    async releaseRuntimes({ threadIds }) {
      // bb's archive force-closes a thread's terminals but only stops its
      // runtime when a turn is in flight, so an idle thread archived from this
      // sidebar keeps its agent session loaded. Stopping an idle thread takes
      // bb's release path instead. Archived threads still accept a stop, so
      // this can race the archive, and a failure only misses a reclaim.
      await runThreadTasks(
        threadIds,
        async (threadId) => {
          await bb.sdk.threads.stop({ threadId });
        },
        4,
      );
      return { ok: true };
    },
    async unsnooze({ threadId }) {
      clear(threadId);
      return { ok: true };
    },
    async acknowledgeWake({ threadId }) {
      // A woken snooze row is retained only to make the marker durable. Once
      // the user opens or dismisses it, the thread is ordinary active work.
      clear(threadId);
      return { ok: true };
    },
    async reorderPinned({ threadId, previousThreadId, nextThreadId }) {
      const reordered = await bb.sdk.threads.reorderPinned({
        threadId,
        previousThreadId,
        nextThreadId,
      });
      return {
        pinnedThreadIds: reordered
          .filter((thread) => thread.pinnedAt !== null)
          .map((thread) => thread.id),
      };
    },
    async listInboxOrder() {
      return { inboxThreadIds: readInboxOrder() };
    },
    async reorderInbox({ inboxThreadIds }) {
      replaceInboxOrder(inboxThreadIds);
      bb.realtime.publish(INBOX_ORDER_CHANNEL, {});
      return { inboxThreadIds: readInboxOrder() };
    },
    async evaluateAutoSettle() {
      return { changedThreadIds: await evaluatePolicies() };
    },
    async listProjectIconSettings() {
      const projects = await bb.sdk.projects.list();
      return {
        projects: projects
          .filter((project) => project.kind === "standard")
          .map((project) => ({
            id: project.id,
            name: project.name,
            customPath: readProjectIconOverride(project.id),
            customUploadName:
              readProjectIconUpload(project.id)?.filename ?? null,
          })),
      };
    },
    async listProjects() {
      const projects = await bb.sdk.projects.list();
      return {
        projects: projects
          .filter((project) => project.kind === "standard")
          .map((project) => ({ id: project.id, name: project.name })),
      };
    },
    async renameProject({ projectId, name }) {
      const project = await bb.sdk.projects.get({ projectId });
      if (project.kind !== "standard") throw new Error("Personal projects cannot be renamed");
      await bb.sdk.projects.update({ projectId, name });
      bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { ok: true as const };
    },
    async projectPathHosts({ projectId }) {
      const project = await bb.sdk.projects.get({ projectId });
      if (project.kind !== "standard") return { hosts: [] };
      const hosts = await bb.sdk.hosts.list();
      return {
        hosts: hosts.filter((host) => host.status === "connected" &&
          !project.sources.some((source) => source.hostId === host.id))
          .map(({ id, name }) => ({ id, name })),
      };
    },
    async addProjectPath({ projectId, hostId, path }) {
      const project = await bb.sdk.projects.get({ projectId });
      if (project.kind !== "standard") throw new Error("Personal projects cannot have local paths added");
      if (project.sources.some((source) => source.hostId === hostId)) {
        throw new Error("This project already has a path on that machine");
      }
      await bb.sdk.projects.sources.add({ projectId, hostId, path, type: "local_path" });
      defaultProjectHostIds.delete(projectId);
      bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { ok: true as const };
    },
    async removeProject({ projectId, confirmation }) {
      const project = await bb.sdk.projects.get({ projectId });
      if (project.kind !== "standard") {
        throw new Error("Personal projects cannot be removed");
      }
      if (confirmation !== project.name) {
        throw new Error("Enter the project name exactly as shown");
      }

      await bb.sdk.projects.delete({ projectId });
      db.transaction(() => {
        db.prepare(`DELETE FROM project_icons WHERE project_id = ?`).run(
          projectId,
        );
        db.prepare(
          `DELETE FROM project_icon_uploads WHERE project_id = ?`,
        ).run(projectId);
      })();
      defaultProjectHostIds.delete(projectId);
      clearProjectIconCache(projectId);
      bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { ok: true as const };
    },
    async searchProjectIconFiles({ projectId, query }) {
      const hostId = await defaultProjectHostId(projectId);
      const request = {
        projectId,
        includeFiles: "true" as const,
        includeDirectories: "false" as const,
        limit: "100",
        query,
      };
      const result = hostId
        ? await bb.sdk.projects.paths({ ...request, hostId })
        : await bb.sdk.projects.paths(request);
      return {
        paths: [
          ...new Set(
            result.paths.flatMap((entry) => {
              if (entry.kind !== "file") return [];
              const path = normalizeProjectIconPath(entry.path);
              return path ? [path] : [];
            }),
          ),
        ].slice(0, 30),
      };
    },
    async setProjectIcon({ projectId, path }) {
      await bb.sdk.projects.get({ projectId });
      const normalized = path === null ? null : normalizeProjectIconPath(path);
      if (path !== null && normalized === null) {
        throw new Error("Choose a relative image path inside the project");
      }
      if (normalized === null) {
        db.transaction(() => {
          db.prepare(`DELETE FROM project_icons WHERE project_id = ?`).run(
            projectId,
          );
          db.prepare(
            `DELETE FROM project_icon_uploads WHERE project_id = ?`,
          ).run(projectId);
        })();
      } else {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO project_icons (project_id, path, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               path = excluded.path,
               updated_at = excluded.updated_at`,
          ).run(projectId, normalized, Date.now());
          db.prepare(
            `DELETE FROM project_icon_uploads WHERE project_id = ?`,
          ).run(projectId);
        })();
      }
      clearProjectIconCache(projectId);
      bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { customPath: normalized, customUploadName: null };
    },
    async uploadProjectIcon({
      projectId,
      filename,
      mimeType,
      contentBase64,
    }) {
      await bb.sdk.projects.get({ projectId });
      const bytes = Buffer.from(contentBase64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > PROJECT_ICON_MAX_BYTES) {
        throw new Error("Choose an image smaller than 1 MB");
      }
      const normalizedFilename = filename.trim();
      const canonicalBase64 = bytes.toString("base64");
      if (canonicalBase64 !== contentBase64) {
        throw new Error("The selected image data is invalid");
      }
      const resolvedMimeType = iconMimeType(normalizedFilename, mimeType);
      db.transaction(() => {
        db.prepare(
          `INSERT INTO project_icon_uploads (
             project_id, filename, mime_type, content_base64,
             size_bytes, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             filename = excluded.filename,
             mime_type = excluded.mime_type,
             content_base64 = excluded.content_base64,
             size_bytes = excluded.size_bytes,
             updated_at = excluded.updated_at`,
        ).run(
          projectId,
          normalizedFilename,
          resolvedMimeType,
          canonicalBase64,
          bytes.byteLength,
          Date.now(),
        );
        db.prepare(`DELETE FROM project_icons WHERE project_id = ?`).run(
          projectId,
        );
      })();
      clearProjectIconCache(projectId);
      bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return {
        customPath: null,
        customUploadName: normalizedFilename,
      };
    },
  });

  // Real work clears both kinds of manual settle override. The next quiet
  // period can then be judged against the current policies.
  bb.events.on("thread.active", ({ thread }) => {
    clearSettlingState(thread.id);
  });

  // A deleted thread must not leave a row behind that would park a future
  // thread reusing the id, and stale rows accumulate otherwise.
  bb.events.on("thread.deleted", ({ thread }) => {
    clear(thread.id);
    const removed = db
      .prepare(`DELETE FROM inbox_order WHERE thread_id = ?`)
      .run(thread.id);
    if (removed.changes > 0) {
      bb.realtime.publish(INBOX_ORDER_CHANNEL, {});
    }
  });
}
