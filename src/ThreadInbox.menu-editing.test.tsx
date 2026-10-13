// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { DEFAULT_SNOOZE_PRESET_CONFIG } from "./lifecycle";
import {
  inbox,
  defaultSidebarSettings,
  thread,
  defaultProviders,
  listProps,
  render,
  deferred,
  toastMocks,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  it("regenerates from the menu and disables repeated clicks while waiting", async () => {
    const result = deferred<{ title: string }>();
    const regenerateTitle = vi.fn((_input: unknown) => result.promise);
    renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads: [thread({ title: "Original title" })], projects: [] },
      rpc: { listLifecycle: () => ({ rows: [] }), regenerateTitle },
    });
    fireEvent.contextMenu(await screen.findByText("Original title"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate title" }));
    await waitFor(() => expect(regenerateTitle).toHaveBeenCalledTimes(1));
    expect(regenerateTitle.mock.calls[0]?.[0]).toEqual({ threadId: "thr_1" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("status", { name: "Generating title" })).toBeTruthy();
    fireEvent.contextMenu(screen.getByText("Original title"));
    expect(screen.getByRole("menuitem", { name: "Regenerating title…" }).getAttribute("aria-disabled")).toBe("true");
    result.resolve({ title: "New title" });
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith("Thread title regenerated", { className: "bb-sidebar-toast" }),
    );
    expect(screen.queryByRole("status", { name: "Generating title" })).toBeNull();
    expect(regenerateTitle).toHaveBeenCalledTimes(1);
  });

  it("shows regeneration errors and keeps the existing title", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads: [thread({ title: "Original title" })], projects: [] },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        regenerateTitle: () => {
          throw new Error("Title service unavailable");
        },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Original title"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate title" }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not regenerate title", {
        className: "bb-sidebar-toast",
        description: "Title service unavailable",
      }),
    );
    expect(screen.getByText("Original title")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Generating title" })).toBeNull();
  });

  it("renames from the menu and saves with Enter", async () => {
    const rendered = render([thread({ id: "thr_rename", title: "Original title" })]);
    const row = await screen.findByRole("link", { name: "Original title" });
    act(() => row.focus());
    fireEvent.contextMenu(row);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Rename"));

    const input = await screen.findByRole("textbox", {
      name: "Rename Original title",
    });
    // Let the menu's deferred focus restoration finish before typing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);
    fireEvent.change(input, { target: { value: "Updated title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(rendered.sdkCalls).toContainEqual({
        method: "threads.update",
        args: [{ threadId: "thr_rename", title: "Updated title" }],
      }),
    );
  });

  it("supports double-click rename, Escape cancel, and blur save", async () => {
    const rendered = render([thread({ id: "thr_inline", title: "Inline title" })]);
    const row = await screen.findByRole("link", { name: "Inline title" });

    fireEvent.doubleClick(row);
    let input = await screen.findByRole("textbox", {
      name: "Rename Inline title",
    });
    fireEvent.change(input, { target: { value: "Canceled title" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(rendered.sdkCalls.some((call) => call.method === "threads.update")).toBe(false);

    fireEvent.doubleClick(row);
    input = await screen.findByRole("textbox", { name: "Rename Inline title" });
    fireEvent.change(input, { target: { value: "Blurred title" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(rendered.sdkCalls).toContainEqual({
        method: "threads.update",
        args: [{ threadId: "thr_inline", title: "Blurred title" }],
      }),
    );
  });

  it("copies the branch, thread ID, and thread link", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render([
      thread({
        id: "thr_copy",
        title: "Copy data",
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "feature/context-menu",
          workspaceDisplayKind: "managed-worktree",
          path: null,
          isWorktree: null,
          providerId: null,
        },
      }),
    ]);

    const openCopyMenu = async () => {
      fireEvent.contextMenu(await screen.findByText("Copy data"));
      const menu = await screen.findByRole("menu", { name: "Thread actions" });
      const copy = within(menu).getByRole("menuitem", { name: "Copy" });
      fireEvent.click(copy);
      const firstCopyAction = await screen.findByText("Copy branch");
      return firstCopyAction.closest<HTMLElement>('[role="menu"]')!;
    };

    let copyMenu = await openCopyMenu();
    fireEvent.click(within(copyMenu).getByText("Copy branch"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feature/context-menu"));

    copyMenu = await openCopyMenu();
    fireEvent.click(within(copyMenu).getByText("Copy thread ID"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("thr_copy"));

    copyMenu = await openCopyMenu();
    fireEvent.click(within(copyMenu).getByText("Copy thread link"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/proj_1/threads/thr_copy`),
    );
  });

  it("copies personal thread links and reports clipboard failures", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      [thread({ id: "thr_personal", title: "Personal thread" })],
      [{ id: "proj_1", name: "Personal", isPersonal: true, href: "", settingsHref: "" }],
    );
    const copyLink = async () => {
      fireEvent.contextMenu(await screen.findByText("Personal thread"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
      fireEvent.click(await screen.findByText("Copy thread link"));
    };
    await copyLink();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/threads/thr_personal`));
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    await copyLink();
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to copy thread link", { className: "bb-sidebar-toast" }),
    );
  });

  it("confirms deletion with the thread title and project before deleting", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_del", title: "Delete me" }),
          thread({ id: "thr_child", title: "Child", parentThreadId: "thr_del" }),
          thread({ id: "thr_grandchild", title: "Grandchild", parentThreadId: "thr_child" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: { status: "ready", providers: defaultProviders },
      rpc: { listLifecycle: () => ({ rows: [] }), deleteThread: () => ({ ok: true }) },
    });
    fireEvent.contextMenu(await screen.findByText("Delete me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));

    const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
    expect(within(dialog).getByText("Delete me")).toBeTruthy();
    expect(within(dialog).getByText("bb")).toBeTruthy();
    expect(within(dialog).getByText(/its 2 child threads/)).toBeTruthy();
    expect(rendered.rpcCalls.filter((call) => call.method === "deleteThread")).toEqual([]);
    expect(rendered.threadActionCalls).not.toContainEqual(expect.objectContaining({ key: "bb--core/delete" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete thread" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "deleteThread",
        input: { threadId: "thr_del", childThreadsConfirmed: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete thread?" })).toBeNull());
  });

  it("cancelling the delete confirmation deletes nothing", async () => {
    const rendered = render([thread({ id: "thr_keep", title: "Keep me" })]);
    fireEvent.contextMenu(await screen.findByText("Keep me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));
    const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete thread?" })).toBeNull());
    expect(rendered.rpcCalls.filter((call) => call.method === "deleteThread")).toEqual([]);
  });

  it("uses custom snooze times from server settings", async () => {
    const storedSettings = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      inactiveThreadsEnabled: false,
      ...{ snoozePresets: "15m, Lunch break=3h" },
    };
    localStorage.setItem("bb-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

    let snoozed: { threadId: string; snoozedUntil: number } | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snooze", title: "Snooze me" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => storedSettings,
        listLifecycle: () => ({ rows: [] }),
        snooze: (input) => {
          snoozed = input as { threadId: string; snoozedUntil: number };
          return { ok: true };
        },
      },
    });

    const before = Date.now();
    const snooze = await screen.findByRole("combobox", {
      name: "Snooze thread",
    });
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "15 minutes" }));
    await waitFor(() => expect(snoozed).not.toBeNull());
    expect(snoozed!.threadId).toBe("thr_snooze");
    expect(snoozed!.snoozedUntil).toBeGreaterThanOrEqual(before + 15 * 60_000);

    fireEvent.contextMenu(await screen.findByText("Snooze me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Snooze").getAttribute("aria-haspopup")).toBe("menu");
  });

  it.each(["clock", "context"])("uses the five calendar presets from the %s menu", async (menuType) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 5, 22));
    try {
      const snooze = vi.fn(() => ({ ok: true }));
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_calendar", title: "Calendar snooze", updatedAt: Date.now() })],
          projects: [],
        },
        rpc: {
          getSidebarSettings: () => ({ ...defaultSidebarSettings, snoozePresets: DEFAULT_SNOOZE_PRESET_CONFIG }),
          listLifecycle: () => ({ rows: [] }),
          snooze,
        },
      });
      let menu: HTMLElement;
      if (menuType === "clock") {
        fireEvent.keyDown(await screen.findByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
        menu = await screen.findByRole("listbox");
      } else {
        fireEvent.contextMenu(await screen.findByText("Calendar snooze"));
        fireEvent.click(await screen.findByRole("menuitem", { name: "Snooze" }));
        menu = (await screen.findByRole("menuitem", { name: "1 hour" })).closest<HTMLElement>('[role="menu"]')!;
      }
      const role = menuType === "clock" ? "option" : "menuitem";
      expect(
        within(menu)
          .getAllByRole(role)
          .slice(0, 5)
          .map((item) => item.textContent),
      ).toEqual(["1 hour", "Wait refresh (5 hours)", "This evening", "Tomorrow morning", "Next week"]);
      const evening = within(menu).getByRole(role, { name: "This evening" });
      expect(evening.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(evening);
      expect(snooze).not.toHaveBeenCalled();
      // An open menu must resolve against the date when the user selects it.
      vi.setSystemTime(new Date(2026, 0, 6, 0, 1));
      fireEvent.click(within(menu).getByRole(role, { name: "Tomorrow morning" }));
      await waitFor(() =>
        expect(snooze).toHaveBeenCalledWith({
          threadId: "thr_calendar",
          snoozedUntil: new Date(2026, 0, 7, 9).getTime(),
        }),
      );
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
