import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { createFakePluginHost, disposers, projectThread, projectsWith, type ProjectThread } from "./test-server";

const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 10, 19, 12);

type GitRow = Record<string, unknown> | undefined;
const clean: GitRow = {
  outcome: "available",
  workspace: { workingTree: { hasUncommittedChanges: false, state: "clean" } },
};
const dirty: GitRow = {
  outcome: "available",
  workspace: { workingTree: { hasUncommittedChanges: true, state: "dirty_uncommitted" } },
};

afterEach(() => vi.useRealTimers());

interface Row {
  threadId: string;
  settledAt?: number | null;
  settledOverride?: "active" | "settled" | null;
  snoozedUntil?: number | null;
  parkedAt?: number | null;
}

async function setup({
  threads,
  rows = [],
  enable = true,
  days = 30,
  // Most tests check the rule against real settle times; fresh start has its own tests.
  includeSettled = true,
  git = () => clean,
  archive,
}: {
  threads: ProjectThread[];
  rows?: Row[];
  enable?: boolean;
  days?: number;
  includeSettled?: boolean;
  git?: (environmentId: string) => GitRow;
  archive?: (threadId: string) => Promise<string[]>;
}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  let current = threads;
  const archived: string[] = [];
  const gitKeys: string[][] = [];
  const callRpc = (async ({ pluginId, method, input, outputSchema }) => {
    if (pluginId !== "bb--git" || method !== "status") throw new Error(`Unexpected RPC ${pluginId}.${method}`);
    const { keys } = input as { keys: string[] };
    gitKeys.push(keys);
    return outputSchema.parse(Object.fromEntries(keys.map((key) => [key, git(key)])));
  }) as BbPluginApi["sdk"]["plugins"]["callRpc"];
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      plugins: { callRpc },
      projects: { list: async () => projectsWith(current.filter((thread) => thread.archivedAt === null)) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        archive: async ({ threadId }) => {
          const ids = archive
            ? await archive(threadId)
            : current.filter((t) => t.id === threadId || t.parentThreadId === threadId).map((t) => t.id);
          archived.push(threadId);
          current = current.map((thread) => (ids.includes(thread.id) ? { ...thread, archivedAt: Date.now() } : thread));
          return { ok: true as const, archivedThreadIds: ids };
        },
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  for (const row of rows) {
    db.prepare(
      `INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      row.threadId,
      row.settledAt ?? null,
      row.settledOverride ?? null,
      row.snoozedUntil ?? null,
      row.snoozedUntil ? NOW - 2 * DAY : null,
      row.parkedAt ?? null,
    );
  }
  if (enable) {
    await harness.behavior.callRpc("updateSidebarSettings", {
      autoArchiveSettled: true,
      autoArchiveAfterDays: days,
      autoArchiveIncludeSettled: includeSettled,
    });
  }
  const listings = () => harness.inspection.sdk.callsTo("projects.list").length;
  return {
    bb,
    harness,
    db,
    archived,
    gitKeys,
    listings,
    run: () => harness.behavior.runSchedule("auto-archive"),
    advance: (ms: number) => vi.setSystemTime(Date.now() + ms),
    setThreads: (next: ProjectThread[]) => {
      current = next;
    },
  };
}

const quiet = (id: string, extra: Partial<ProjectThread> = {}) =>
  projectThread({ id, createdAt: 1, updatedAt: 1, latestAttentionAt: 1, lastReadAt: 1, ...extra });
const settledFor = (threadId: string, days: number, extra: Partial<Row> = {}): Row => ({
  threadId,
  settledAt: NOW - days * DAY,
  ...extra,
});

describe("auto-archive settings", () => {
  it("is off with 30 days on a new install, and the job does nothing while off", async () => {
    const t = await setup({ threads: [quiet("old")], rows: [settledFor("old", 400)], enable: false });
    await expect(t.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      autoArchiveSettled: false,
      autoArchiveAfterDays: 30,
    });
    await t.run();
    expect(t.archived).toEqual([]);
    expect(t.listings()).toBe(0);
    expect(t.gitKeys).toEqual([]);
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM auto_archive_state`).get()).toEqual({ n: 0 });
  });

  it("runs once a day, on its own schedule", async () => {
    const t = await setup({ threads: [], enable: false });
    expect(t.harness.inspection.registrations.schedules).toContainEqual(
      expect.objectContaining({ name: "auto-archive", cron: "23 4 * * *" }),
    );
  });

  it("loads settings saved by an older version with the rule off", async () => {
    const t = await setup({ threads: [quiet("old")], rows: [settledFor("old", 400)], enable: false });
    const { autoArchiveSettled: _on, autoArchiveAfterDays: _days, ...older } = DEFAULT_SIDEBAR_SETTINGS;
    t.db
      .prepare(`UPDATE sidebar_settings SET settings_json = ? WHERE id = 1`)
      .run(JSON.stringify({ ...older, autoSettleInactive: true }));
    await expect(t.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      autoSettleInactive: true,
      autoArchiveSettled: false,
      autoArchiveAfterDays: 30,
    });
    await t.run();
    expect(t.archived).toEqual([]);
  });

  it("rejects a day count outside 1 to 365", async () => {
    const t = await setup({ threads: [], enable: false });
    for (const days of [0, 366, 1.5]) {
      await expect(
        t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveAfterDays: days }),
      ).rejects.toThrow();
    }
  });

  it("stops archiving once turned off", async () => {
    const t = await setup({ threads: [quiet("a"), quiet("b")], rows: [settledFor("a", 40), settledFor("b", 40)] });
    await t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveSettled: false });
    await t.run();
    expect(t.archived).toEqual([]);
    expect(t.listings()).toBe(0);
  });
});

describe("auto-archive clock", () => {
  it("archives only threads settled at least N days ago", async () => {
    const t = await setup({
      threads: [quiet("old"), quiet("recent")],
      rows: [settledFor("old", 31), settledFor("recent", 29)],
    });
    await t.run();
    expect(t.archived).toEqual(["old"]);
    await t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveAfterDays: 10 });
    t.advance(7 * HOUR);
    await t.run();
    expect(t.archived).toEqual(["old", "recent"]);
  });

  it("counts from when the rule first sees a settle with no usable time", async () => {
    const t = await setup({ threads: [quiet("skewed")], rows: [settledFor("skewed", -3)], days: 1 });
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(DAY - HOUR);
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(HOUR);
    await t.run();
    expect(t.archived).toEqual(["skewed"]);
  });

  it("counts from the newest settle in the tree", async () => {
    const t = await setup({
      threads: [quiet("parent"), quiet("child", { parentThreadId: "parent" })],
      rows: [settledFor("parent", 40), settledFor("child", 5)],
    });
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(25 * DAY);
    await t.run();
    expect(t.archived).toEqual(["parent"]);
  });

  it("gives a thread back from the archive a new wait", async () => {
    const t = await setup({ threads: [quiet("back")], rows: [settledFor("back", 40)] });
    await t.run();
    expect(t.archived).toEqual(["back"]);
    t.setThreads([quiet("back")]);
    await t.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "back" }),
    } as never);
    t.advance(8 * DAY);
    await t.run();
    expect(t.archived).toEqual(["back"]);
    t.advance(23 * DAY);
    await t.run();
    expect(t.archived).toEqual(["back", "back"]);
  });

  it("gives a new wait to a thread the user archived by hand", async () => {
    const t = await setup({ threads: [quiet("manual", { archivedAt: NOW - DAY })], rows: [settledFor("manual", 40)] });
    t.setThreads([quiet("manual")]);
    await t.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "manual" }),
    } as never);
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(31 * DAY);
    await t.run();
    expect(t.archived).toEqual(["manual"]);
  });

  it("gives a new wait to a child unarchived on its own after its tree was archived", async () => {
    const t = await setup({
      threads: [quiet("p"), quiet("c", { parentThreadId: "p" })],
      rows: [settledFor("p", 40), settledFor("c", 40)],
    });
    await t.run();
    expect(t.archived).toEqual(["p"]);
    t.setThreads([quiet("p", { archivedAt: NOW }), quiet("c", { parentThreadId: "p" })]);
    await t.harness.behavior.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "c", parentThreadId: "p" }),
    } as never);
    t.advance(7 * HOUR);
    await t.run();
    expect(t.archived).toEqual(["p"]);
  });

  it("restarts the wait when it finds an unarchived thread without the event", async () => {
    const t = await setup({ threads: [quiet("back")], rows: [settledFor("back", 40)] });
    await t.run();
    t.setThreads([quiet("back")]);
    t.advance(8 * DAY);
    await t.run();
    t.advance(29 * DAY);
    await t.run();
    expect(t.archived).toEqual(["back"]);
    t.advance(2 * DAY);
    await t.run();
    expect(t.archived).toEqual(["back", "back"]);
  });
});

describe("auto-archive exclusions", () => {
  it.each<[string, ProjectThread[], Row[]]>([
    [
      "a pinned thread settled by hand",
      [quiet("t", { pinnedAt: 5 })],
      [settledFor("t", 40, { settledOverride: "settled" })],
    ],
    ["a thread with a running turn", [quiet("t", { status: "active" })], [settledFor("t", 40)]],
    ["a thread waiting on an answer", [quiet("t", { hasPendingInteraction: true })], [settledFor("t", 40)]],
    [
      "a thread with new attention since its settle",
      [quiet("t", { latestAttentionAt: NOW - DAY })],
      [settledFor("t", 40)],
    ],
    ["a thread the user moved to Active", [quiet("t")], [{ threadId: "t", settledOverride: "active" }]],
    ["a snoozed thread", [quiet("t")], [{ threadId: "t", snoozedUntil: NOW + DAY }]],
    [
      "a parent with a working child",
      [quiet("p"), quiet("c", { parentThreadId: "p", activity: { ...quiet("x").activity, activeWorkflowCount: 1 } })],
      [settledFor("p", 40), settledFor("c", 40)],
    ],
    [
      "a parent with a pinned child",
      [quiet("p"), quiet("c", { parentThreadId: "p", pinnedAt: 3 })],
      [settledFor("p", 40)],
    ],
    [
      "a parent with a child the user woke",
      [quiet("p"), quiet("c", { parentThreadId: "p" })],
      [settledFor("p", 40), { threadId: "c", settledOverride: "active" }],
    ],
    [
      "a parent whose child has news since the settle",
      [quiet("p"), quiet("c", { parentThreadId: "p", latestAttentionAt: NOW - DAY })],
      [settledFor("p", 40)],
    ],
    [
      "a settled child inside an Active parent",
      [quiet("p"), quiet("c", { parentThreadId: "p" })],
      [settledFor("c", 40)],
    ],
    [
      "a parent with a hidden fork still working",
      [quiet("p"), quiet("fork", { visibility: "hidden", sourceThreadId: "p", status: "active" })],
      [settledFor("p", 40)],
    ],
  ])("keeps %s", async (_, threads, rows) => {
    const t = await setup({ threads, rows });
    await t.run();
    expect(t.archived).toEqual([]);
  });

  it("archives a settled parent with its quiet row-less child in one call", async () => {
    const t = await setup({
      threads: [quiet("p"), quiet("c", { parentThreadId: "p" })],
      rows: [settledFor("p", 40)],
    });
    await t.run();
    expect(t.archived).toEqual(["p"]);
  });

  it("does not list threads again on every pass for a due thread it must keep", async () => {
    const t = await setup({
      threads: [quiet("t", { pinnedAt: 5 })],
      rows: [settledFor("t", 40, { settledOverride: "settled" })],
    });
    await t.run();
    t.advance(HOUR);
    await t.run();
    expect(t.listings()).toBe(1);
    t.advance(6 * HOUR);
    await t.run();
    expect(t.listings()).toBe(2);
  });
});

describe("auto-archive workspaces", () => {
  it.each<[string, GitRow]>([
    ["uncommitted changes", dirty],
    [
      "only untracked files",
      { outcome: "available", workspace: { workingTree: { hasUncommittedChanges: false, state: "untracked" } } },
    ],
    ["no status from bb", { outcome: "unavailable", failure: {} }],
    ["a non-Git workspace", { outcome: "not_applicable", reason: "non_git_environment", message: "x" }],
    ["no row at all", undefined],
  ])("keeps a thread whose workspace has %s", async (_, row) => {
    const t = await setup({
      threads: [quiet("t", { environmentId: "env_t" })],
      rows: [settledFor("t", 40)],
      git: () => row,
    });
    await t.run();
    expect(t.gitKeys).toEqual([["env_t"]]);
    expect(t.archived).toEqual([]);
  });

  it("checks every workspace the archive would retire, children included", async () => {
    const t = await setup({
      threads: [quiet("p", { environmentId: "env_p" }), quiet("c", { parentThreadId: "p", environmentId: "env_c" })],
      rows: [settledFor("p", 40)],
      git: (id) => (id === "env_c" ? dirty : clean),
    });
    await t.run();
    expect(t.gitKeys.flat().sort()).toEqual(["env_c", "env_p"]);
    expect(t.archived).toEqual([]);
  });

  it("archives once the workspace is clean, without checking it every pass", async () => {
    let row = dirty;
    const t = await setup({
      threads: [quiet("t", { environmentId: "env_t" })],
      rows: [settledFor("t", 40)],
      git: () => row,
    });
    await t.run();
    t.advance(HOUR);
    await t.run();
    expect(t.gitKeys).toHaveLength(1);
    row = clean;
    t.advance(6 * HOUR);
    await t.run();
    expect(t.archived).toEqual(["t"]);
  });

  it("checks a workspace shared by two due trees instead of letting each vouch for the other", async () => {
    const t = await setup({
      threads: [quiet("a", { environmentId: "env_shared" }), quiet("b", { environmentId: "env_shared" })],
      rows: [settledFor("a", 40), settledFor("b", 40)],
      git: () => dirty,
    });
    await t.run();
    expect(t.gitKeys).toEqual([["env_shared"]]);
    expect(t.archived).toEqual([]);
  });

  it("skips the check for a workspace that a live thread keeps", async () => {
    const t = await setup({
      threads: [quiet("t", { environmentId: "env_shared" }), quiet("live", { environmentId: "env_shared" })],
      rows: [settledFor("t", 40)],
      git: () => dirty,
    });
    await t.run();
    expect(t.gitKeys).toEqual([]);
    expect(t.archived).toEqual(["t"]);
  });
});

describe("auto-archive failures", () => {
  it("retries a failed archive with backoff and gives up after five attempts", async () => {
    let calls = 0;
    const t = await setup({
      threads: [quiet("t")],
      rows: [settledFor("t", 40)],
      archive: async () => {
        calls += 1;
        throw new Error("bb refused");
      },
    });
    for (let pass = 0; pass < 48; pass += 1) {
      await t.run();
      t.advance(HOUR);
    }
    expect(calls).toBe(5);
    const warnings = t.harness.inspection.logEntries.filter((entry) => entry.message.includes("Auto-archive"));
    expect(warnings).toHaveLength(5);
    expect(warnings.at(-1)?.message).toContain("gave up on t after 5 failed attempts");
  });

  it("starts over when the thread settles again", async () => {
    let fail = true;
    const t = await setup({
      threads: [quiet("t")],
      rows: [settledFor("t", 40)],
      archive: async (id) => {
        if (fail) throw new Error("bb refused");
        return [id];
      },
    });
    for (let pass = 0; pass < 40; pass += 1) {
      await t.run();
      t.advance(HOUR);
    }
    fail = false;
    t.db.prepare(`UPDATE thread_lifecycle SET settled_at = ? WHERE thread_id = 't'`).run(Date.now() - 31 * DAY);
    await t.run();
    expect(t.archived).toEqual(["t"]);
  });
});

describe("auto-archive fresh start", () => {
  const turnOn = (t: Awaited<ReturnType<typeof setup>>, values: Record<string, unknown> = {}) =>
    t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveSettled: true, ...values });

  it("defaults to a fresh start, also for settings saved by an older version", async () => {
    const t = await setup({ threads: [], enable: false });
    const { autoArchiveIncludeSettled: _include, ...older } = DEFAULT_SIDEBAR_SETTINGS;
    t.db.prepare(`UPDATE sidebar_settings SET settings_json = ? WHERE id = 1`).run(JSON.stringify(older));
    await expect(t.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      autoArchiveSettled: false,
      autoArchiveIncludeSettled: false,
    });
  });

  it("gives a thread settled before the rule was turned on the full wait from turn-on", async () => {
    const t = await setup({ threads: [quiet("old")], rows: [settledFor("old", 400)], enable: false });
    await turnOn(t);
    await t.run();
    expect(t.archived).toEqual([]);
    expect(t.listings()).toBe(0);
    t.advance(30 * DAY - HOUR);
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(HOUR);
    await t.run();
    expect(t.archived).toEqual(["old"]);
  });

  it("lets a thread settled after turn-on wait from its own settle", async () => {
    const t = await setup({ threads: [quiet("later")], enable: false });
    await turnOn(t);
    t.advance(5 * DAY);
    t.db.prepare(`INSERT INTO thread_lifecycle (thread_id, settled_at) VALUES ('later', ?)`).run(Date.now());
    t.advance(30 * DAY - HOUR);
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(HOUR);
    await t.run();
    expect(t.archived).toEqual(["later"]);
  });

  it("archives on the next pass with Include threads already settled", async () => {
    const t = await setup({ threads: [quiet("old")], rows: [settledFor("old", 40)], enable: false });
    await turnOn(t, { autoArchiveIncludeSettled: true });
    await t.run();
    expect(t.archived).toEqual(["old"]);
  });

  it("applies Include threads already settled on the next pass when turned on later, and back off again", async () => {
    const t = await setup({ threads: [quiet("a"), quiet("b")], rows: [settledFor("a", 40)], enable: false });
    await turnOn(t);
    await t.run();
    expect(t.archived).toEqual([]);
    await t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveIncludeSettled: true });
    await t.run();
    expect(t.archived).toEqual(["a"]);
    await t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveIncludeSettled: false });
    t.db.prepare(`INSERT INTO thread_lifecycle (thread_id, settled_at) VALUES ('b', ?)`).run(NOW - 40 * DAY);
    t.advance(HOUR);
    await t.run();
    expect(t.archived).toEqual(["a"]);
    t.advance(30 * DAY - HOUR);
    await t.run();
    expect(t.archived).toEqual(["a", "b"]);
  });

  it("drops waits worked out under the old rule when the rule changes", async () => {
    const t = await setup({
      threads: [quiet("parent"), quiet("child", { parentThreadId: "parent" })],
      rows: [settledFor("parent", 40), settledFor("child", 5)],
    });
    await t.run();
    expect(t.archived).toEqual([]);
    await t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveAfterDays: 3 });
    await t.run();
    expect(t.archived).toEqual(["parent"]);
  });

  it("restarts the wait when the rule is turned off and on again", async () => {
    const t = await setup({ threads: [quiet("old")], rows: [settledFor("old", 400)], enable: false });
    await turnOn(t);
    t.advance(20 * DAY);
    await t.harness.behavior.callRpc("updateSidebarSettings", { autoArchiveSettled: false });
    await turnOn(t);
    t.advance(15 * DAY);
    await t.run();
    expect(t.archived).toEqual([]);
    t.advance(15 * DAY);
    await t.run();
    expect(t.archived).toEqual(["old"]);
  });

  it("records the turn-on time when the setting is saved, not at the first pass", async () => {
    const t = await setup({ threads: [quiet("old")], rows: [settledFor("old", 400)], enable: false });
    await turnOn(t);
    expect(t.db.prepare(`SELECT enabled_at FROM auto_archive_rule`).get()).toEqual({ enabled_at: NOW });
    t.advance(30 * DAY);
    await t.run();
    expect(t.archived).toEqual(["old"]);
  });
});
