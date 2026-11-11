// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, defaultProviders, listProps, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("shows a child count badge with provider dots only on parent cards", () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    render([
      thread({
        id: "parent",
        title: "Parent",
        host: { id: "host_1", name: "Dev MacBook" },
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "main",
          workspaceDisplayKind: "managed-worktree",
          path: null,
          isWorktree: true,
          providerId: null,
        },
      }),
      thread({
        id: "child-1",
        title: "One",
        parentThreadId: "parent",
        updatedAt: minute - 60_000,
      }),
      thread({ id: "child-2", title: "Two", parentThreadId: "parent" }),
      thread({ id: "child-3", title: "Three", parentThreadId: "parent" }),
      thread({ id: "child-4", title: "Four", parentThreadId: "parent" }),
      thread({ id: "child-5", title: "Five", parentThreadId: "parent" }),
      thread({ id: "root", title: "No children" }),
    ]);

    const badge = screen.getByRole("button", { name: "5 child threads" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(badge.querySelectorAll("[data-child-thread-dot]")).toHaveLength(3);
    expect(badge.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
    const parentCard = badge.closest("li");
    expect(parentCard).not.toBeNull();
    const machine = within(parentCard!).getByLabelText("Machine: Dev MacBook");
    const providerGlyph = within(parentCard!).getByRole("img", {
      name: "Codex",
    });
    expect(badge.compareDocumentPosition(machine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(machine.compareDocumentPosition(providerGlyph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /No children.*child/i })).toBeNull();
    expect(screen.queryByText("One")).toBeNull();
  });

  it("rolls the most urgent child state up into the parent badge", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "working",
        title: "Working child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({
        id: "done",
        title: "Done child",
        parentThreadId: "parent",
        indicator: "unread-success",
      }),
      thread({
        id: "quiet",
        title: "Quiet child",
        parentThreadId: "parent",
      }),
      thread({
        id: "failed-grandchild",
        title: "Failed grandchild",
        parentThreadId: "quiet",
        indicator: "unread-error",
      }),
    ]);

    const badge = screen.getByRole("button", {
      name: "3 child threads, 1 failed, 1 done, 1 working",
    });
    expect(badge.getAttribute("data-child-status")).toBe("failed");
    expect(badge.className).toContain("bg-[color:var(--bb-sidebar-badge-failed-bg)]");
    expect(badge.querySelector('[data-icon="CircleX"]')).not.toBeNull();
  });

  it("marks a badge with only working children as working", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "working",
        title: "Working child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
    ]);

    const badge = screen.getByRole("button", {
      name: "1 child thread, 1 working",
    });
    expect(badge.getAttribute("data-child-status")).toBe("working");
    expect(badge.className).toContain("bg-[color:var(--bb-sidebar-badge-working-bg)]");
    expect(badge.querySelector('[data-icon="Working"]')).not.toBeNull();
    expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined();
    expect(screen.getByText("Working child")).toBeDefined();
  });

  // The needs-you rollup lost its coverage when the expanded-rows test was
  // rewritten: a raised hand anywhere in the subtree outranks live work, and
  // the badge has to say so in its tone, its data attribute and its glyph.
  it("marks a badge whose most urgent child needs the user", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "working",
        title: "Working child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({
        id: "asking",
        title: "Asking child",
        parentThreadId: "parent",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
    ]);

    const badge = screen.getByRole("button", {
      name: "2 child threads, 1 need you, 1 working",
    });
    expect(badge.getAttribute("data-child-status")).toBe("needs-you");
    expect(badge.className).toContain("bg-[color:var(--bb-sidebar-badge-needs-you-bg)]");
    expect(badge.querySelector('[data-icon="CircleQuestion"]')).not.toBeNull();
    expect(badge.querySelector('[data-icon="Working"]')).toBeNull();
  });

  it("keeps every child with a status visible while collapsed, and folds read ones", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "failed",
        title: "Failed child",
        parentThreadId: "parent",
        indicator: "unread-error",
      }),
      thread({
        id: "waiting",
        title: "Waiting child",
        parentThreadId: "parent",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
      thread({
        id: "unread",
        title: "Unread child",
        parentThreadId: "parent",
        indicator: "unread-success",
      }),
      thread({
        id: "working",
        title: "Working child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({ id: "idle", title: "Idle child", parentThreadId: "parent" }),
      // An idle child stays as the path to a grandchild that has news.
      thread({ id: "carrier", title: "Carrier child", parentThreadId: "parent" }),
      thread({
        id: "failed-grandchild",
        title: "Failed grandchild",
        parentThreadId: "carrier",
        indicator: "unread-error",
      }),
    ]);

    // Nothing was expanded: the list below is the collapsed view.
    const childList = screen.getByRole("list", { name: "Child threads" });
    for (const title of ["Failed child", "Waiting child", "Unread child", "Working child", "Carrier child"]) {
      expect(within(childList).getByText(title)).toBeDefined();
    }
    expect(within(childList).queryByText("Idle child")).toBeNull();
    expect(
      within(screen.getByRole("list", { name: "Grandchildren of Carrier child" })).getByText("Failed grandchild"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /6 child threads/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("can hide children that need attention while their section is collapsed", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({
            id: "working",
            title: "Working child",
            parentThreadId: "parent",
            indicator: "runtime",
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          showRunningChildrenWhenCollapsed: false,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });

    await waitFor(() => expect(screen.queryByRole("list", { name: "Child threads" })).toBeNull());
  });

  it("orders child rows by the saved child sort", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({
            id: "old",
            title: "Old child",
            parentThreadId: "parent",
            createdAt: 10,
            indicator: "runtime",
          }),
          thread({
            id: "new",
            title: "New child",
            parentThreadId: "parent",
            createdAt: 20,
            indicator: "runtime",
          }),
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

    await waitFor(() => {
      const rows = within(screen.getByRole("list", { name: "Child threads" })).getAllByText(/child$/);
      expect(rows.map((row) => row.textContent)).toEqual(["New child", "Old child"]);
    });
  });

  it("shows provider icons for child threads when chosen", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({
            id: "codex-child",
            title: "Codex child",
            parentThreadId: "parent",
            providerId: "codex",
            indicator: "runtime",
          }),
          thread({
            id: "claude-child",
            title: "Claude child",
            parentThreadId: "parent",
            providerId: "claude-code",
            indicator: "runtime",
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: { status: "ready", providers: defaultProviders },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          inactiveThreadsEnabled: false,
          childIconStyle: "provider",
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });

    await waitFor(() => {
      const childList = screen.getByRole("list", { name: "Child threads" });
      expect(within(childList).getByRole("img", { name: "Codex" })).toBeDefined();
      expect(within(childList).getByRole("img", { name: "Claude Code" })).toBeDefined();
    });
  });
});
