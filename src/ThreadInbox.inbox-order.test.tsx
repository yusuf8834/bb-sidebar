// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { inbox, defaultSidebarSettings, thread, listProps, deferred, toastMocks, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("drops against the inbox order the host pushed mid-drag", async () => {
    const storedSettings = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...{
        inactiveThreadsEnabled: true,
        inactiveAfterHours: 6,
      },
    };
    localStorage.setItem("bb-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

    const now = Date.now();
    let storedIds = ["a", "b", "z"];
    let reorderInput: { inboxThreadIds: string[] } | null = null;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "a",
            title: "Inbox A",
            createdAt: 3,
            updatedAt: now - 60 * 60 * 1_000,
          }),
          thread({
            id: "b",
            title: "Inbox B",
            createdAt: 2,
            updatedAt: now - 60 * 60 * 1_000,
          }),
          // Inactive, so it holds a slot in the saved order without being a
          // drop target. That is what makes a stale base observable.
          thread({
            id: "z",
            title: "Inbox Z",
            createdAt: 1,
            updatedAt: now - 7 * 60 * 60 * 1_000,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => storedSettings,
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: storedIds }),
        reorderInbox: (input) => {
          const parsed = input as { inboxThreadIds: string[] };
          reorderInput = parsed;
          return { inboxThreadIds: parsed.inboxThreadIds };
        },
      },
    });

    const card = await screen.findByRole("link", { name: "Inbox A" });
    const target = screen.getByText("Inbox B").closest("li")!;
    vi.mocked(document.elementFromPoint).mockReturnValue(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 20,
      clientY: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });

    storedIds = ["z", "a", "b"];
    await rendered.emitRealtime("inbox-order", {});

    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });

    // Merged against ["z", "a", "b"]. Against the pointer-down base it would
    // have been ["b", "a", "z"], silently reverting the push.
    await waitFor(() => expect(reorderInput).toEqual({ inboxThreadIds: ["z", "b", "a"] }));
  });

  it("rolls back a failed reorder and ignores another move while saving", async () => {
    const pending = deferred<{ pinnedThreadIds: string[] }>();
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: () => pending.promise,
      },
    });

    const cardA = await screen.findByRole("link", { name: "Pin A" });
    fireEvent.keyDown(cardA, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(rendered.rpcCalls.filter((call) => call.method === "reorderPinned")).toHaveLength(1));
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getAllByRole("listitem")[0]!.textContent).toContain("Pin B");

    fireEvent.keyDown(cardA, { key: "ArrowDown", altKey: true });
    expect(rendered.rpcCalls.filter((call) => call.method === "reorderPinned")).toHaveLength(1);

    pending.reject(new Error("order conflict"));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not reorder pinned thread", {
        className: "bb-sidebar-toast",
        description: "order conflict",
      }),
    );
    expect(within(pinned).getAllByRole("listitem")[0]!.textContent).toContain("Pin A");
  });

  it("applies the plugin's durable order to inbox threads", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Inbox A", createdAt: 2 }),
          thread({ id: "b", title: "Inbox B", createdAt: 1 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["b", "a"] }),
      },
    });

    await waitFor(() => expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Inbox B"));
  });

  it.each(["Active", "Inactive"])("keeps %s order on remount while the saved order reloads", async (shelf) => {
    const sidebarThreads = {
      status: "ready" as const,
      threads: [
        thread({ id: "a", title: "Inbox A", createdAt: 2 }),
        thread({ id: "b", title: "Inbox B", createdAt: 1 }),
      ],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    };
    const settings = { ...defaultSidebarSettings, inactiveThreadsEnabled: shelf === "Inactive" };
    const first = renderSlot(inbox, listProps, {
      sidebarThreads,
      rpc: {
        getSidebarSettings: () => settings,
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["b", "a"] }),
      },
    });
    await screen.findByRole("region", { name: shelf });
    if (shelf === "Inactive") {
      fireEvent.click(within(screen.getByRole("region", { name: shelf })).getByRole("button", { expanded: false }));
    }
    const titles = () =>
      within(screen.getByRole("region", { name: shelf }))
        .getAllByRole("listitem")
        .map((item) => item.textContent);
    await waitFor(() => expect(titles()[0]).toContain("Inbox B"));
    first.lifecycle.unmount();

    const pending = deferred<{ inboxThreadIds: string[] }>();
    const second = renderSlot(inbox, listProps, {
      sidebarThreads,
      rpc: {
        getSidebarSettings: () => settings,
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => pending.promise,
      },
    });
    // Assert the first render, before any RPC can restore the saved order.
    expect(titles()[0]).toContain("Inbox B");
    await act(async () => pending.reject(new Error("temporarily offline")));
    expect(titles()[0]).toContain("Inbox B");
    second.lifecycle.unmount();
  });

  it("uses saved disabled inactivity even when the legacy setting is enabled", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads: [thread()], projects: [] },
      settings: { inactiveThreadsEnabled: true, inactiveAfterHours: "6" },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Inactive" })).toBeNull());
    expect(screen.getByRole("link", { name: "A thread" })).toBeDefined();
  });

  it("reorders inbox threads with the keyboard and persists the full order", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Inbox A", createdAt: 2 }),
          thread({ id: "b", title: "Inbox B", createdAt: 1 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["a", "b"] }),
        reorderInbox: (input) => {
          reorderInput = input;
          return { inboxThreadIds: ["b", "a"] };
        },
      },
    });

    fireEvent.keyDown(await screen.findByRole("link", { name: "Inbox B" }), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(reorderInput).toEqual({ inboxThreadIds: ["b", "a"] }));
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Inbox B");
    expect(JSON.parse(localStorage.getItem("bb-sidebar:inbox-order-cache:v1")!)).toEqual(["b", "a"]);
  });

  it("does not let a stale order refresh overwrite a successful reorder", async () => {
    const staleRead = deferred<{ inboxThreadIds: string[] }>();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Inbox A", createdAt: 2 }),
          thread({ id: "b", title: "Inbox B", createdAt: 1 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => staleRead.promise,
        reorderInbox: () => ({ inboxThreadIds: ["b", "a"] }),
      },
    });

    fireEvent.keyDown(screen.getByRole("link", { name: "Inbox B" }), {
      key: "ArrowUp",
      altKey: true,
    });
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Inbox B"));

    await act(async () => staleRead.resolve({ inboxThreadIds: ["a", "b"] }));
    expect(JSON.parse(localStorage.getItem("bb-sidebar:inbox-order-cache:v1")!)).toEqual(["b", "a"]);
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Inbox B");
  });

  it("rolls inbox order back when persistence fails", async () => {
    const pending = deferred<{ inboxThreadIds: string[] }>();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Inbox A", createdAt: 2 }),
          thread({ id: "b", title: "Inbox B", createdAt: 1 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["a", "b"] }),
        reorderInbox: () => pending.promise,
      },
    });

    fireEvent.keyDown(await screen.findByRole("link", { name: "Inbox A" }), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Inbox B"));

    pending.reject(new Error("database busy"));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not reorder inbox thread", {
        className: "bb-sidebar-toast",
        description: "database busy",
      }),
    );
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Inbox A");
  });
});
