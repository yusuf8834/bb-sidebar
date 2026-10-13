// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, toastMocks, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("parent thread menu", () => {
  it("orders parent choices by recent activity regardless of pin, shelf, or sidebar sort", async () => {
    const now = Date.now();
    localStorage.setItem("bb-sidebar:active-sort:v1", "created");
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "child", title: "Choose my parent", updatedAt: now }),
          thread({ id: "settled", title: "Settled parent", updatedAt: now - 1_000 }),
          thread({ id: "active", title: "Active parent", updatedAt: now - 4_000, createdAt: now - 4_000 }),
          thread({ id: "inactive", title: "Older parent" }),
          thread({ id: "pinned", title: "Pinned parent", isPinned: true, updatedAt: now - 9_000 }),
          thread({ id: "snoozed", title: "Snoozed parent", updatedAt: now - 3_000 }),
          thread({ id: "pinned-2", title: "Pinned second", isPinned: true, updatedAt: now - 7_000 }),
          thread({ id: "parked", title: "Parked parent", updatedAt: now - 5_000 }),
          thread({ id: "hidden", title: "Nested work", parentThreadId: "settled", updatedAt: now - 2_000 }),
          thread({
            id: "nested-active",
            title: "Nested active work",
            parentThreadId: "active",
            updatedAt: now - 6_000,
          }),
          thread({
            id: "nested-pinned",
            title: "Nested pinned work",
            parentThreadId: "settled",
            isPinned: true,
            updatedAt: now - 8_000,
          }),
          thread({ id: "orphan", title: "Orphan parent", parentThreadId: "missing", updatedAt: now - 10_000 }),
          thread({ id: "descendant", title: "Forbidden pinned child", parentThreadId: "child", isPinned: true }),
          thread({ id: "other", title: "Foreign pinned thread", projectId: "proj_other", isPinned: true }),
        ],
        projects: [
          { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
          { id: "proj_other", name: "docs", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: true, inactiveAfterHours: 6 }),
        listLifecycle: () => ({
          rows: [
            { threadId: "settled", settledAt: now, snoozedUntil: null, snoozedAt: null },
            { threadId: "snoozed", settledAt: null, snoozedUntil: now + 3_600_000, snoozedAt: now },
            { threadId: "parked", settledAt: null, snoozedUntil: null, snoozedAt: null, parkedAt: now },
          ],
        }),
      },
    });
    await screen.findByRole("region", { name: "Inactive" });
    await screen.findByRole("region", { name: "Settled" });
    fireEvent.contextMenu(await screen.findByText("Choose my parent"));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Parent" }), { key: "ArrowRight" });
    const search = await screen.findByRole("textbox", { name: "Search parent threads" });
    const menu = search.closest<HTMLElement>('[role="menu"]')!;
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual([
      "None",
      "Settled parent",
      "Nested work",
      "Snoozed parent",
      "Active parent",
      "Parked parent",
      "Nested active work",
      "Pinned second",
      "Nested pinned work",
      "Pinned parent",
      "Orphan parent",
      "Older parent",
      "docs · Foreign pinned thread",
    ]);
    expect(within(menu).queryByRole("separator")).toBeNull();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Pinned parent" }).querySelector('[data-icon="Pin"]'),
    ).not.toBeNull();

    fireEvent.change(search, { target: { value: "pinned" } });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["None", "Pinned second", "Nested pinned work", "Pinned parent", "docs · Foreign pinned thread"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
    fireEvent.change(search, { target: { value: "docs" } });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["None", "docs · Foreign pinned thread"]);
    fireEvent.change(search, { target: { value: "older" } });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["None", "Older parent"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
    fireEvent.change(search, { target: { value: "settled" } });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["None", "Settled parent"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  async function openParentMenu(setThreadParent = vi.fn(() => ({ ok: true }))) {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "child", title: "Choose my parent", parentThreadId: "old" }),
          thread({ id: "old", title: "Current parent", isArchived: true }),
          thread({ id: "next", title: "Next parent" }),
          thread({ id: "descendant", title: "Forbidden child", parentThreadId: "child" }),
          thread({ id: "grandchild", title: "Forbidden grandchild", parentThreadId: "descendant" }),
          thread({ id: "other", title: "Other project", projectId: "proj_other" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), setThreadParent },
    });
    fireEvent.contextMenu(await screen.findByText("Choose my parent"));
    const trigger = within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Parent");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const search = await screen.findByRole("textbox", { name: "Search parent threads" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    return { menu: search.closest('[role="menu"]') as HTMLElement, setThreadParent };
  }

  it("searches safe candidates and assigns a parent with the keyboard", async () => {
    const { menu, setThreadParent } = await openParentMenu();
    expect(within(menu).queryByText("Choose my parent")).toBeNull();
    expect(within(menu).queryByText("Forbidden child")).toBeNull();
    expect(within(menu).queryByText("Forbidden grandchild")).toBeNull();
    expect(within(menu).queryByText("Other project")).toBeNull();
    expect(within(menu).getByRole("menuitemradio", { name: "Current parent" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const input = within(menu).getByRole("textbox", { name: "Search parent threads" });
    fireEvent.change(input, { target: { value: "NEXT" } });
    expect(within(menu).getByRole("menuitemradio", { name: "Next parent" })).toBeDefined();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "Next parent" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(setThreadParent).toHaveBeenCalledWith({ threadId: "child", parentThreadId: "next" }));
  });

  it("offers None even with no search matches and removes the parent", async () => {
    const { menu, setThreadParent } = await openParentMenu();
    fireEvent.change(within(menu).getByRole("textbox"), { target: { value: "no match" } });
    expect(within(menu).getByText("No matching threads")).toBeDefined();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "None" }));
    await waitFor(() => expect(setThreadParent).toHaveBeenCalledWith({ threadId: "child", parentThreadId: null }));
  });

  it("reports a rejected parent change", async () => {
    const { menu } = await openParentMenu(
      vi.fn(() => {
        throw new Error("Parent is no longer available");
      }),
    );
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Next parent" }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not update parent", {
        className: "bb-sidebar-toast",
        description: "Parent is no longer available",
      }),
    );
  });
});
