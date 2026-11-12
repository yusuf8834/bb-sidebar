import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { portScanEnvironments, settledThreadIds } from "./live-threads";
import type { ThreadLifecycleRow } from "./lifecycle";
import { idleSidebarThreadFields } from "./test-fixtures";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

const settled = (threadId: string, extra: Partial<ThreadLifecycleRow> = {}): ThreadLifecycleRow => ({
  threadId,
  settledAt: 200,
  snoozedUntil: null,
  snoozedAt: null,
  ...extra,
});
const rowsOf = (...rows: ThreadLifecycleRow[]) => new Map(rows.map((row) => [row.threadId, row] as const));
const environment = (id: string) =>
  ({
    id,
    name: null,
    branchName: null,
    workspaceDisplayKind: "other",
    path: null,
    isWorktree: null,
    providerId: null,
  }) as PluginSidebarThread["environment"];

describe("live threads", () => {
  it("puts a child wherever its row thread goes", () => {
    const threads = [
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent", status: "error" }),
      thread({ id: "grandchild", parentThreadId: "child" }),
      thread({ id: "orphan", parentThreadId: "gone" }),
    ];
    expect(settledThreadIds(threads, rowsOf(settled("parent"), settled("orphan")), 0)).toEqual(
      new Set(["parent", "child", "grandchild", "orphan"]),
    );
    // The child's own settle does not matter while it rides in a live row.
    expect(settledThreadIds(threads, rowsOf(settled("child")), 0)).toEqual(new Set());
  });

  it("keeps snoozed, parked, pinned, working, asking and newly active rows live", () => {
    const threads = [
      thread({ id: "snoozed", queuedWork: "waiting" }),
      thread({ id: "parked" }),
      thread({ id: "pinned", isPinned: true }),
      thread({ id: "working", status: "active" }),
      thread({ id: "asking-parent" }),
      thread({ id: "asking", parentThreadId: "asking-parent", hasPendingInteraction: true }),
      thread({ id: "news", latestAttentionAt: 300 }),
      thread({ id: "archived", isArchived: true }),
    ];
    const rows = rowsOf(
      settled("snoozed", { snoozedUntil: 10_000, snoozedAt: 100 }),
      settled("parked", { parkedAt: 150 }),
      settled("pinned"),
      settled("working"),
      settled("asking-parent"),
      settled("news"),
      settled("archived"),
    );
    expect(settledThreadIds(threads, rows, 0)).toEqual(new Set());
    // An explicit settle still files a pinned thread away.
    expect(settledThreadIds(threads, rowsOf(settled("pinned", { settledOverride: "settled" })), 0)).toEqual(
      new Set(["pinned"]),
    );
  });

  it("scans a workspace while any live thread uses it, and on demand when only settled ones do", () => {
    const threads = [
      thread({ id: "a", environment: environment("env_shared") }),
      thread({ id: "b", environment: environment("env_shared") }),
      thread({ id: "c", environment: environment("env_settled") }),
      thread({ id: "d", environment: environment("env_archived"), isArchived: true }),
      thread({ id: "e", environment: environment("env_live") }),
    ];
    expect(portScanEnvironments(threads, new Set(["a", "c", "d"]))).toEqual({
      live: ["env_live", "env_shared"],
      settledOnly: new Set(["env_settled"]),
    });
  });
});
