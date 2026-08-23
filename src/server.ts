// bb-plugin-t3chat-sidebar backend: the settled and snoozed store.
//
// This state lives in the plugin's own SQLite database, never on bb's thread.
// Putting it on the thread would mean a schema change, a wire change, and a
// HOST_DAEMON_PROTOCOL_VERSION bump for something only this sidebar
// understands. Here, uninstalling the plugin removes its state with it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  decideAutoSettle,
  parseAutoSettleAfterDays,
  type AutoSettlePullRequest,
  type SettledOverride,
} from "./auto-settle";

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
];

export interface StoredLifecycleRow {
  threadId: string;
  settledAt: number | null;
  settledOverride: SettledOverride | null;
  snoozedUntil: number | null;
  snoozedAt: number | null;
}

interface LifecycleDbRow {
  thread_id: string;
  settled_at: number | null;
  settled_override: SettledOverride | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
}

const threadIdSchema = z.object({ threadId: z.string().trim().min(1) });
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

export const t3chatSidebarRpcContract = defineRpcContract({
  listLifecycle: {
    input: z.object({}),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          settledAt: z.number().nullable(),
          settledOverride: z.enum(["active", "settled"]).nullable().optional(),
          snoozedUntil: z.number().nullable(),
          snoozedAt: z.number().nullable(),
        }),
      ),
    }),
  },
  settle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  unsettle: { input: threadIdSchema, output: z.object({ ok: z.boolean() }) },
  snooze: {
    input: z.object({
      threadId: z.string().trim().min(1),
      // Absolute wake time, so a snooze means the same thing on every device.
      snoozedUntil: z.number().int().positive(),
    }),
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
});

/** Channel the frontend re-reads on. */
export const LIFECYCLE_CHANNEL = "lifecycle";
export const INBOX_ORDER_CHANNEL = "inbox-order";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    snoozePresets: {
      type: "string",
      label: "Snooze presets (examples: 15m, 2h, Lunch=3h, 1d)",
      default: "30m, 2h, 1d, 1w",
    },
    autoSettleInactive: {
      type: "boolean",
      label: "Auto-settle inactive threads",
      default: true,
    },
    autoSettleAfterDays: {
      type: "string",
      label: "Days of inactivity before auto-settle (1-90)",
      default: "3",
    },
    autoSettleOnMerge: {
      type: "boolean",
      label: "Auto-settle when a pull request merges",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const readAll = (): StoredLifecycleRow[] =>
    (
      db
        .prepare(
          `SELECT thread_id, settled_at, settled_override,
                  snoozed_until, snoozed_at
             FROM thread_lifecycle`,
        )
        .all() as LifecycleDbRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      settledAt: row.settled_at,
      settledOverride: row.settled_override,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
    }));

  const readOne = (threadId: string): StoredLifecycleRow | null => {
    const row = db
      .prepare(
        `SELECT thread_id, settled_at, settled_override,
                snoozed_until, snoozed_at
           FROM thread_lifecycle
          WHERE thread_id = ?`,
      )
      .get(threadId) as LifecycleDbRow | undefined;
    return row
      ? {
          threadId: row.thread_id,
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
         (thread_id, settled_at, settled_override, snoozed_until, snoozed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         settled_override = excluded.settled_override,
         snoozed_until = excluded.snoozed_until,
         snoozed_at = excluded.snoozed_at`,
    ).run(
      row.threadId,
      row.settledAt,
      row.settledOverride,
      row.snoozedUntil,
      row.snoozedAt,
    );
    if (publish) {
      bb.realtime.publish(LIFECYCLE_CHANNEL, { threadId: row.threadId });
    }
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
      (row.settledAt === null && row.settledOverride === null)
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

  const loadPolicyThreads = async () => {
    const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await bb.sdk.threads.list({
        archived: false,
        includeHidden: false,
        limit: pageSize,
        offset,
      });
      threads.push(...page);
      if (page.length < pageSize) break;
    }
    return threads;
  };

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
  const evaluatePolicies = (): Promise<string[]> => {
    if (policyEvaluation !== null) return policyEvaluation;
    policyEvaluation = (async () => {
      const [configured, threads] = await Promise.all([
        settings.get(),
        loadPolicyThreads(),
      ]);
      const environmentIds = [
        ...new Set(
          threads.flatMap((thread) =>
            thread.environmentId === null ? [] : [thread.environmentId],
          ),
        ),
      ];
      const pullRequests = await loadPullRequests(environmentIds);
      const lifecycleByThreadId = new Map(
        readAll().map((row) => [row.threadId, row]),
      );
      const now = Date.now();
      const policySettings = {
        afterDays: parseAutoSettleAfterDays(
          configured.autoSettleInactive,
          configured.autoSettleAfterDays,
        ),
        onMerge: configured.autoSettleOnMerge,
      };
      const changes = threads.flatMap((thread) => {
        const row = lifecycleByThreadId.get(thread.id) ?? null;
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
      if (changes.length === 0) return [];
      applyPolicyChanges(changes, now);
      const changedThreadIds = changes.map((change) => change.threadId);
      bb.realtime.publish(LIFECYCLE_CHANNEL, { threadIds: changedThreadIds });
      return changedThreadIds;
    })().finally(() => {
      policyEvaluation = null;
    });
    return policyEvaluation;
  };

  settings.onChange(() => {
    void evaluatePolicies().catch((error) => {
      bb.log.error(
        `Automatic settle evaluation failed after a settings change: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  bb.background.schedule("auto-settle", "*/5 * * * *", async () => {
    await evaluatePolicies();
  });

  bb.rpc.register(t3chatSidebarRpcContract, {
    async listLifecycle() {
      return { rows: readAll() };
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
      return { ok: true };
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
      const now = Date.now();
      write({
        threadId,
        settledAt: null,
        settledOverride: null,
        snoozedUntil,
        snoozedAt: now,
      });
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
