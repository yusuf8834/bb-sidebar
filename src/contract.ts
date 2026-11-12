import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizeProjectIconPath } from "./project-icons";
import {
  CHILD_THREAD_SORT_FIELDS,
  CHILD_THREAD_SORT_DIRECTIONS,
  CHILD_THREAD_ICON_STYLES,
  PROJECT_COLOR_DISPLAYS,
  THREAD_DISPLAYS,
} from "./sidebar-settings-values";
import { configuredSnoozePresetError } from "./lifecycle";
export {
  LIFECYCLE_CHANNEL,
  INBOX_ORDER_CHANNEL,
  SIDEBAR_SETTINGS_CHANNEL,
  PROJECT_COLORS_CHANNEL,
  PROJECT_ICONS_CHANNEL,
  RATE_LIMITS_CHANNEL,
} from "./realtime-channels";

export const openPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  processName: z.string().optional(),
  pid: z.number().int().optional(),
  address: z.string().optional(),
  source: z.enum(["process", "docker"]).optional(),
  container: z.string().optional(),
  service: z.string().optional(),
  ownerThreadId: z.string().optional(),
  processStartedAt: z.string().min(1).optional(),
});
export type OpenPort = z.infer<typeof openPortSchema>;

const portSnapshotSchema = z.object({
  groups: z.array(
    z.object({
      environmentId: z.string(),
      ports: z.array(openPortSchema),
    }),
  ),
});

export type PortSnapshot = z.infer<typeof portSnapshotSchema>;

export const threadPullRequestSchema = z
  .object({
    url: z.string(),
    number: z.number().int(),
    title: z.string().nullable(),
    state: z.enum(["open", "draft", "merged", "closed"]).nullable(),
  })
  .strict();
export type ThreadPullRequest = z.infer<typeof threadPullRequestSchema>;

export const ownedPortTargetSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().min(2),
  processStartedAt: z.string().min(1).optional(),
});
export const closePortsResultSchema = z.object({
  signalled: z.array(z.number()),
  skipped: z.array(z.number()),
  failed: z.array(z.number()),
});
export const portCloseScopeSchema = z.enum(["thread", "workspace"]);
export type OwnedPortTarget = z.infer<typeof ownedPortTargetSchema>;
export type PortCloseScope = z.infer<typeof portCloseScopeSchema>;

export type ClosePortsResult = z.infer<typeof closePortsResultSchema>;

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });
const threadLimitStateSchema = z.object({
  message: z.string(),
  resetsAt: z.number().nullable(),
  timeZone: z.string().nullable(),
  scheduled: z.object({ id: z.string(), sendAt: z.number(), failed: z.boolean() }).nullable(),
});
export type ThreadLimitState = z.infer<typeof threadLimitStateSchema>;

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
export const cleanupIssueSchema = z.object({
  threadId: z.string(),
  resource: z.enum(["thread", "terminal", "port"]),
  message: z.string(),
});
export const cleanupPreviewSchema = z.object({
  token: z.string(),
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      terminalCount: z.number().int().nonnegative(),
      ports: z.array(z.number().int()),
    }),
  ),
  skipped: z.array(cleanupIssueSchema),
});
export const cleanupResultSchema = z.object({
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
export const sidebarSettingsSchema = z
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
    threadDisplay: z.enum(THREAD_DISPLAYS),
    compactProjectIconOnly: z.boolean(),
    keepPinnedThreadsFull: z.boolean(),
    keepWokeThreadsFull: z.boolean(),
    compactWorkingThreads: z.boolean(),
    workingShelf: z.boolean(),
    dockShelves: z.boolean(),
    projectColorsEnabled: z.boolean(),
    projectColorDisplay: z.enum(PROJECT_COLOR_DISPLAYS),
  })
  .strict();
const uploadFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (filename) => !filename.includes("/") && !filename.includes("\\") && normalizeProjectIconPath(filename) !== null,
    { message: "Choose a supported image file" },
  );
const iconBase64Schema = z
  .string()
  .min(1)
  .max(1_400_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Invalid image data");
export const bbSidebarRpcContract = defineRpcContract({
  getThreadLimits: {
    input: z.object({ keys: z.array(z.string().trim().min(1)).max(1000) }).strict(),
    output: z.record(z.string(), threadLimitStateSchema.nullable()),
  },
  scheduleLimitContinue: {
    input: threadIdSchema.extend({ sendAt: z.number().int().positive().optional() }).strict(),
    output: threadLimitStateSchema,
  },
  cancelLimitContinue: {
    input: threadIdSchema.extend({ queuedMessageId: z.string().trim().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
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
  // The app names the workspaces to scan: those of live threads on its poll,
  // or one settled thread's when the user looks at it, 500 per call (the app
  // splits longer lists). An app bundle older than the backend still sends
  // `{}`; that is rejected like any bad input, and its catch clears the port
  // badges until the new bundle loads.
  getOpenPorts: {
    input: z.object({ environmentIds: z.array(z.string().trim().min(1)).min(1).max(500) }).strict(),
    output: portSnapshotSchema,
  },
  getThreadPullRequests: {
    input: threadIdSchema.strict(),
    output: z.object({ pullRequests: z.array(threadPullRequestSchema) }).strict(),
  },
  getThreadExecutionDetails: {
    input: threadIdSchema.strict(),
    output: z
      .object({
        model: z.string(),
        modelDisplayName: z.string().optional(),
        reasoningLabel: z.string().optional(),
        reasoningLevel: z.string(),
      })
      .strict()
      .nullable(),
  },
  setThreadParent: {
    input: threadIdSchema.extend({ parentThreadId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ ok: z.boolean(), unpinFailed: z.literal(true).optional() }),
  },
  deleteThread: {
    input: threadIdSchema.extend({ childThreadsConfirmed: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  regenerateTitle: {
    input: threadIdSchema.strict(),
    output: z.object({ title: z.string().min(1).max(100) }).strict(),
  },
  getProjectColors: {
    input: z.object({}).strict(),
    output: z.object({ colors: z.record(z.string(), z.string()) }),
  },
  setProjectColor: {
    input: z
      .object({
        projectId: z.string().trim().min(1),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .transform((value) => value.toLowerCase())
          .nullable(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  getSidebarSettings: {
    input: z.object({}).strict(),
    output: sidebarSettingsSchema,
  },
  updateSidebarSettings: {
    // Save only edited fields. Full payloads from older clients remain valid.
    input: sidebarSettingsSchema.partial(),
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
    output: z.object({ ok: z.boolean(), reclaim: reclaimSchema, undoToken: z.string().uuid() }),
  },
  park: {
    input: threadIdSchema,
    output: z.object({ ok: z.boolean(), reclaim: reclaimSchema }),
  },
  resume: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  unsettle: {
    input: threadIdSchema.extend({ undoToken: z.string().uuid().optional() }),
    output: z.object({ ok: z.boolean() }),
  },
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
    input: z
      .object({
        projectId: projectIdSchema,
        hostId: z.string().trim().min(1),
        path: z.string().trim().min(1).max(4096),
      })
      .strict(),
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
