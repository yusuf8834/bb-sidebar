// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { app, inbox, sidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("BB Sidebar registration", () => {
  it("opens project settings and confirms project edits from the card menu", async () => {
    const renameProject = vi.fn(() => ({ ok: true }));
    const removeProject = vi.fn(() => ({ ok: true }));
    const addProjectPath = vi.fn(() => ({ ok: true }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ title: "Project card" })],
        projects: [
          { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "/settings/projects/proj_1" },
        ],
      },
      context: { projectId: "proj_other", threadId: "thr_other" },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        projectPathHosts: () => ({ hosts: [{ id: "host_2", name: "Laptop" }] }),
        renameProject,
        removeProject,
        addProjectPath,
      },
    });
    const openMenu = async () => {
      fireEvent.contextMenu(await screen.findByText("Project card"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Project" }));
      return (await screen.findByText("Project settings")).closest<HTMLElement>('[role="menu"]')!;
    };
    const settingsMenu = await openMenu();
    expect(settingsMenu.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(within(settingsMenu).getByText("Project settings").getAttribute("href")).toBe("/settings/projects/proj_1");
    fireEvent.keyDown(settingsMenu, { key: "Escape" });

    fireEvent.click(within(await openMenu()).getByText("Rename project"));
    let dialog = await screen.findByRole("dialog", { name: "Rename project" });
    expect(dialog.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(dialog.hasAttribute("data-bb-portaled-overlay")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByText("Save"));
    await waitFor(() => expect(renameProject).toHaveBeenCalledWith({ projectId: "proj_1", name: "Renamed" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const menu = await openMenu();
    await waitFor(() => expect(within(menu).getByText("Add local path").getAttribute("data-disabled")).toBeNull());
    fireEvent.click(within(menu).getByText("Add local path"));
    dialog = await screen.findByRole("dialog", { name: "Add local path" });
    fireEvent.change(within(dialog).getByLabelText("Folder path"), { target: { value: "/workspace/bb" } });
    fireEvent.click(within(dialog).getByText("Save"));
    await waitFor(() =>
      expect(addProjectPath).toHaveBeenCalledWith({ projectId: "proj_1", hostId: "host_2", path: "/workspace/bb" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu()).getByText("Remove project"));
    dialog = await screen.findByRole("dialog", { name: "Remove project" });
    expect((within(dialog).getByRole("button", { name: "Remove project" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(removeProject).not.toHaveBeenCalled();
    fireEvent.click(within(await openMenu()).getByText("Remove project"));
    dialog = await screen.findByRole("dialog", { name: "Remove project" });
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "bb" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(removeProject).toHaveBeenCalledWith({ projectId: "proj_1", confirmation: "bb" }));
    expect(rendered.navigateCalls).toEqual([]);
  });

  it("registers exactly one thread list", () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
    expect(inbox.title).toBe("BB Sidebar");
  });

  it("registers one custom settings page", () => {
    expect(app.settingsSections).toHaveLength(1);
    expect(sidebarSettings.id).toBe("sidebar-settings");
    expect(sidebarSettings.title).toBeUndefined();
  });
});

describe("Project settings menu item", () => {
  const project = {
    id: "proj_1",
    name: "bb",
    isPersonal: false,
    href: "/projects/proj_1",
    settingsHref: "/settings/projects/proj_1",
  };

  async function openProjectSettingsItem() {
    renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads: [thread({ title: "Project card" })], projects: [project] },
      rpc: { listLifecycle: () => ({ rows: [] }), projectPathHosts: () => ({ hosts: [] }) },
    });
    const row = screen.getByRole("link", { name: "Project card" });
    // The row had focus before the right-click, e.g. after opening the thread.
    act(() => row.focus());
    await screen.findByRole("dialog", { name: "Thread details" });
    // A real right-click: pointerdown closes the hover card, then the menu opens.
    fireEvent.pointerDown(row, { button: 2, pointerType: "mouse" });
    fireEvent.pointerUp(document, { button: 2, pointerType: "mouse" });
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Project" }));
    const item = await screen.findByRole("menuitem", { name: "Project settings" });
    return { row, item };
  }

  it("links Project settings to bb's settings route, not the legacy redirect", async () => {
    const { item } = await openProjectSettingsItem();
    expect(item.getAttribute("href")).toBe("/settings/projects/proj_1");
  });

  it("does not hand focus back to the row, which would reopen its hover card over the settings page", async () => {
    const { row, item } = await openProjectSettingsItem();
    fireEvent.click(item);
    // Radix returns focus on the next tick after the menu unmounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull();
    expect(document.activeElement).not.toBe(row);
    expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
  });

  it("still returns focus to the row when the menu closes without navigating", async () => {
    const { row } = await openProjectSettingsItem();
    const menu = screen.getByRole("menu", { name: "Thread actions" });
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Project" }), { key: "Escape" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
