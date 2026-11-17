// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  defaultSidebarSettings,
  thread,
  defaultProviders,
  listProps,
  render,
  loadInboxApp,
  pinnedOrderResponse,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

it("shows direct subthreads in the hover card and opens them by keyboard or click", async () => {
  const rendered = render([
    thread({ id: "parent", title: "Parent work" }),
    thread({
      id: "b",
      parentThreadId: "parent",
      title: "Review",
      createdAt: 20,
      providerId: "claude-code",
      hasPendingInteraction: true,
    }),
    thread({
      id: "a",
      parentThreadId: "parent",
      title: null,
      titleFallback: "Implementation",
      createdAt: 10,
      indicator: "runtime",
      indicatorLabel: "Working",
    }),
    thread({ id: "archived", parentThreadId: "parent", title: "Archived work", isArchived: true }),
    thread({ id: "grandchild", parentThreadId: "a", title: "Nested work" }),
  ]);
  const row = screen.getByRole("link", { name: "Parent work" });
  act(() => row.focus());
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  const toggle = within(details).getByRole("button", { name: "Subthreads (2)", expanded: false });
  expect(within(details).queryByRole("list", { name: "Subthreads" })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const list = within(details).getByRole("list", { name: "Subthreads" });
  const items = within(list).getAllByRole("link");
  // Newest first, the default child order.
  expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
    "Open subthread: Review",
    "Open subthread: Implementation",
  ]);
  expect(list.textContent).toContain("Codex · Working");
  expect(list.textContent).toContain("Claude Code · Needs you");
  expect(within(details).queryByText("Archived work")).toBeNull();
  expect(within(details).queryByText("Nested work")).toBeNull();
  fireEvent.keyDown(row, { key: "Tab" });
  expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle);
  expect(within(details).queryByRole("list", { name: "Subthreads" })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.keyDown(toggle, { key: "Tab", shiftKey: true });
  await waitFor(() => expect(document.activeElement).toBe(row));
  fireEvent.pointerMove(row, { pointerType: "mouse" });
  const reopened = await screen.findByRole("dialog", { name: "Thread details" });
  fireEvent.click(within(reopened).getByRole("button", { name: "Subthreads (2)", expanded: false }));
  fireEvent.click(within(reopened).getByRole("link", { name: "Open subthread: Review" }));
  expect(rendered.linkCalls).toContainEqual({ href: "/projects/proj_1/threads/b", split: false });
  expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
});
// SDK fake pointerdown is a source-binding probe, not a completed drop.
it("binds hover subthread sources only to their open buttons", async () => {
  const rendered = render([
    thread({ id: "parent", title: "Parent" }),
    thread({ id: "child", title: "Child", parentThreadId: "parent" }),
  ]);
  act(() => screen.getByRole("link", { name: "Parent" }).focus());
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  const toggle = within(details).getByRole("button", { name: "Subthreads (1)" });
  fireEvent.pointerDown(toggle, { button: 0 });
  expect([
    ...rendered.navigateCalls,
    ...rendered.linkCalls,
    ...rendered.sdkCalls,
    ...rendered.splitSourceCalls,
    ...rendered.threadActionCalls,
  ]).toEqual([]);
  fireEvent.click(toggle);
  const source = within(details).getByRole("link", { name: "Open subthread: Child" });
  expect(source.draggable).toBe(false);
  fireEvent.pointerDown(source, { button: 0 });
  expect(rendered.splitSourceCalls).toEqual([{ threadId: "child" }]);
  expect(rendered.navigateCalls).toEqual([]);
  expect(rendered.linkCalls).toEqual([]);
  expect(rendered.sdkCalls).toEqual([]);
  expect(rendered.threadActionCalls).toEqual([]);
});
it("binds collapsed-visible sidebar descendants without enabling parent reorder", () => {
  const threads = [
    thread({ id: "parent", title: "Parent", isPinned: true }),
    thread({ id: "child", title: "Child", parentThreadId: "parent", indicator: "runtime" }),
    thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child", indicator: "runtime" }),
  ];
  const before = structuredClone(threads);
  const mutations: string[] = [];
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects: [] },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      reorderInbox: () => {
        mutations.push("reorderInbox");
        return null;
      },
      setThreadParent: () => {
        mutations.push("setThreadParent");
        return null;
      },
    },
    sdk: {
      threads: {
        reorderPinned: async () => {
          mutations.push("reorderPinned");
          return pinnedOrderResponse([]);
        },
      },
    },
  });
  for (const [relation, title, id] of [
    ["child", "Child", "child"],
    ["grandchild", "Grandchild", "grandchild"],
  ]) {
    const source = screen.getByRole("link", { name: new RegExp(`^Open ${relation} thread: ${title}`) });
    expect(source.draggable).toBe(false);
    expect(source.closest("[data-sidebar-thread-shortcut-target]")).toBeNull();
    fireEvent.pointerDown(source, { button: 0, clientX: 20, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 20, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 20, clientY: 100, pointerId: 1 });
    expect(rendered.splitSourceCalls.at(-1)).toEqual({ threadId: id });
  }
  expect(rendered.splitSourceCalls).toHaveLength(2);
  expect(rendered.navigateCalls).toEqual([]);
  expect(rendered.linkCalls).toEqual([]);
  expect(rendered.sdkCalls).toEqual([]);
  expect(rendered.threadActionCalls).toEqual([]);
  expect(mutations).toEqual([]);
  expect(threads).toEqual(before);
});
it("orders hover card subthreads by the saved child sort", async () => {
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "parent", title: "Parent work" }),
        thread({ id: "old", parentThreadId: "parent", title: "Old", createdAt: 10 }),
        thread({ id: "new", parentThreadId: "parent", title: "New", createdAt: 20 }),
      ],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    providers: { status: "ready", providers: defaultProviders },
    rpc: {
      getSidebarSettings: () => ({
        ...defaultSidebarSettings,
        inactiveThreadsEnabled: false,
        childSortDirection: "descending",
      }),
      listLifecycle: () => ({ rows: [] }),
    },
  });
  const row = await screen.findByRole("link", { name: "Parent work" });
  act(() => row.focus());
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  fireEvent.click(within(details).getByRole("button", { name: "Subthreads (2)" }));
  await waitFor(() => {
    const list = within(details).getByRole("list", { name: "Subthreads" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Open subthread: New", "Open subthread: Old"]);
  });
});

it("draws the question glyph for a thread that asks while bb reports a failure", async () => {
  render([thread({ id: "asks", title: "Asking work", hasPendingInteraction: true, indicator: "unread-error" })]);
  act(() => screen.getByRole("link", { name: "Asking work" }).focus());
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  expect(within(details).getByText("Status: Needs you")).toBeDefined();
  expect(within(details).getByLabelText("Needs you").getAttribute("data-icon")).toBe("CircleQuestion");
});
