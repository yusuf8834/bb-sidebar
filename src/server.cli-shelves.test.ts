import { describe, expect, it } from "vitest";
import { makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createFakePluginHost, disposers, projectThread, projectsWith, type ProjectThread } from "./test-server";

const HOUR_MS = 60 * 60_000;

interface Row {
  settledAt?: number | null;
  settledOverride?: "active" | "settled" | null;
  snoozedUntil?: number | null;
  snoozedAt?: number | null;
  parkedAt?: number | null;
}

type Queue = ReturnType<typeof makeQueueEntry>[];

async function loadWith(threads: ProjectThread[], rows: Record<string, Row>, queues: Record<string, Queue> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith(threads) },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        unpin: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        queuedMessages: { list: async ({ threadId }) => queues[threadId] ?? [] },
        events: { list: async () => [] },
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const insert = bb.storage.database().prepare(
    `INSERT INTO thread_lifecycle
       (thread_id, settled_at, settled_override, parked_at, snoozed_until, snoozed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [threadId, row] of Object.entries(rows)) {
    insert.run(
      threadId,
      row.settledAt ?? null,
      row.settledOverride ?? null,
      row.parkedAt ?? null,
      row.snoozedUntil ?? null,
      row.snoozedAt ?? null,
    );
  }
  const list = async (args: string[], projectId?: string) => {
    const result = await harness.behavior.runCli(["list", ...args, "--json"], projectId ? { projectId } : {});
    return JSON.parse(result.stdout) as {
      threads: { threadId: string; shelf: string; snoozedUntil: number | null }[];
    };
  };
  const shelves = async (args: string[] = ["--all"], projectId?: string) =>
    Object.fromEntries((await list(args, projectId)).threads.map((thread) => [thread.threadId, thread.shelf]));
  const ids = async (args: string[], projectId?: string) =>
    (await list(args, projectId)).threads.map((thread) => thread.threadId).sort();
  return { harness, list, shelves, ids };
}

// A tree settled before Settle covered whole trees: only the parent's row
// says settled. One child kept an elapsed snooze, another an explicit Active.
const legacySettledTree = () => ({
  threads: [
    projectThread({ id: "parent", latestAttentionAt: 50 }),
    projectThread({ id: "woken", parentThreadId: "parent", latestAttentionAt: 30 }),
    projectThread({ id: "returned", parentThreadId: "parent", latestAttentionAt: 20 }),
    projectThread({ id: "sibling", parentThreadId: "parent", latestAttentionAt: 40 }),
    projectThread({ id: "other", latestAttentionAt: 60 }),
  ],
  rows: {
    parent: { settledAt: 100, settledOverride: "settled" },
    woken: { snoozedUntil: 60, snoozedAt: 35 },
    returned: { settledOverride: "active" },
    sibling: { settledAt: 100, settledOverride: "settled" },
  } satisfies Record<string, Row>,
});

describe("bb sidebar list places children on their parent's shelf", () => {
  it("files the children of a settled parent under Settled, like the sidebar", async () => {
    const { threads, rows } = legacySettledTree();
    const { harness, shelves, ids } = await loadWith(threads, rows);

    expect(await shelves()).toEqual({
      parent: "settled",
      woken: "settled",
      returned: "settled",
      sibling: "settled",
      other: "active",
    });
    expect(await ids(["--all", "--state", "active"])).toEqual(["other"]);
    expect(await ids(["--all", "--state", "settled"])).toEqual(["parent", "returned", "sibling", "woken"]);

    const text = await harness.behavior.runCli(["list", "--all"]);
    expect(text.stdout).toContain("woken\tsettled\tUntitled (child of parent)");
    expect(text.stdout).toContain("returned\tsettled\tUntitled (child of parent)");
    const active = await harness.behavior.runCli(["list", "--all", "--state", "active"]);
    expect(active.stdout).toBe("other\tactive\tUntitled\n");
  });

  it("follows the top of a nested tree and resolves it before the project filter", async () => {
    const threads = [
      projectThread({ id: "root", latestAttentionAt: 50 }),
      projectThread({ id: "middle", parentThreadId: "root", latestAttentionAt: 40 }),
      projectThread({ id: "leaf", parentThreadId: "middle", latestAttentionAt: 30, projectId: "proj_2" }),
    ];
    const { shelves } = await loadWith(threads, { root: { settledAt: 100, settledOverride: "settled" } });
    expect(await shelves()).toEqual({ root: "settled", middle: "settled", leaf: "settled" });
    // The sidebar shows every project by default, so a child in another
    // project still sits inside its parent's row.
    expect(await shelves([], "proj_2")).toEqual({ leaf: "settled" });
  });

  it("gives the children of a snoozed parent the parent's wake time", async () => {
    const wake = Date.now() + HOUR_MS;
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 50 }),
      projectThread({ id: "child", parentThreadId: "parent", latestAttentionAt: 40 }),
    ];
    const { list } = await loadWith(threads, { parent: { snoozedUntil: wake, snoozedAt: 60 } });
    expect((await list(["--all", "--state", "snoozed"])).threads).toEqual([
      expect.objectContaining({ threadId: "parent", shelf: "snoozed", snoozedUntil: wake }),
      expect.objectContaining({ threadId: "child", shelf: "snoozed", snoozedUntil: wake }),
    ]);
  });

  it("keeps a snooze that waits on the sidebar's scheduled Continue on Snoozed", async () => {
    const wake = Date.now() + HOUR_MS;
    const continueAt = (sendAt: number, originPluginId = "bb-sidebar") =>
      makeQueueEntry({ sendAt, originPluginId, content: [{ type: "text", text: "Continue", mentions: [] }] });
    const threads = ["scheduled", "other-time", "someone-else"].map((id) =>
      projectThread({ id, status: "error", queuedWork: "waiting", latestAttentionAt: 50 }),
    );
    const snoozed = { snoozedUntil: wake, snoozedAt: 60 };
    const { shelves } = await loadWith(
      threads,
      { scheduled: snoozed, "other-time": snoozed, "someone-else": snoozed },
      {
        scheduled: [continueAt(wake)],
        "other-time": [continueAt(wake + 1)],
        "someone-else": [continueAt(wake, "another-plugin")],
      },
    );
    expect(await shelves()).toEqual({ scheduled: "snoozed", "other-time": "active", "someone-else": "active" });
  });

  it("keeps a child on its own shelf when its parent is not in the list", async () => {
    const threads = [projectThread({ id: "orphan", parentThreadId: "archived-parent", latestAttentionAt: 40 })];
    const { shelves } = await loadWith(threads, { orphan: { settledAt: 100, settledOverride: "settled" } });
    expect(await shelves()).toEqual({ orphan: "settled" });
  });

  it("brings a settled tree back to Active when a child asks for input", async () => {
    const threads = [
      projectThread({ id: "parent", latestAttentionAt: 50 }),
      projectThread({ id: "asking", parentThreadId: "parent", latestAttentionAt: 40, hasPendingInteraction: true }),
    ];
    const { shelves } = await loadWith(threads, {
      parent: { settledAt: 100, settledOverride: "settled" },
      asking: { settledAt: 100, settledOverride: "settled" },
    });
    expect(await shelves()).toEqual({ parent: "active", asking: "active" });
  });

  it("keeps a pinned thread Active unless the user filed it away explicitly", async () => {
    const threads = [
      projectThread({ id: "pinned", pinnedAt: 10, latestAttentionAt: 50 }),
      projectThread({ id: "pinned-settled", pinnedAt: 11, latestAttentionAt: 50 }),
    ];
    const { shelves } = await loadWith(threads, {
      pinned: { settledAt: 100 },
      "pinned-settled": { settledAt: 100, settledOverride: "settled" },
    });
    expect(await shelves()).toEqual({ pinned: "active", "pinned-settled": "settled" });
  });
});

describe("bb sidebar resume reads the shelf the sidebar shows", () => {
  it("names the parent instead of calling a child in a settled tree active", async () => {
    const { threads, rows } = legacySettledTree();
    const { harness, shelves } = await loadWith(threads, rows);

    expect(await harness.behavior.runCli(["resume", "--thread", "returned"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("returned is settled with parent, the thread it is nested under"),
    });
    expect(await shelves()).toMatchObject({ parent: "settled", returned: "settled" });

    expect(await harness.behavior.runCli(["resume", "--thread", "parent"])).toMatchObject({
      exitCode: 0,
      stdout: "resumed parent\n",
    });
    expect(await shelves()).toMatchObject({ parent: "active", returned: "active", woken: "active" });
    expect(await harness.behavior.runCli(["resume", "--thread", "returned"])).toMatchObject({
      stdout: "returned is already active\n",
    });
  });
});
