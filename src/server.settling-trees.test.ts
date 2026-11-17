import { describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  disposers,
  projectThread,
  projectsWith,
  loadPlugin,
  deferred,
  settleQuietThreads,
  type LifecycleListResult,
} from "./test-server";

describe("settling thread trees", () => {
  const tree = () => [
    projectThread({ id: "parent" }),
    projectThread({ id: "child", parentThreadId: "parent", projectId: "other" }),
    projectThread({ id: "grandchild", parentThreadId: "child" }),
    projectThread({ id: "hidden", parentThreadId: "parent", visibility: "hidden" }),
    projectThread({ id: "archived", parentThreadId: "parent", archivedAt: 1 }),
    projectThread({ id: "unrelated" }),
  ];

  it.each(["thread.created", "thread.active"] as const)(
    "reopens settled ancestors across projects on %s without waking siblings",
    async (event) => {
      const harness = await loadPlugin();
      const threads = tree();
      harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
        const thread = threads.find((thread) => thread.id === threadId)!;
        return makeThreadResponse({
          id: thread.id,
          parentThreadId: thread.parentThreadId,
          projectId: thread.projectId,
        });
      });
      await harness.behavior.callRpc("settle", { threadId: "parent" });
      const child =
        event === "thread.created"
          ? projectThread({ id: "new-child", parentThreadId: "child" })
          : threads.find((thread) => thread.id === "grandchild")!;
      await harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: child.id, parentThreadId: child.parentThreadId, status: "active" }),
      });
      const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
      expect(rows.some((row) => ["parent", "child", child.id].includes(row.threadId))).toBe(false);
      expect(rows.find((row) => row.threadId === "hidden")?.settledAt).toEqual(expect.any(Number));
      if (event === "thread.created") {
        expect(rows.find((row) => row.threadId === "grandchild")?.settledAt).toEqual(expect.any(Number));
      }
      expect(harness.inspection.experimental_rpcInvalidations.at(-1)).toEqual(["lifecycle"]);
    },
  );

  it("reopens ancestors when a child is manually returned to Active", async () => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      const thread = threads.find((thread) => thread.id === threadId)!;
      return makeThreadResponse({ id: thread.id, parentThreadId: thread.parentThreadId });
    });
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    await harness.behavior.callRpc("unsettle", { threadId: "grandchild" });
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.some((row) => row.threadId === "parent" || row.threadId === "child")).toBe(false);
    expect(rows.find((row) => row.threadId === "grandchild")?.settledOverride).toBe("active");
    expect(rows.find((row) => row.threadId === "hidden")?.settledAt).toEqual(expect.any(Number));
  });

  it("keeps a newer settle when an earlier child event finishes late", async () => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    const parent = deferred<ReturnType<typeof makeThreadResponse>>();
    harness.inspection.sdk.stub("threads.get", () => parent.promise);
    const event = harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id: "child", parentThreadId: "parent" }),
    });
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    parent.resolve(makeThreadResponse({ id: "parent" }));
    await event;
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.every((row) => row.settledAt !== null)).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it.each([
    ["thread.active", "park", "child"],
    ["thread.active", "snooze", "child"],
    ["thread.created", "park", "child"],
    ["thread.created", "snooze", "child"],
    ["thread.active", "park", "parent"],
    ["thread.active", "snooze", "parent"],
    ["thread.created", "park", "parent"],
    ["thread.created", "snooze", "parent"],
  ] as const)(
    "a delayed %s preserves a newer %s on %s while ancestor lookups are pending",
    async (event, action, target) => {
      const harness = await loadPlugin();
      const threads = tree();
      harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
      await harness.behavior.callRpc("settle", { threadId: "parent" });
      const entered = deferred<void>();
      const lookup = deferred<void>();
      harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
        if (threadId === "child") {
          entered.resolve();
          await lookup.promise;
        }
        return makeThreadResponse(threads.find((thread) => thread.id === threadId)!);
      });
      const pending = harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({
          id: event === "thread.created" ? "new-child" : "grandchild",
          parentThreadId: "child",
          status: "active",
        }),
      });
      await entered.promise;
      await harness.behavior.callRpc(action, {
        threadId: target,
        ...(action === "snooze" ? { snoozedUntil: Date.now() + 86400000 } : {}),
      });
      const before = ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows;
      lookup.resolve();
      expect((await pending).errors).toEqual([]);
      const after = ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows;
      expect(after.find((row) => row.threadId === target)).toEqual(before.find((row) => row.threadId === target));
      // A newer choice on the nearest ancestor also protects the shelves above it.
      if (target === "child") {
        expect(after.find((row) => row.threadId === "parent")).toEqual(before.find((row) => row.threadId === "parent"));
      }
    },
  );

  it("returns a child and its ancestors to Active without a lookup after the shelf move", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree()));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    harness.inspection.sdk.stub("threads.get", async () => {
      throw new Error("ancestor unavailable");
    });

    await expect(harness.behavior.callRpc("unsettle", { threadId: "grandchild" })).resolves.toEqual({ ok: true });
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.some((row) => ["parent", "child"].includes(row.threadId))).toBe(false);
    expect(rows.find((row) => row.threadId === "grandchild")?.settledOverride).toBe("active");
    expect(rows.find((row) => row.threadId === "hidden")?.settledOverride).toBe("settled");
  });

  it("does not change shelves when Return to Active cannot load the tree", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree()));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    const before = await harness.behavior.callRpc("listLifecycle", {});
    harness.inspection.sdk.stub("threads.list", async () => {
      throw new Error("tree unavailable");
    });

    await expect(harness.behavior.callRpc("unsettle", { threadId: "grandchild" })).rejects.toThrow("tree unavailable");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it("finishes policy wakeups and runtime cleanup without ancestor lookups after writing rows", async () => {
    const harness = await loadPlugin({ getSettings: settleQuietThreads });
    const old = Date.now() - 8 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    const threads = [
      projectThread({ id: "parent", ...quiet }),
      projectThread({ id: "child", parentThreadId: "parent", ...quiet }),
    ];
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
    await harness.behavior.callRpc("evaluateAutoSettle", {});

    threads[1]!.status = "active";
    threads.push(projectThread({ id: "quiet-root", ...quiet }));
    harness.inspection.sdk.stub("threads.get", async () => {
      throw new Error("ancestor unavailable");
    });
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["child", "quiet-root", "parent"],
    });
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.map((row) => row.threadId)).toEqual(["quiet-root"]);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toContainEqual([{ threadId: "quiet-root" }]);
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({ changedThreadIds: [] });
  });

  it("keeps the child event successful when a higher ancestor lookup fails", async () => {
    const harness = await loadPlugin();
    const threads = tree();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === "parent") throw new Error("ancestor unavailable");
      return makeThreadResponse(threads.find((thread) => thread.id === threadId)!);
    });

    const { errors } = await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "grandchild", parentThreadId: "child", status: "active" }),
    });
    expect(errors).toEqual([]);
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.some((row) => ["child", "grandchild"].includes(row.threadId))).toBe(false);
    expect(rows.find((row) => row.threadId === "parent")?.settledOverride).toBe("settled");
    expect(harness.inspection.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Could not load ancestor parent: ancestor unavailable",
      }),
    );
  });

  it("settles descendants across projects together and explicitly returns the tree to Active", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(tree()));
    harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
    await harness.behavior.callRpc("settle", { threadId: "parent" });
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.map((row) => row.threadId).sort()).toEqual(["child", "grandchild", "hidden", "parent"]);
    expect(new Set(rows.map((row) => row.settledAt)).size).toBe(1);
    expect(rows.every((row) => row.settledOverride === "settled" && row.snoozedUntil === null)).toBe(true);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(4);
    expect(harness.inspection.experimental_rpcInvalidations.filter((tags) => tags?.includes("lifecycle"))).toHaveLength(
      1,
    );
    await harness.behavior.callRpc("unsettle", { threadId: "parent" });
    const restored = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(restored.rows).toEqual([
      expect.objectContaining({ threadId: "parent", settledAt: null, settledOverride: "active" }),
    ]);
  });

  it("Undo restores children's previous shelves without adding Active overrides", async () => {
    const harness = await loadPlugin();
    const threads = [
      projectThread({ id: "parent" }),
      ...["ordinary", "settled", "parked", "snoozed"].map((id) => projectThread({ id, parentThreadId: "parent" })),
    ];
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    await harness.behavior.callRpc("settle", { threadId: "settled" });
    await harness.behavior.callRpc("park", { threadId: "parked" });
    await harness.behavior.callRpc("snooze", { threadId: "snoozed", snoozedUntil: Date.now() + 86400000 });
    const before = await harness.behavior.callRpc("listLifecycle", {});

    const { undoToken } = (await harness.behavior.callRpc("settle", { threadId: "parent" })) as { undoToken: string };
    await harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    await expect(harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken })).rejects.toThrow(
      "can no longer be undone",
    );
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it("a quiet tree can automatically settle again after Undo", async () => {
    const harness = await loadPlugin({ getSettings: settleQuietThreads });
    const old = Date.now() - 4 * 86400000;
    const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old };
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith([
        projectThread({ id: "parent", ...quiet }),
        projectThread({ id: "child", parentThreadId: "parent", ...quiet }),
      ]),
    );
    const { undoToken } = (await harness.behavior.callRpc("settle", { threadId: "parent" })) as { undoToken: string };
    await harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["parent", "child"],
    });
  });

  it("Undo preserves newer shelf choices and children that have resumed work", async () => {
    const harness = await loadPlugin();
    const threads = [
      projectThread({ id: "parent" }),
      ...["ordinary", "parked", "snoozed", "working"].map((id) => projectThread({ id, parentThreadId: "parent" })),
    ];
    harness.inspection.sdk.stub("projects.list", async () => projectsWith(threads));
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        parentThreadId: threads.find((thread) => thread.id === threadId)!.parentThreadId,
      }),
    );
    await harness.behavior.callRpc("park", { threadId: "working" });
    const { undoToken } = (await harness.behavior.callRpc("settle", { threadId: "parent" })) as { undoToken: string };
    await harness.behavior.callRpc("park", { threadId: "parked" });
    await harness.behavior.callRpc("snooze", { threadId: "snoozed", snoozedUntil: Date.now() + 86400000 });
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "working", parentThreadId: "parent", status: "active" }),
    });
    const before = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    await harness.behavior.callRpc("unsettle", { threadId: "parent", undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({
      rows: before.rows.filter((row) => row.threadId !== "ordinary"),
    });
  });

  it("an earlier Undo cannot erase a newer settle, even within the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const harness = await loadPlugin();
    const first = (await harness.behavior.callRpc("settle", { threadId: "thr_1" })) as { undoToken: string };
    const before = await harness.behavior.callRpc("listLifecycle", {});
    const second = (await harness.behavior.callRpc("settle", { threadId: "thr_1" })) as { undoToken: string };
    const newer = await harness.behavior.callRpc("listLifecycle", {});
    await harness.behavior.callRpc("unsettle", { threadId: "thr_1", undoToken: first.undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(newer);
    await harness.behavior.callRpc("unsettle", { threadId: "thr_1", undoToken: second.undoToken });
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each(["expired", "reloaded"])("rejects an %s Undo without changing lifecycle state", async (reason) => {
    let harness = await loadPlugin();
    const { undoToken } = (await harness.behavior.callRpc("settle", { threadId: "thr_1" })) as { undoToken: string };
    const before = await harness.behavior.callRpc("listLifecycle", {});
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
    else {
      harness = (await harness.lifecycle.reload(plugin)).harness;
      disposers.push(() => harness.lifecycle.dispose());
    }
    await expect(harness.behavior.callRpc("unsettle", { threadId: "thr_1", undoToken })).rejects.toThrow(
      "can no longer be undone",
    );
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
  });

  it.each([
    { status: "active" as const },
    { hasPendingInteraction: true },
    { queuedWork: "waiting" as const },
    { activity: { ...projectThread({ id: "unused" }).activity, activeBackgroundCommandCount: 1 } },
  ])("refuses the whole settle when a descendant has live work: %j", async (busy) => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith(tree().map((thread) => (thread.id === "grandchild" ? { ...thread, ...busy } : thread))),
    );
    await expect(harness.behavior.callRpc("settle", { threadId: "parent" })).rejects.toThrow("Cannot settle");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.unpin")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("does not settle any rows if a descendant cannot be unpinned", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith(tree().map((thread) => (thread.id === "child" ? { ...thread, pinnedAt: 1 } : thread))),
    );
    harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      if (threadId === "child") throw new Error("unpin failed");
      return makeThreadResponse({ id: threadId });
    });
    await expect(harness.behavior.callRpc("settle", { threadId: "parent" })).rejects.toThrow("unpin failed");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("rechecks descendants after unpinning before stopping runtimes", async () => {
    const harness = await loadPlugin();
    let active = false;
    harness.inspection.sdk.stub("projects.list", async () =>
      projectsWith(
        tree().map((thread) =>
          thread.id === "grandchild" && active
            ? { ...thread, status: "active" as const }
            : thread.id === "child" && !active
              ? { ...thread, pinnedAt: 1 }
              : thread,
        ),
      ),
    );
    harness.inspection.sdk.stub("threads.unpin", async ({ threadId }) => {
      active = true;
      return makeThreadResponse({ id: threadId });
    });
    await expect(harness.behavior.callRpc("settle", { threadId: "parent" })).rejects.toThrow("Thread tree changed");
    await expect(harness.behavior.callRpc("listLifecycle", {})).resolves.toEqual({ rows: [] });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });
});
