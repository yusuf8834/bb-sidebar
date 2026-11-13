import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  childStatusKind,
  childStatusPhrase,
  childStatusSummary,
  childSubtree,
  threadsWithAskingDescendants,
} from "./child-status";
import { runtimeStatusFor } from "./test-fixtures";
import { isThreadWorkingForDisplay } from "./working-tree";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
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
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    runtimeStatus: runtimeStatusFor(overrides),
    queuedWork: "none",
    ...overrides,
  } as PluginSidebarThread;
}

const working = (candidate: PluginSidebarThread) => isThreadWorkingForDisplay(candidate, null);
const kind = (candidate: PluginSidebarThread) => childStatusKind(candidate, working);

describe("childStatusKind", () => {
  it("ranks failure over a raised hand over done over working", () => {
    expect(kind(thread({ indicator: "unread-error", hasPendingInteraction: true }))).toBe("failed");
    expect(kind(thread({ queuedWork: "failed", hasPendingInteraction: true }))).toBe("failed");
    expect(kind(thread({ hasPendingInteraction: true }))).toBe("needs-you");
    expect(kind(thread({ indicator: "waiting-for-input" }))).toBe("needs-you");
    expect(kind(thread({ indicator: "unread-success" }))).toBe("done");
    expect(
      kind(
        thread({
          indicator: "plan-mode",
          activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 1 },
        }),
      ),
    ).toBe("working");
    expect(kind(thread({ indicator: "draft" }))).toBeNull();
    expect(kind(thread())).toBeNull();
  });
});

describe("childStatusSummary", () => {
  it("counts each kind, skips archived rows, and picks the most urgent", () => {
    const summary = childStatusSummary(
      [
        thread({ id: "a", indicator: "runtime" }),
        thread({ id: "b", indicator: "runtime", isArchived: true }),
        thread({ id: "c", indicator: "unread-success" }),
        thread({ id: "d", hasPendingInteraction: true }),
        thread({ id: "e" }),
      ],
      working,
    );
    expect(summary).toEqual({
      failed: 0,
      needsYou: 1,
      done: 1,
      working: 1,
      dominant: "needs-you",
    });
    expect(childStatusPhrase(summary)).toBe(", 1 need you, 1 done, 1 working");
  });

  it("has no dominant kind and an empty phrase for idle children", () => {
    const summary = childStatusSummary([thread({ id: "a" })], working);
    expect(summary.dominant).toBeNull();
    expect(childStatusPhrase(summary)).toBe("");
  });
});

describe("childSubtree", () => {
  it("adds visible grandchildren after each child", () => {
    const a = thread({ id: "a" });
    const b = thread({ id: "b" });
    const aa = thread({ id: "aa", parentThreadId: "a" });
    const ab = thread({ id: "ab", parentThreadId: "a", isArchived: true });
    const byParent = new Map([["a", [aa, ab]]]);
    expect(childSubtree([a, b], byParent).map((row) => row.id)).toEqual(["a", "aa", "b"]);
  });
});

describe("full child subtree", () => {
  it.each([
    ["waiting-for-input", "needs-you"],
    ["unread-error", "failed"],
    ["unread-success", "done"],
    ["runtime", "working"],
  ] as const)("rolls up fourth-level %s", (indicator, dominant) => {
    const c = thread({ id: "c" });
    const g = thread({ id: "g", parentThreadId: "c" });
    const gg = thread({ id: "gg", parentThreadId: "g", indicator });
    const subtree = childSubtree(
      [c],
      new Map([
        ["c", [g]],
        ["g", [gg]],
      ]),
    );
    expect(subtree.map((row) => row.id)).toEqual(["c", "g", "gg"]);
    expect(childStatusSummary(subtree, working).dominant).toBe(dominant);
  });

  it("stops archived branches and visits cyclic/duplicate DTOs once in sibling order", () => {
    const c = thread({ id: "c" });
    const g = thread({ id: "g" });
    const archived = thread({ id: "archived", isArchived: true });
    const hidden = thread({ id: "hidden", indicator: "unread-error" });
    const sibling = thread({ id: "sibling" });
    const map = new Map([
      ["c", [g, archived, sibling]],
      ["g", [c]],
      ["archived", [hidden]],
    ]);
    expect(childSubtree([c, sibling], map).map((row) => row.id)).toEqual(["c", "g", "sibling"]);
  });
});

describe("threadsWithAskingDescendants", () => {
  it("marks every ancestor of a child that waits on the user", () => {
    const threads = [
      thread({ id: "root" }),
      thread({ id: "child", parentThreadId: "root", indicator: "runtime" }),
      thread({ id: "grandchild", parentThreadId: "child", hasPendingInteraction: true }),
      thread({ id: "sibling", parentThreadId: "root" }),
      thread({ id: "other" }),
      thread({ id: "other-child", parentThreadId: "other", indicator: "waiting-for-input" }),
    ];
    expect([...threadsWithAskingDescendants(threads)].sort()).toEqual(["child", "other", "root"]);
  });

  it("ignores archived askers and stops at archived ancestors and cycles", () => {
    expect(
      threadsWithAskingDescendants([
        thread({ id: "root" }),
        thread({ id: "archived-asker", parentThreadId: "root", hasPendingInteraction: true, isArchived: true }),
      ]).size,
    ).toBe(0);
    expect([
      ...threadsWithAskingDescendants([
        thread({ id: "root" }),
        thread({ id: "archived", parentThreadId: "root", isArchived: true }),
        thread({ id: "asker", parentThreadId: "archived", hasPendingInteraction: true }),
      ]),
    ]).toEqual([]);
    expect(
      [
        ...threadsWithAskingDescendants([
          thread({ id: "a", parentThreadId: "b" }),
          thread({ id: "b", parentThreadId: "a", hasPendingInteraction: true }),
        ]),
      ].sort(),
    ).toEqual(["a"]);
  });
});
