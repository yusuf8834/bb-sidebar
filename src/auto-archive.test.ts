import { describe, expect, it } from "vitest";
import { isValidAutoArchiveAfterDays, isWorkspaceSafeToRetire, settledArchiveTree } from "./auto-archive";

const idle = {
  hasPendingInteraction: false,
  hasQueuedWork: false,
  isWorking: false,
  isUnread: false,
  latestAttentionAt: 1,
};
const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  visibility: "visible",
  pinnedAt: null,
  latestAttentionAt: 1,
  environmentId: null,
  ...extra,
});
const settled = (threadId: string, settledAt = 10) => ({
  threadId,
  settledAt,
  settledOverride: null,
  snoozedUntil: null,
  snoozedAt: null,
});

describe("settledArchiveTree", () => {
  it("covers bb's whole archive cascade: children, lifecycle dependents, hidden source threads", () => {
    const threads = [
      thread("root"),
      thread("child", { parentThreadId: "root" }),
      thread("worker", { lifecycleOwnerThreadId: "child", visibility: "hidden" }),
      thread("fork", { sourceThreadId: "root", visibility: "hidden" }),
      thread("visible-side", { sourceThreadId: "root" }),
    ];
    const tree = settledArchiveTree(threads, new Map([["root", settled("root")]]), "root", () => idle, 100);
    expect(tree?.threadIds.sort()).toEqual(["child", "fork", "root", "worker"]);
  });

  it("returns the newest settle in the tree", () => {
    const threads = [thread("root"), thread("child", { parentThreadId: "root" })];
    const rows = new Map([
      ["root", settled("root", 10)],
      ["child", settled("child", 20)],
    ]);
    expect(settledArchiveTree(threads, rows, "root", () => idle, 100)?.settledAt).toBe(20);
  });

  it("refuses a child row's thread: only top-level rows are archived", () => {
    const threads = [thread("root"), thread("child", { parentThreadId: "root" })];
    const rows = new Map([
      ["root", settled("root")],
      ["child", settled("child")],
    ]);
    expect(settledArchiveTree(threads, rows, "child", () => idle, 100)).toBeNull();
  });
});

it("accepts whole days from 1 to 365", () => {
  expect([0, 1, 30, 365, 366, 2.5, Number.NaN].map(isValidAutoArchiveAfterDays)).toEqual([
    false,
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
});

it("retires only workspaces bb reports clean", () => {
  const status = (hasUncommittedChanges: boolean, state: string) => ({
    outcome: "available",
    workspace: { workingTree: { hasUncommittedChanges, state } },
  });
  expect(isWorkspaceSafeToRetire(status(false, "clean"))).toBe(true);
  expect(isWorkspaceSafeToRetire(status(false, "committed_unmerged"))).toBe(true);
  expect(isWorkspaceSafeToRetire(status(false, "untracked"))).toBe(false);
  expect(isWorkspaceSafeToRetire(status(true, "dirty_and_committed_unmerged"))).toBe(false);
  expect(isWorkspaceSafeToRetire({ outcome: "unavailable" })).toBe(false);
  expect(isWorkspaceSafeToRetire(undefined)).toBe(false);
});
