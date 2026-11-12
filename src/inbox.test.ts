import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { idleSidebarThreadFields } from "./test-fixtures";
import { childNeedsYouCount, childThreadsByParent, childrenOf } from "./ChildThreadList";
import {
  filterByProjects,
  hideChildrenOfVisibleParents,
  parentOf,
  partitionPinned,
  reconcileProjectScope,
  filterProjectsByName,
  sortByCreatedAtDescending,
  sortSettledThreads,
  threadDisplayTitle,
  resolveThreadTitlesIn,
  shelfRowIds,
  threadStoredTitle,
  threadTitleHasMentions,
  visibleInboxThreads,
} from "./inbox";

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

describe("sortByCreatedAtDescending", () => {
  it("puts the newest thread first", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "a", createdAt: 1 }),
      thread({ id: "b", createdAt: 3 }),
      thread({ id: "c", createdAt: 2 }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  // The whole premise: activity must never move a row. Only createdAt is read,
  // so a thread that just did work keeps its place.
  it("ignores activity and update time", () => {
    const before = [
      thread({ id: "a", createdAt: 2, updatedAt: 1 }),
      thread({ id: "b", createdAt: 1, updatedAt: 999, indicator: "runtime" }),
    ];
    expect(sortByCreatedAtDescending(before).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("breaks ties on id so the order is stable", () => {
    const ordered = sortByCreatedAtDescending([thread({ id: "b", createdAt: 5 }), thread({ id: "a", createdAt: 5 })]);
    expect(ordered.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [thread({ id: "a", createdAt: 1 }), thread({ id: "b", createdAt: 2 })];
    sortByCreatedAtDescending(input);
    expect(input.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("sortSettledThreads", () => {
  it("orders by newest settled time instead of creation time", () => {
    const settledAt = new Map([
      ["old-thread", 500],
      ["new-thread", 900],
    ]);
    const ordered = sortSettledThreads(
      [thread({ id: "old-thread", createdAt: 999 }), thread({ id: "new-thread", createdAt: 1 })],
      (candidate) => settledAt.get(candidate.id) ?? null,
    );
    expect(ordered.map((candidate) => candidate.id)).toEqual(["new-thread", "old-thread"]);
  });

  it("falls back to the latest bb activity time", () => {
    const ordered = sortSettledThreads(
      [
        thread({ id: "updated", updatedAt: 800, latestAttentionAt: 100 }),
        thread({ id: "attention", updatedAt: 200, latestAttentionAt: 900 }),
      ],
      () => null,
    );
    expect(ordered.map((candidate) => candidate.id)).toEqual(["attention", "updated"]);
  });
});

describe("threadDisplayTitle", () => {
  it("prefers the title, then the fallback, then a placeholder", () => {
    expect(threadDisplayTitle(thread({ title: "Real" }))).toBe("Real");
    expect(threadDisplayTitle(thread({ title: null, titleFallback: "Fallback" }))).toBe("Fallback");
    expect(threadDisplayTitle(thread({ title: null, titleFallback: null }))).toBe("Untitled thread");
  });

  it("treats a whitespace-only title as absent", () => {
    expect(threadDisplayTitle(thread({ title: "   ", titleFallback: "Fallback" }))).toBe("Fallback");
  });

  it("shows bb's resolved names for mention titles and keeps the stored text for editing", () => {
    const mentioned = thread({ title: "Review @thread:thr_other", displayTitle: "Review Other thread" });
    expect(threadTitleHasMentions(mentioned)).toBe(true);
    expect(threadDisplayTitle(mentioned)).toBe("Review Other thread");
    expect(threadStoredTitle(mentioned)).toBe("Review @thread:thr_other");
    // A host that has not resolved the name yet still shows the stored title.
    expect(threadDisplayTitle({ ...mentioned, displayTitle: "" })).toBe("Review @thread:thr_other");
  });

  it("follows whatever bb resolved, including section aliases and file paths", () => {
    const folder = thread({ title: "Review @folder:sec_work", displayTitle: "Review Work" });
    expect(threadTitleHasMentions(folder)).toBe(true);
    expect(threadDisplayTitle(folder)).toBe("Review Work");
    const file = thread({ title: "Fix @src/inbox.ts", displayTitle: "Fix inbox.ts" });
    expect(threadDisplayTitle(file)).toBe("Fix inbox.ts");
  });

  it("leaves titles bb did not change exactly as stored", () => {
    const plain = thread({ title: "Email me@example.com", displayTitle: "Email me@example.com" });
    expect(threadTitleHasMentions(plain)).toBe(false);
    expect(threadDisplayTitle(plain)).toBe("Email me@example.com");
    // An unnamed thread keeps the sidebar's placeholder, not bb's short id.
    const unnamed = thread({ title: null, titleFallback: null, displayTitle: "thr_1" });
    expect(threadTitleHasMentions(unnamed)).toBe(false);
    expect(threadDisplayTitle(unnamed)).toBe("Untitled thread");
  });
});

describe("resolveThreadTitlesIn", () => {
  const threads = [
    thread({ id: "a", title: "Review @thread:thr_x", displayTitle: "Review Login fix" }),
    thread({ id: "b", title: "Review @thread:thr_x again", displayTitle: "Review Login fix again" }),
    thread({ id: "c", title: "Plain title", displayTitle: "Plain title" }),
  ];

  it("swaps stored mention titles for bb's names and leaves the rest of the text", () => {
    expect(resolveThreadTitlesIn('shares a workspace with "Review @thread:thr_x", which is not settled', threads)).toBe(
      'shares a workspace with "Review Login fix", which is not settled',
    );
    expect(resolveThreadTitlesIn("Cannot settle while Review @thread:thr_x again is working", threads)).toBe(
      "Cannot settle while Review Login fix again is working",
    );
    expect(resolveThreadTitlesIn("Cannot settle while Plain title is working", threads)).toBe(
      "Cannot settle while Plain title is working",
    );
  });
});

describe("filterProjectsByName", () => {
  const projects = [
    { id: "all", name: "All projects" },
    { id: "p1", name: "bb-sidebar" },
    { id: "p2", name: "kanban" },
  ];

  it("keeps every project for a blank query", () => {
    expect(filterProjectsByName(projects, "   ").map((p) => p.id)).toEqual(["all", "p1", "p2"]);
  });

  it("matches case-insensitively anywhere in the name", () => {
    expect(filterProjectsByName(projects, "BAN").map((p) => p.id)).toEqual(["p2"]);
    expect(filterProjectsByName(projects, "pro").map((p) => p.id)).toEqual(["all"]);
  });

  it("returns nothing when no name matches", () => {
    expect(filterProjectsByName(projects, "zzz")).toEqual([]);
  });
});

describe("filtering", () => {
  it("scopes to one project, or to all", () => {
    const threads = [thread({ id: "a", projectId: "p1" }), thread({ id: "b", projectId: "p2" })];
    expect(filterByProjects(threads, ["p1"]).map((t) => t.id)).toEqual(["a"]);
    expect(filterByProjects(threads, [])).toHaveLength(2);
  });

  it("drops archived threads", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b", isArchived: true })];
    expect(visibleInboxThreads(threads).map((t) => t.id)).toEqual(["a"]);
  });

  it("splits pinned from the rest, keeping order", () => {
    const { pinned, inbox } = partitionPinned([
      thread({ id: "a" }),
      thread({ id: "b", isPinned: true }),
      thread({ id: "c" }),
    ]);
    expect(pinned.map((t) => t.id)).toEqual(["b"]);
    expect(inbox.map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("child threads", () => {
  it("hides a child whose parent is on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
    ]);
    expect(visible.map((t) => t.id)).toEqual(["parent"]);
  });

  // An orphan must stay visible: hidden here AND absent from any header chip
  // would make it unreachable everywhere.
  it("keeps a child whose parent is not on screen", () => {
    const visible = hideChildrenOfVisibleParents([thread({ id: "child", parentThreadId: "archived-parent" })]);
    expect(visible.map((t) => t.id)).toEqual(["child"]);
  });

  it("files every descendant under the row that carries its tree", () => {
    const rows = shelfRowIds([
      thread({ id: "root" }),
      thread({ id: "child", parentThreadId: "root" }),
      thread({ id: "grandchild", parentThreadId: "child" }),
      thread({ id: "orphan", parentThreadId: "archived-parent" }),
      thread({ id: "loop-a", parentThreadId: "loop-b" }),
      thread({ id: "loop-b", parentThreadId: "loop-a" }),
    ]);
    expect(Object.fromEntries(rows)).toEqual({
      root: "root",
      child: "root",
      grandchild: "root",
      orphan: "orphan",
      // A cycle has no row: the sidebar hides both threads.
      "loop-a": null,
      "loop-b": null,
    });
  });

  it("lists a thread's children oldest first", () => {
    const children = childrenOf(
      [
        thread({ id: "parent" }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "other", parentThreadId: "elsewhere" }),
      ],
      "parent",
    );
    expect(children.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("lists a thread's children by the configured sort", () => {
    const threads = [
      thread({ id: "parent" }),
      thread({
        id: "a",
        parentThreadId: "parent",
        createdAt: 10,
        updatedAt: 30,
      }),
      thread({
        id: "b",
        parentThreadId: "parent",
        createdAt: 20,
        updatedAt: 25,
      }),
      thread({
        id: "c",
        parentThreadId: "parent",
        createdAt: 30,
        updatedAt: 40,
      }),
    ];

    expect(
      childrenOf(threads, "parent", {
        field: "created",
        direction: "descending",
      }).map((t) => t.id),
    ).toEqual(["c", "b", "a"]);
    expect(
      childrenOf(threads, "parent", {
        field: "activity",
        direction: "ascending",
      }).map((t) => t.id),
    ).toEqual(["b", "a", "c"]);
    expect(
      childrenOf(threads, "parent", {
        field: "activity",
        direction: "descending",
      }).map((t) => t.id),
    ).toEqual(["c", "a", "b"]);
  });

  it("groups children by parent in the configured sort", () => {
    const children = childThreadsByParent(
      [
        thread({ id: "parent" }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
      ],
      { field: "created", direction: "descending" },
    );
    expect(children.get("parent")?.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("breaks child sort ties by id, whatever the input order", () => {
    const threads = [
      thread({ id: "parent" }),
      thread({ id: "b", parentThreadId: "parent", createdAt: 10 }),
      thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
    ];
    expect(childrenOf(threads, "parent").map((t) => t.id)).toEqual(["a", "b"]);
    expect(childrenOf([...threads].reverse(), "parent").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("excludes archived children from child helpers and attention counts", () => {
    const threads = [
      thread({ id: "parent" }),
      thread({
        id: "visible",
        parentThreadId: "parent",
        hasPendingInteraction: true,
      }),
      thread({
        id: "archived",
        parentThreadId: "parent",
        hasPendingInteraction: true,
        isArchived: true,
      }),
    ];

    expect(childrenOf(threads, "parent").map((thread) => thread.id)).toEqual(["visible"]);
    expect(
      childThreadsByParent(threads)
        .get("parent")
        ?.map((thread) => thread.id),
    ).toEqual(["visible"]);
    expect(childNeedsYouCount(threads)).toBe(1);
  });
});

describe("parentOf", () => {
  // The list hides an archived parent, but the child's header must still get
  // it back — otherwise the child is a dead end.
  it("finds a parent the inbox filters out", () => {
    const parent = parentOf(
      [
        thread({ id: "parent", isArchived: true, projectId: "other" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    expect(parent?.id).toBe("parent");
  });

  it("returns null for a root thread", () => {
    expect(parentOf([thread({ id: "root" })], "root")).toBeNull();
  });

  it("returns null when the parent row is gone", () => {
    const threads = [thread({ id: "child", parentThreadId: "deleted" })];
    expect(parentOf(threads, "child")).toBeNull();
  });
});

describe("reconcileProjectScope", () => {
  const projects = [{ id: "project-a" }, { id: "project-b" }];

  it("keeps an available project and the all-projects scope", () => {
    expect(reconcileProjectScope(["project-a"], projects)).toEqual(["project-a"]);
    expect(reconcileProjectScope([], projects)).toEqual([]);
  });

  it("returns to all projects when the selected project disappears", () => {
    expect(reconcileProjectScope(["deleted-project"], projects)).toEqual([]);
  });

  it("drops only removed projects and preserves the chosen order", () => {
    expect(reconcileProjectScope(["project-b", "deleted", "project-a"], projects)).toEqual(["project-b", "project-a"]);
  });
});
