import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { idleSidebarThreadFields } from "./test-fixtures";
import {
  projectOrderUnits,
  expandProjectUnits,
  isActiveSortMode,
  sameOrder,
  projectUnitKey,
  type ProjectUnit,
  layoutActiveThreadsByProject,
  mergeProjectOrder,
  sortActiveThreads,
  visibleShelfThreads,
  activeRepresentativeThreadId,
} from "./inbox-layout";
import { layoutActiveGroups, projectGroupView } from "./environment-groups";

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
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

describe("layoutActiveThreadsByProject", () => {
  it("groups repeated projects at their first slot while preserving member order", () => {
    const a = thread({ id: "a", projectId: "p" });
    const b = thread({ id: "b", projectId: "q" });
    const c = thread({ id: "c", projectId: "p" });
    expect(layoutActiveThreadsByProject([a, b, c])).toEqual([
      { kind: "group", key: "project:p", projectId: "p", threads: [a, c] },
      { kind: "thread", key: "b", thread: b },
    ]);
  });
  it("keeps two interleaved project groups and singleton rows at their first slots", () => {
    const a = thread({ id: "a", projectId: "p" });
    const b = thread({ id: "b", projectId: "s" });
    const c = thread({ id: "c", projectId: "q" });
    const d = thread({ id: "d", projectId: "p" });
    const e = thread({ id: "e", projectId: "t" });
    const f = thread({ id: "f", projectId: "q" });
    const g = thread({ id: "g", projectId: "r" });
    expect(layoutActiveThreadsByProject([a, b, c, d, e, f, g])).toEqual([
      { kind: "group", key: "project:p", projectId: "p", threads: [a, d] },
      { kind: "thread", key: "b", thread: b },
      { kind: "group", key: "project:q", projectId: "q", threads: [c, f] },
      { kind: "thread", key: "e", thread: e },
      { kind: "thread", key: "g", thread: g },
    ]);
  });
  it("keeps singleton projects as ordinary rows", () => {
    const a = thread({ id: "a" });
    expect(layoutActiveThreadsByProject([a])).toEqual([{ kind: "thread", key: "a", thread: a }]);
    expect(layoutActiveThreadsByProject([])).toEqual([]);
  });
  it("groups singleton projects when asked", () => {
    const a = thread({ id: "a", projectId: "p" });
    const b = thread({ id: "b", projectId: "q" });
    const c = thread({ id: "c", projectId: "p" });
    expect(layoutActiveThreadsByProject([a, b, c], [], true)).toEqual([
      { kind: "group", key: "project:p", projectId: "p", threads: [a, c] },
      { kind: "group", key: "project:q", projectId: "q", threads: [b] },
    ]);
  });
  it("places projects by the saved order, whichever of their threads leads", () => {
    const a = thread({ id: "a", projectId: "p" });
    const b = thread({ id: "b", projectId: "q" });
    const c = thread({ id: "c", projectId: "p" });
    const d = thread({ id: "d", projectId: "r" });
    expect(layoutActiveThreadsByProject([b, d, c, a], ["r", "p", "q"])).toEqual([
      { kind: "thread", key: "d", thread: d },
      { kind: "group", key: "project:p", projectId: "p", threads: [c, a] },
      { kind: "thread", key: "b", thread: b },
    ]);
    // A project down to one thread keeps its slot as a plain row.
    expect(layoutActiveThreadsByProject([b, d, c], ["r", "p", "q"])).toEqual([
      { kind: "thread", key: "d", thread: d },
      { kind: "thread", key: "c", thread: c },
      { kind: "thread", key: "b", thread: b },
    ]);
  });
  it("puts projects the saved order has not seen first, in thread order", () => {
    const a = thread({ id: "a", projectId: "p" });
    const b = thread({ id: "b", projectId: "new2" });
    const c = thread({ id: "c", projectId: "new1" });
    const d = thread({ id: "d", projectId: "new2" });
    expect(layoutActiveThreadsByProject([a, b, c, d], ["p"])).toEqual([
      { kind: "group", key: "project:new2", projectId: "new2", threads: [b, d] },
      { kind: "thread", key: "c", thread: c },
      { kind: "thread", key: "a", thread: a },
    ]);
  });
});
describe("mergeProjectOrder", () => {
  it("adds unseen projects first, once each, and keeps absent saved ones", () => {
    expect(mergeProjectOrder(["p", "gone"], ["q", "p", "q", "r"])).toEqual(["q", "r", "p", "gone"]);
    expect(mergeProjectOrder(["p"], ["p"])).toEqual(["p"]);
  });
});
describe("sortActiveThreads", () => {
  const rows = [
    thread({ id: "a", createdAt: 3, updatedAt: 1 }),
    thread({ id: "b", createdAt: 2, updatedAt: 4 }),
    thread({ id: "c", createdAt: 1, updatedAt: 4 }),
  ];
  it("sorts activity ties by creation time without mutating the input", () => {
    expect(sortActiveThreads(rows, "activity").map((row) => row.id)).toEqual(["b", "c", "a"]);
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
  it("sorts creation ties by activity", () => {
    const tied = [...rows, thread({ id: "d", createdAt: 3, updatedAt: 5 })];
    expect(sortActiveThreads(tied, "created").map((row) => row.id)).toEqual(["d", "a", "b", "c"]);
  });
  it.each(["manual", "project"] as const)("copies %s order unchanged", (mode) => {
    const result = sortActiveThreads(rows, mode);
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });
});
describe("visibleShelfThreads", () => {
  const rows = [thread({ id: "a" }), thread({ id: "b" }), thread({ id: "c" })];
  it("retains active and attention paths in a collapsed shelf", () => {
    expect(visibleShelfThreads(rows, false, "c", 0, new Set(["a"]))).toEqual([rows[0], rows[2]]);
  });
  it("retains the active row beyond an expanded shelf's page limit", () => {
    expect(visibleShelfThreads(rows, true, "c", 1)).toEqual([rows[0], rows[2]]);
  });
  it("shows all expanded rows by default and none collapsed without paths", () => {
    expect(visibleShelfThreads(rows, true, null)).toEqual(rows);
    expect(visibleShelfThreads(rows, false, null)).toEqual([]);
  });
});
describe("activeRepresentativeThreadId", () => {
  const parent = thread({ id: "parent" });
  const child = thread({ id: "child", parentThreadId: "parent" });
  const grandchild = thread({ id: "grandchild", parentThreadId: "child" });
  it("finds the closest ancestor represented by a flat row", () => {
    expect(activeRepresentativeThreadId([parent, child, grandchild], "grandchild", [parent])).toBe("parent");
    expect(activeRepresentativeThreadId([parent, child, grandchild], "grandchild", [parent, child])).toBe("child");
    expect(activeRepresentativeThreadId([parent, child], "child", [child])).toBe("child");
  });
  it("returns null for missing, archived, or unrepresented paths", () => {
    expect(activeRepresentativeThreadId([child], "child", [parent])).toBeNull();
    expect(activeRepresentativeThreadId([parent], null, [parent])).toBeNull();
    expect(activeRepresentativeThreadId([parent], "missing", [parent])).toBeNull();
    expect(activeRepresentativeThreadId([{ ...parent, isArchived: true }], "parent", [parent])).toBeNull();
  });
  it("terminates cyclic ancestry", () => {
    const cycle = [{ ...parent, parentThreadId: "child" }, child];
    expect(activeRepresentativeThreadId(cycle, "child", [])).toBeNull();
  });
});

describe("projectOrderUnits", () => {
  it("maps a single row to its id and a group to all member ids in order", () => {
    const a = thread({ id: "a", projectId: "p" });
    const b = thread({ id: "b", projectId: "p" });
    const solo = thread({ id: "solo", projectId: "q" });
    expect(
      projectOrderUnits([
        { kind: "thread", key: "solo", thread: solo },
        { kind: "group", key: "project:p", projectId: "p", threads: [b, a] },
      ]),
    ).toEqual([
      { key: "solo", ids: ["solo"] },
      { key: "project:p", ids: ["b", "a"] },
    ]);
  });
  it("returns no order units for an empty layout", () => {
    expect(projectOrderUnits([])).toEqual([]);
  });
});

describe("expandProjectUnits", () => {
  const units: ProjectUnit[] = [
    { kind: "thread", key: "solo", thread: thread({ id: "solo" }) },
    { kind: "group", key: "project:p", projectId: "p", threads: [thread({ id: "a" }), thread({ id: "b" })] },
  ];
  it("follows the preview keys and preserves member order within a group", () => {
    expect(expandProjectUnits(["project:p", "solo"], units)).toEqual(["a", "b", "solo"]);
    expect(expandProjectUnits(["solo", "project:p"], units)).toEqual(["solo", "a", "b"]);
  });
  it("drops unknown keys without dropping the known units around them", () => {
    expect(expandProjectUnits(["missing", "project:p", "deleted", "solo"], units)).toEqual(["a", "b", "solo"]);
  });
  it("returns no ids when the preview or layout is empty", () => {
    expect(expandProjectUnits([], units)).toEqual([]);
    expect(expandProjectUnits(["solo"], [])).toEqual([]);
  });
});

describe("isActiveSortMode", () => {
  it.each(["manual", "activity", "created", "project"])("accepts %s", (mode) => {
    expect(isActiveSortMode(mode)).toBe(true);
  });
  it.each(["", "Manual", "activity ", "updated"])("rejects %j", (mode) => {
    expect(isActiveSortMode(mode)).toBe(false);
  });
});

describe("sameOrder", () => {
  it("accepts equal sequences, including empty sequences", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder([], [])).toBe(true);
  });
  it("rejects reordered ids and unequal lengths in either direction", () => {
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
    expect(sameOrder(["a", "b"], ["a"])).toBe(false);
  });
});

describe("projectUnitKey", () => {
  it("gives each project a stable key distinct from thread ids", () => {
    expect(projectUnitKey("p")).toBe("project:p");
    expect(projectUnitKey("q")).toBe("project:q");
    expect(projectUnitKey("p")).not.toBe(projectUnitKey("q"));
    expect(projectUnitKey("p")).not.toBe("p");
  });
});

describe("projectGroupView alerts", () => {
  const threads = [
    thread({ id: "done", projectId: "p", indicator: "unread-success" }),
    thread({ id: "asks", projectId: "p", hasPendingInteraction: true }),
    thread({ id: "failed", projectId: "p", indicator: "unread-error" }),
    thread({ id: "also-failed", projectId: "p", queuedWork: "failed" }),
    thread({ id: "working", projectId: "p", indicator: "runtime" }),
    thread({ id: "idle", projectId: "p" }),
  ];
  const view = (collapsed: string[], activeThreadId: string | null = null) =>
    projectGroupView(layoutActiveGroups(threads, false), new Set(collapsed), new Set(), activeThreadId, new Set());

  it("counts the news a collapsed group hides, most urgent first, leaving out work", () => {
    expect(view(["p"])[0]).toMatchObject({
      alerts: [
        { kind: "failed", count: 2 },
        { kind: "needs-you", count: 1 },
        { kind: "done", count: 1 },
      ],
    });
  });
  it("leaves out rows still shown under the header, and every row of an open group", () => {
    expect(view(["p"], "asks")[0]).toMatchObject({
      alerts: [
        { kind: "failed", count: 2 },
        { kind: "done", count: 1 },
      ],
    });
    expect(view([])[0]).toMatchObject({ alerts: [] });
  });
});
