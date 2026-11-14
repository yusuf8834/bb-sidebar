// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, rowLinks, startDrag } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

function worktree(id: string, branchName = id): NonNullable<PluginSidebarThread["environment"]> {
  return {
    id,
    branchName,
    name: id,
    path: `/repo/${id}`,
    isWorktree: true,
    providerId: "git-worktree",
    workspaceDisplayKind: "managed-worktree",
  };
}

function setup({
  rows = [
    thread({ id: "a", title: "Search implementation", environment: worktree("search") }),
    thread({ id: "b", title: "Search review", environment: worktree("search") }),
    thread({ id: "c", title: "Menu implementation", environment: worktree("menus") }),
    thread({ id: "d", title: "Menu review", environment: worktree("menus") }),
  ],
  enabled = true,
  activeThreadId = null,
}: {
  rows?: PluginSidebarThread[];
  enabled?: boolean;
  activeThreadId?: string | null;
} = {}) {
  localStorage.setItem("bb-sidebar:active-sort:v1", "project");
  if (enabled) localStorage.setItem("bb-sidebar:environment-grouping:v1", "true");
  let order = rows.filter((row) => !row.parentThreadId).map((row) => row.id);
  const save = vi.fn((input: unknown) => {
    order = (input as { inboxThreadIds: string[] }).inboxThreadIds;
    return { inboxThreadIds: order };
  });
  const rendered = renderSlot(
    inbox,
    { ...listProps, activeThreadId },
    {
      sidebarThreads: {
        status: "ready",
        threads: rows,
        projects: [
          { id: "proj_1", name: "Sidebar", isPersonal: false, href: "", settingsHref: "" },
          { id: "other", name: "Other", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: order }),
        reorderInbox: save,
      },
    },
  );
  return {
    ...rendered,
    save,
    pushOrder: async (ids: string[]) => {
      order = ids;
      await rendered.experimental_invalidateRpc(["inbox-order"]);
    },
  };
}

it("shows environment grouping only inside the Project sort picker and remembers it across modes", async () => {
  const rendered = setup({ enabled: false });
  expect(screen.queryByRole("checkbox", { name: "Group by worktree" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "Sort active threads: Project" }), { key: "Enter" });
  const picker = screen.getByRole("dialog", { name: "Sort active threads" });
  const toggle = within(picker).getByRole("checkbox", { name: "Group by worktree" });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole("region", { name: "search worktree" })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole("region", { name: "search worktree" })).toBeDefined();
  expect(localStorage.getItem("bb-sidebar:environment-grouping:v1")).toBe("true");
  fireEvent.click(within(picker).getByRole("radio", { name: "Manual order" }), { detail: 1 });
  expect(screen.queryByRole("checkbox", { name: "Group by worktree" })).toBeNull();
  expect(screen.queryByRole("region", { name: "search worktree" })).toBeNull();
  expect(rowLinks()).toHaveLength(4);
  fireEvent.keyDown(screen.getByRole("button", { name: "Sort active threads: Manual order" }), { key: "ArrowDown" });
  expect(screen.queryByRole("checkbox", { name: "Group by worktree" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Project" }), { detail: 1 });
  const restored = await screen.findByRole("checkbox", { name: "Group by worktree" });
  expect((restored as HTMLInputElement).checked).toBe(true);
  fireEvent.keyDown(restored, { key: "Escape" });
  expect(screen.queryByRole("checkbox", { name: "Group by worktree" })).toBeNull();
  expect(screen.getByRole("region", { name: "search worktree" })).toBeDefined();
  expect(rendered.save).not.toHaveBeenCalled();
});

it("uses environment identity, excludes ordinary checkouts and singletons, and leaves Pinned flat", () => {
  setup({
    rows: [
      ...["one", "two"].flatMap((id) =>
        [1, 2].map((n) => thread({ id: `${id}${n}`, title: `${id}${n}`, environment: worktree(id, "same-branch") })),
      ),
      thread({ id: "single", title: "Singleton", environment: worktree("single") }),
      ...[1, 2].map((n) =>
        thread({
          id: `checkout${n}`,
          title: `Checkout ${n}`,
          environment: { ...worktree("checkout"), isWorktree: false },
        }),
      ),
      ...[1, 2].map((n) =>
        thread({
          id: `pin${n}`,
          title: `Pinned ${n}`,
          isPinned: true,
          pinnedAt: 1,
          pinSortKey: `a${n}`,
          environment: worktree("pinned"),
        }),
      ),
    ],
  });
  const groups = screen.getAllByRole("region", { name: "same-branch worktree" });
  expect(groups).toHaveLength(2);
  expect(rowLinks(groups[0]!).map((link) => link.getAttribute("aria-label"))).toEqual(["one1", "one2"]);
  expect(rowLinks(groups[1]!).map((link) => link.getAttribute("aria-label"))).toEqual(["two1", "two2"]);
  expect(screen.queryByRole("region", { name: "single worktree" })).toBeNull();
  expect(screen.queryByRole("region", { name: "checkout worktree" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Pinned" })).queryAllByRole("region")).toHaveLength(0);
});

it("keeps an open child's ancestor visible through environment, project, and shelf collapse", () => {
  setup({
    activeThreadId: "child",
    rows: [
      thread({ id: "a", title: "Parent", environment: worktree("search") }),
      thread({ id: "b", title: "Other root", environment: worktree("search") }),
      thread({ id: "child", title: "Open child", parentThreadId: "a", environment: worktree("different") }),
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "search (2)" }));
  expect(screen.queryByRole("link", { name: "Other root" })).toBeNull();
  expect(screen.getByRole("link", { name: "Parent" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Open child thread: Open child" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Sidebar (2)" }));
  expect(screen.queryByRole("button", { name: "search (2)" })).toBeNull();
  expect(screen.getByRole("link", { name: "Parent" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Active" }));
  expect(screen.queryByRole("button", { name: "Sidebar (2)" })).toBeNull();
  expect(screen.getByRole("link", { name: "Open child thread: Open child" })).toBeDefined();
});

it("keeps a running child's parent visible in a collapsed environment", () => {
  setup({
    rows: [
      thread({ id: "a", title: "Parent", environment: worktree("search") }),
      thread({ id: "b", title: "Other root", environment: worktree("search") }),
      thread({
        id: "child",
        title: "Working child",
        parentThreadId: "a",
        indicator: "runtime",
      }),
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "search (2)" }));
  expect(screen.getByRole("link", { name: "Parent" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "Other root" })).toBeNull();
});

it("reorders threads only within their environment and moves whole environments within the project", async () => {
  const rendered = setup();
  await waitFor(() => expect(rendered.rpcCalls.some((call) => call.method === "listInboxOrder")).toBe(true));
  fireEvent.keyDown(screen.getByRole("link", { name: "Search review" }), { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(rendered.save).toHaveBeenLastCalledWith({ inboxThreadIds: ["b", "a", "c", "d"] }));
  fireEvent.keyDown(screen.getByRole("button", { name: "search (2)" }), { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(rendered.save).toHaveBeenLastCalledWith({ inboxThreadIds: ["c", "d", "b", "a"] }));
  expect(
    rowLinks(screen.getByRole("region", { name: "search worktree" })).map((link) => link.getAttribute("aria-label")),
  ).toEqual(["Search review", "Search implementation"]);
});

it.each(["project", "shelf"].flatMap((fold) => ["keyboard", "pointer"].map((gesture) => ({ fold, gesture }))))(
  "reorders flat rows in a collapsed grouped $fold with $gesture",
  async ({ fold, gesture }) => {
    const rendered = setup({
      activeThreadId: "a",
      rows: [
        thread({ id: "a", title: "Search implementation", environment: worktree("search") }),
        thread({ id: "b", title: "Search review", environment: worktree("search") }),
        thread({ id: "c", title: "Menu implementation", environment: worktree("menus") }),
        thread({ id: "d", title: "Menu review", environment: worktree("menus") }),
        thread({ id: "child", title: "Working child", parentThreadId: "c", indicator: "runtime" }),
      ],
    });
    await waitFor(() => expect(rendered.rpcCalls.some((call) => call.method === "listInboxOrder")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: fold === "project" ? "Sidebar (4)" : "Active" }));
    const active = screen.getByRole("region", { name: "Active" });
    const visible = () => rowLinks(active).map((link) => link.getAttribute("aria-label"));
    expect(visible()).toEqual(["Search implementation", "Menu implementation"]);
    expect(within(active).queryByRole("region", { name: "search worktree" })).toBeNull();
    const row = screen.getByRole("link", { name: "Search implementation" });
    if (gesture === "keyboard") {
      fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
      expect(screen.getByText("Search implementation moved to 2 of 2 in Active")).toBeDefined();
    } else {
      const drag = startDrag(row, screen.getByRole("link", { name: "Menu implementation" }).closest("li")!, 60);
      expect(visible()).toEqual(["Menu implementation", "Search implementation"]);
      drag.drop();
    }
    await waitFor(() =>
      expect(rendered.save).toHaveBeenCalledExactlyOnceWith({ inboxThreadIds: ["child", "c", "b", "a", "d"] }),
    );
    expect(visible()).toEqual(["Menu implementation", "Search implementation"]);
  },
);

it.each([false, true].flatMap((enabled) => ["keyboard", "pointer"].map((gesture) => ({ enabled, gesture }))))(
  "keeps folded Active reordering within projects: grouping=$enabled/$gesture",
  async ({ enabled, gesture }) => {
    const rows = [
      thread({ id: "a", title: "A", environment: worktree("search") }),
      thread({ id: "x", title: "X", projectId: "other" }),
      thread({ id: "b", title: "B", environment: worktree("search") }),
      thread({ id: "c", title: "C", environment: worktree("menus") }),
      thread({ id: "y", title: "Y", projectId: "other" }),
      thread({ id: "d", title: "D", environment: worktree("menus") }),
      ...["x", "c", "y"].map((id) =>
        thread({
          id: `child-${id}`,
          title: `Working child of ${id}`,
          projectId: id === "c" ? "proj_1" : "other",
          parentThreadId: id,
          indicator: "runtime",
        }),
      ),
    ];
    const rendered = setup({ enabled, activeThreadId: "a", rows });
    await waitFor(() => expect(rendered.rpcCalls.some((call) => call.method === "listInboxOrder")).toBe(true));
    await rendered.pushOrder(rows.map((row) => row.id));
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    const active = screen.getByRole("region", { name: "Active" });
    const visible = () => rowLinks(active).map((link) => link.getAttribute("aria-label"));
    // Folded rows stay in their projects' slots.
    expect(visible()).toEqual(["A", "C", "X", "Y"]);
    const row = within(active).getByRole("link", { name: "A" });
    if (gesture === "keyboard") {
      await act(async () => {
        fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
      });
      expect(screen.getByRole("status").textContent).toBe("A moved to 2 of 2 in Active");
    } else {
      vi.mocked(document.elementFromPoint).mockReturnValue(
        within(active).getByRole("link", { name: "X" }).closest("li")!,
      );
      fireEvent.pointerDown(row, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
      expect(visible()).toEqual(["A", "C", "X", "Y"]);
      expect(rendered.save).not.toHaveBeenCalled();
      vi.mocked(document.elementFromPoint).mockReturnValue(
        within(active).getByRole("link", { name: "C" }).closest("li")!,
      );
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 60, pointerId: 1 });
      expect(visible()).toEqual(["C", "A", "X", "Y"]);
      fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 1 });
      expect(screen.getByRole("status").textContent).toBe("");
    }
    await waitFor(() =>
      expect(rendered.save).toHaveBeenCalledExactlyOnceWith({
        inboxThreadIds: ["c", "x", "b", "a", "y", "d", "child-x", "child-c", "child-y"],
      }),
    );
    expect(visible()).toEqual(["C", "A", "X", "Y"]);
    if (gesture === "keyboard") {
      fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
      expect(screen.getByRole("status").textContent).toBe("A is already last in Active");
      expect(rendered.save).toHaveBeenCalledTimes(1);
    }
  },
);

it("rebases an environment drag on host updates while preserving another project's slot", async () => {
  const rendered = setup({
    rows: [
      thread({ id: "a", title: "A", environment: worktree("search") }),
      thread({ id: "x", title: "Other project", projectId: "other" }),
      thread({ id: "b", title: "B", environment: worktree("search") }),
      thread({ id: "c", title: "C", environment: worktree("menus") }),
      thread({ id: "d", title: "D", environment: worktree("menus") }),
    ],
  });
  const header = await screen.findByRole("button", { name: "search (2)" });
  const drag = startDrag(header, screen.getByRole("link", { name: "C" }), 40);
  await rendered.pushOrder(["x", "b", "a", "c", "d"]);
  drag.drop();
  await waitFor(() => expect(rendered.save).toHaveBeenLastCalledWith({ inboxThreadIds: ["x", "c", "d", "b", "a"] }));
});

it("targets the containing project when dragging a project over a nested environment", async () => {
  const rendered = setup({
    rows: [
      thread({ id: "a", title: "A" }),
      thread({ id: "b", title: "B" }),
      thread({ id: "c", title: "C", projectId: "other", environment: worktree("menus") }),
      thread({ id: "d", title: "D", projectId: "other", environment: worktree("menus") }),
    ],
  });
  startDrag(screen.getByRole("button", { name: "Sidebar (2)" }), screen.getByRole("link", { name: "C" }), 40).drop();
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("bb-sidebar:project-order:v1") ?? "null")).toEqual(["other", "proj_1"]),
  );
  expect(rendered.save).not.toHaveBeenCalled();
});
