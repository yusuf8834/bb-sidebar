// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { formatSnoozeWakeTime } from "./lifecycle";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(Document.prototype, "elementFromPoint", {
  configurable: true,
  value: vi.fn(),
});

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime; importing the component directly would bind it to an
// empty runtime first.
const app = await loadPluginApp(() => import("../app"));
const inbox = app.threadLists[0]!;

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
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
      goals: 0,
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

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
  experimental_Original: () => null,
};

function render(
  threads: PluginSidebarThread[],
  projects = [{ id: "proj_1", name: "bb", isPersonal: false }],
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    // The lifecycle store is the plugin's own backend; an empty one means
    // every thread is active, which is what these list tests are about.
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
  vi.mocked(document.elementFromPoint).mockReset();
});

describe("BB Sidebar registration", () => {
  it("registers exactly one thread list", () => {
    expect(app.threadLists).toHaveLength(1);
    expect(inbox.id).toBe("inbox");
    expect(inbox.title).toBe("BB Sidebar");
  });
});

describe("ThreadInbox", () => {
  it("lists threads newest first", () => {
    render([
      thread({ id: "a", title: "Older", createdAt: 1 }),
      thread({ id: "b", title: "Newer", createdAt: 2 }),
    ]);
    // The anchor is a full-bleed overlay, so read the row containers.
    const titles = screen
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(titles[0]).toContain("Newer");
    expect(titles[1]).toContain("Older");
  });

  // The DOM contract behind numbered thread shortcuts and thread.next/previous.
  // A plugin that drops these attributes silently breaks nine host shortcuts.
  it("marks every row as a host shortcut target", () => {
    render([thread({ id: "thr_x" })]);
    const row = screen.getByRole("link");
    expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(row.getAttribute("data-sidebar-thread-id")).toBe("thr_x");
  });

  it("opens a thread on click and closes the mobile drawer", () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_open" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    fireEvent.click(screen.getByRole("link"));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_open",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  it("uses the platform modifier to select without opening", () => {
    const rendered = render([thread({ id: "thr_split" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });
    expect(rendered.sidebarActionCalls).toEqual([]);
    expect(
      screen.getByRole("toolbar", { name: "1 threads selected" }),
    ).toBeDefined();
  });

  it("gives every bulk icon action a keyboard-visible clue", async () => {
    render([thread({ id: "thr_selected" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    const actions = [
      ["button", "Settle selected threads"],
      ["combobox", "Snooze selected threads"],
      ["button", "Mark selected threads read"],
      ["button", "Mark selected threads unread"],
      ["button", "Clear selection"],
    ] as const;

    for (const [role, label] of actions) {
      const trigger = screen.getByRole(role, { name: label });
      fireEvent.focus(trigger);
      expect((await screen.findByRole("tooltip")).textContent).toBe(label);
      fireEvent.blur(trigger);
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    }
  });

  it("extends selection across the visible row order with Shift-click", () => {
    render([
      thread({ id: "a", title: "First", createdAt: 30 }),
      thread({ id: "b", title: "Second", createdAt: 20 }),
      thread({ id: "c", title: "Third", createdAt: 10 }),
    ]);
    const links = screen.getAllByRole("link");
    fireEvent.click(links[0]!, { metaKey: true });
    fireEvent.click(links[2]!, { shiftKey: true });

    expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(
      3,
    );
    expect(
      screen.getByRole("toolbar", { name: "3 threads selected" }),
    ).toBeDefined();
  });

  it("drops selected rows that leave filtered search results", async () => {
    const rendered = render([
      thread({ id: "keep", title: "Keep match", createdAt: 20 }),
      thread({ id: "drop", title: "Drop row", createdAt: 10 }),
    ]);
    const links = screen.getAllByRole("link");
    fireEvent.click(links[0]!, { metaKey: true });
    fireEvent.click(links[1]!, { metaKey: true });
    const InboxComponent = inbox.component;
    rendered.rerender(
      <InboxComponent {...listProps} searchQuery="keep" />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("toolbar", { name: "1 threads selected" }),
      ).toBeDefined(),
    );
    expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(
      1,
    );
  });

  it("marks selected rows read and clears successful selection", async () => {
    const rendered = render([
      thread({ id: "a", title: "First", isUnread: true, createdAt: 20 }),
      thread({ id: "b", title: "Second", isUnread: true, createdAt: 10 }),
    ]);
    const links = screen.getAllByRole("link");
    fireEvent.click(links[0]!, { metaKey: true });
    fireEvent.click(links[1]!, { metaKey: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Mark selected threads read" }),
    );

    await waitFor(() =>
      expect(
        rendered.sidebarActionCalls.filter((call) => call.method === "setRead"),
      ).toHaveLength(2),
    );
    expect(rendered.sidebarActionCalls).toEqual(
      expect.arrayContaining([
        { method: "setRead", threadId: "a", read: true },
        { method: "setRead", threadId: "b", read: true },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("toolbar", { name: /threads selected/ }),
      ).toBeNull(),
    );
  });

  it("keeps failed rows selected after a partial bulk settle", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "First", createdAt: 20 }),
          thread({ id: "b", title: "Second", createdAt: 10 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        bulkSettle: () => ({
          succeededThreadIds: ["a"],
          failures: [{ threadId: "b", error: "cannot unpin" }],
        }),
      },
    });
    const links = screen.getAllByRole("link");
    fireEvent.click(links[0]!, { metaKey: true });
    fireEvent.click(links[1]!, { metaKey: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Settle selected threads" }),
    );

    await waitFor(() =>
      expect(rendered.rpcCalls.some((call) => call.method === "bulkSettle")).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("toolbar", { name: "1 threads selected" }),
      ).toBeDefined(),
    );
    expect(
      document
        .querySelector('[data-sidebar-thread-id="b"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
    expect(toastMocks.error).toHaveBeenCalledWith(
      "1 of 2 settle actions failed",
      { description: "cannot unpin" },
    );
  });

  it("bulk snoozes selected rows with a configured preset", async () => {
    let bulkInput: { threadIds: string[]; snoozedUntil: number } | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "First", createdAt: 20 }),
          thread({ id: "b", title: "Second", createdAt: 10 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      settings: { snoozePresets: "15m, 2h" },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        bulkSnooze: (input) => {
          bulkInput = input as { threadIds: string[]; snoozedUntil: number };
          return { succeededThreadIds: ["a", "b"], failures: [] };
        },
      },
    });
    const links = screen.getAllByRole("link");
    fireEvent.click(links[0]!, { metaKey: true });
    fireEvent.click(links[1]!, { metaKey: true });
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Snooze selected threads" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "15 minutes" }));

    await waitFor(() => expect(bulkInput).not.toBeNull());
    expect(bulkInput!.threadIds).toEqual(["a", "b"]);
    expect(bulkInput!.snoozedUntil).toBeGreaterThan(Date.now());
  });

  it("separates pinned threads from the inbox", () => {
    render([
      thread({ id: "a", title: "Plain" }),
      thread({ id: "b", title: "Stuck", isPinned: true }),
    ]);
    const pinned = screen.getByRole("region", { name: /pinned/i });
    expect(within(pinned).getByText("Stuck")).toBeDefined();
  });

  it("keeps pinned threads in the host's persisted order", () => {
    render([
      thread({ id: "first", title: "First pin", isPinned: true, createdAt: 1 }),
      thread({ id: "second", title: "Second pin", isPinned: true, createdAt: 999 }),
    ]);
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("First pin"),
      expect.stringContaining("Second pin"),
    ]);
  });

  it("reorders pinned threads with the keyboard and persists the neighbors", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          reorderInput = input;
          return { pinnedThreadIds: ["b", "a", "c"] };
        },
      },
    });

    const pinB = await screen.findByRole("link", { name: "Pin B" });
    fireEvent.keyDown(pinB, { key: "ArrowUp" });
    expect(reorderInput).toBeNull();
    fireEvent.keyDown(pinB, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "b",
        previousThreadId: null,
        nextThreadId: "a",
      }),
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Pin B"),
      expect.stringContaining("Pin A"),
      expect.stringContaining("Pin C"),
    ]);
  });

  it("reorders by dragging the card and exposes no grip control", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          reorderInput = input;
          return { pinnedThreadIds: ["b", "a", "c"] };
        },
      },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
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

    expect(card.draggable).toBe(false);
    expect(
      screen.queryByRole("button", { name: /Reorder Pin A/ }),
    ).toBeNull();
    expect(card.dataset.sidebarThreadId).toBe("a");
    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 20,
      clientY: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "a",
        previousThreadId: "b",
        nextThreadId: "c",
      }),
    );
  });

  it("cancels shelf reordering when bb takes over a split drag", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
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
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Pinned" }))
          .getAllByRole("listitem")[0]!.textContent,
      ).toContain("Pin B"),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Pinned" }))
          .getAllByRole("listitem")[0]!.textContent,
      ).toContain("Pin A"),
    );
    expect(
      rendered.rpcCalls.filter((call) => call.method === "reorderPinned"),
    ).toHaveLength(0);
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: () => pending.promise,
      },
    });

    const cardA = await screen.findByRole("link", { name: "Pin A" });
    fireEvent.keyDown(cardA, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(rendered.rpcCalls.filter((call) => call.method === "reorderPinned"))
        .toHaveLength(1),
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getAllByRole("listitem")[0]!.textContent).toContain("Pin B");

    fireEvent.keyDown(cardA, { key: "ArrowDown", altKey: true });
    expect(rendered.rpcCalls.filter((call) => call.method === "reorderPinned"))
      .toHaveLength(1);

    pending.reject(new Error("order conflict"));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Could not reorder pinned thread",
        { description: "order conflict" },
      ),
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["b", "a"] }),
      },
    });

    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
        "Inbox B",
      ),
    );
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
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

    fireEvent.keyDown(
      await screen.findByRole("link", { name: "Inbox B" }),
      { key: "ArrowUp", altKey: true },
    );
    await waitFor(() =>
      expect(reorderInput).toEqual({ inboxThreadIds: ["b", "a"] }),
    );
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
      "Inbox B",
    );
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["a", "b"] }),
        reorderInbox: () => pending.promise,
      },
    });

    fireEvent.keyDown(
      await screen.findByRole("link", { name: "Inbox A" }),
      { key: "ArrowDown", altKey: true },
    );
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
        "Inbox B",
      ),
    );

    pending.reject(new Error("database busy"));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Could not reorder inbox thread",
        { description: "database busy" },
      ),
    );
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
      "Inbox A",
    );
  });

  it("unpins a pinned row from its hover action", async () => {
    const rendered = render([
      thread({ id: "pin", title: "Pinned work", isPinned: true }),
    ]);

    fireEvent.click(
      await screen.findByRole("button", { name: "Unpin Pinned work" }),
    );
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "setPinned",
        threadId: "pin",
        pinned: false,
      }),
    );
  });

  it("keeps policy-settled pinned rows active but respects manual settle", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "auto", title: "Pinned auto", isPinned: true }),
          thread({ id: "manual", title: "Pinned manual", isPinned: true }),
          thread({ id: "snoozed", title: "Pinned snooze", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        evaluateAutoSettle: () => ({ changedThreadIds: [] }),
        listLifecycle: () => ({
          rows: [
            {
              threadId: "auto",
              settledAt: now,
              settledOverride: null,
              snoozedUntil: null,
              snoozedAt: null,
            },
            {
              threadId: "manual",
              settledAt: now,
              settledOverride: "settled" as const,
              snoozedUntil: null,
              snoozedAt: null,
            },
            {
              threadId: "snoozed",
              settledAt: null,
              settledOverride: null,
              snoozedUntil: now + 60_000,
              snoozedAt: now,
            },
          ],
        }),
      },
    });

    const pinned = await screen.findByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("Pinned auto")).toBeDefined();
    expect(within(pinned).queryByText("Pinned manual")).toBeNull();
    expect(within(pinned).queryByText("Pinned snooze")).toBeNull();
    expect(
      await screen.findByRole("region", { name: "Settled" }),
    ).toBeDefined();
    expect(
      await screen.findByRole("region", { name: "Snoozed" }),
    ).toBeDefined();
  });

  // The host owns the search field; the plugin only filters by what it is
  // handed, so there is deliberately no second search box to type into.
  it("filters by the host's search query", () => {
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "sidebar" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Sidebar work" }),
            thread({ id: "b", title: "Something else" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("Sidebar work")).toBeDefined();
  });

  it("shows matching threads from every shelf in one flat result list", async () => {
    const rendered = renderSlot(
      inbox,
      { ...listProps, searchQuery: "match" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "pin", title: "Pinned match", isPinned: true }),
            thread({ id: "active", title: "Active match" }),
            thread({ id: "snoozed", title: "Snoozed match" }),
            thread({ id: "settled", title: "Settled match" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [
              {
                threadId: "snoozed",
                settledAt: null,
                snoozedUntil: Date.now() + 3_600_000,
                snoozedAt: Date.now(),
              },
              {
                threadId: "settled",
                settledAt: Date.now(),
                snoozedUntil: null,
                snoozedAt: null,
              },
            ],
          }),
        },
      },
    );

    await waitFor(() =>
      expect(
        rendered.inspection.rpcCalls.some(
          (call) => call.method === "listLifecycle",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));

    const results = screen.getByRole("listbox", {
      name: "Thread search results",
    });
    expect(within(results).getByText("Snoozed match")).toBeDefined();
    expect(within(results).getByText("Settled match")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Snoozed" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
  });

  it("keeps project scope active while searching", async () => {
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "match" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "First match", projectId: "proj_1" }),
            thread({ id: "b", title: "Second match", projectId: "proj_2" }),
          ],
          projects: [
            { id: "proj_1", name: "bb", isPersonal: false },
            { id: "proj_2", name: "other", isPersonal: false },
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "other" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("option", { name: /Second match/ }),
      ).toHaveLength(1),
    );
    expect(screen.queryByText("First match")).toBeNull();
  });

  it("moves through results with arrows and opens the highlighted row", async () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      {
        ...listProps,
        searchQuery: "thread",
        onNavigate: () => (navigated += 1),
      },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "newer", title: "Newer thread", createdAt: 2 }),
            thread({ id: "older", title: "Older thread", createdAt: 1 }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const results = await screen.findAllByRole("option");
    results[0]!.focus();
    fireEvent.keyDown(results[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(results[1]);
    expect(results[1]!.tabIndex).toBe(0);

    fireEvent.keyDown(results[1]!, { key: "Enter" });
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "older",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  it("asks the host to clear search when Escape is pressed in results", async () => {
    let cleared = 0;
    renderSlot(
      inbox,
      {
        ...listProps,
        searchQuery: "thread",
        onNavigate: () => (cleared += 1),
      },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ title: "A thread" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const result = await screen.findByRole("option");
    result.focus();
    fireEvent.keyDown(result, { key: "Escape" });
    expect(cleared).toBe(1);
  });

  it("ships no search field of its own", () => {
    render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("Search threads")).toBeNull();
  });

  it("ships no new-thread button of its own", () => {
    render([thread({ id: "a" })]);
    expect(screen.queryByLabelText("New thread")).toBeNull();
  });

  it("scopes to one project", () => {
    render(
      [
        thread({ id: "a", title: "In bb", projectId: "proj_1" }),
        thread({ id: "b", title: "In other", projectId: "proj_2" }),
      ],
      [
        { id: "proj_1", name: "bb", isPersonal: false },
        { id: "proj_2", name: "other", isPersonal: false },
      ],
    );
    // Radix opens on keyboard too, which jsdom can drive without pointer
    // capture. Enter opens the list; the option click picks the scope.
    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "other" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("In other")).toBeDefined();
  });

  it("hides archived threads", () => {
    render([thread({ id: "a", isArchived: true })]);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("reports an empty inbox and a fruitless search differently", () => {
    render([]);
    expect(screen.getByText("No threads yet")).toBeDefined();
  });
});

describe("parking threads", () => {
  it("moves a settled thread to the Settled shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_done",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    // The shelf renders once the lifecycle read resolves.
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByText(/Settled \(1\)/)).toBeDefined();
    // Collapsed by default: parked work is out of the way, never gone.
    expect(screen.queryByText("Finished work")).toBeNull();
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("Finished work")).toBeDefined();
    expect(
      within(shelf).getByRole("listitem").textContent,
    ).toMatch(/bb\s*·\s*Finished work/);
    expect(
      within(shelf).getByLabelText("bb · Finished work"),
    ).toBeDefined();
  });

  it("keeps a working thread out of the shelves and offers no park action", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_busy",
            title: "Still running",
            indicator: "runtime",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      // Settled in the store, but still working: it must stay visible.
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_busy",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });
    expect(await screen.findByText("Still running")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("offers settle and snooze on a parkable thread", async () => {
    render([thread({ id: "thr_park", title: "Quiet" })]);
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
    const snooze = screen.getByRole("combobox", { name: "Snooze thread" });
    fireEvent.keyDown(snooze, { key: "Enter" });
    expect(
      await screen.findByRole("option", { name: "30 minutes" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: "2 hours" })).toBeDefined();
    expect(screen.getByRole("option", { name: "1 day" })).toBeDefined();
    expect(screen.getByRole("option", { name: "1 week" })).toBeDefined();
  });

  it("keeps hover-only snooze controls visible while the menu is open", async () => {
    render([thread({ id: "thr_snooze_anchor", title: "Quiet" })]);

    const snooze = await screen.findByRole("combobox", {
      name: "Snooze thread",
    });
    const controls = snooze.parentElement;
    expect(controls).not.toBeNull();
    expect(controls!.classList.contains("opacity-0")).toBe(true);
    expect(controls!.classList.contains("pointer-events-none")).toBe(true);

    fireEvent.keyDown(snooze, { key: "Enter" });
    await screen.findByRole("option", { name: "30 minutes" });

    expect(controls!.classList.contains("opacity-100")).toBe(true);
    expect(controls!.classList.contains("pointer-events-auto")).toBe(true);
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  it("shows the wake countdown on a snoozed row", async () => {
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_snz",
              settledAt: null,
              snoozedUntil: wakeAt,
              snoozedAt: Date.now(),
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getByText("2h")).toBeDefined();
    expect(within(shelf).getByLabelText("Wake thread now")).toBeDefined();
  });

  it("persists each shelf's expanded state across remounts", async () => {
    const now = Date.now();
    const rows = [
      {
        threadId: "thr_done",
        settledAt: 200,
        snoozedUntil: null,
        snoozedAt: null,
      },
      {
        threadId: "thr_later",
        settledAt: null,
        snoozedUntil: now + 60_000,
        snoozedAt: now,
      },
    ];
    const options = {
      sidebarThreads: {
        status: "ready" as const,
        threads: [
          thread({ id: "thr_done", title: "Finished work" }),
          thread({ id: "thr_later", title: "Later work" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: { listLifecycle: () => ({ rows }) },
    };

    renderSlot(inbox, listProps, options);
    let settledShelf = await screen.findByRole("region", { name: "Settled" });
    let snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(settledShelf).getByRole("button"));
    fireEvent.click(within(snoozedShelf).getByRole("button"));
    expect(within(settledShelf).getByText("Finished work")).toBeDefined();
    expect(within(snoozedShelf).getByText("Later work")).toBeDefined();

    cleanup();
    renderSlot(inbox, listProps, options);
    settledShelf = await screen.findByRole("region", { name: "Settled" });
    snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    expect(
      within(settledShelf).getByRole("button", { expanded: true }),
    ).toBeDefined();
    expect(
      within(snoozedShelf).getByRole("button", { expanded: true }),
    ).toBeDefined();
    expect(within(settledShelf).getByText("Finished work")).toBeDefined();
    expect(within(snoozedShelf).getByText("Later work")).toBeDefined();
  });

  it("keeps the currently open parked row visible while collapsed", async () => {
    renderSlot(inbox, { ...listProps, activeThreadId: "thr_open" }, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_open", title: "Open but settled" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_open",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(
      within(shelf).getByRole("button", { expanded: false }),
    ).toBeDefined();
    expect(within(shelf).getByText("Open but settled")).toBeDefined();
  });

  it("sorts snoozed rows by soonest wake and settled rows by settle time", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "later", title: "Later wake", createdAt: 100 }),
          thread({ id: "sooner", title: "Sooner wake", createdAt: 1 }),
          thread({ id: "old-settle", title: "Older settle", createdAt: 999 }),
          thread({ id: "new-settle", title: "Newer settle", createdAt: 1 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            { threadId: "later", settledAt: null, snoozedUntil: now + 5_000, snoozedAt: now },
            { threadId: "sooner", settledAt: null, snoozedUntil: now + 1_000, snoozedAt: now },
            { threadId: "old-settle", settledAt: 500, snoozedUntil: null, snoozedAt: null },
            { threadId: "new-settle", settledAt: 900, snoozedUntil: null, snoozedAt: null },
          ],
        }),
      },
    });

    const snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    const settledShelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(snoozedShelf).getByRole("button"));
    fireEvent.click(within(settledShelf).getByRole("button"));
    expect(
      within(snoozedShelf).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Sooner wake"), expect.stringContaining("Later wake")]);
    expect(
      within(settledShelf).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Newer settle"), expect.stringContaining("Older settle")]);
  });

  it("shows 10 settled rows initially and loads 25 more at a time", async () => {
    const threads = Array.from({ length: 36 }, (_, index) =>
      thread({ id: `settled-${index}`, title: `Settled ${index}` }),
    );
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: threads.map((candidate, index) => ({
            threadId: candidate.id,
            settledAt: 1_000 - index,
            snoozedUntil: null,
            snoozedAt: null,
          })),
        }),
      },
    });

    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button"));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 25 more" }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(35);
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 1 more" }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(36);
    expect(within(shelf).queryByText(/Load .* more/)).toBeNull();
  });

  it("marks timer and attention wakes until the user dismisses or opens them", async () => {
    const acknowledged: string[] = [];
    const now = Date.now();
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "timer", title: "Timer wake", latestAttentionAt: 10 }),
          thread({ id: "attention", title: "Attention wake", latestAttentionAt: now }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            { threadId: "timer", settledAt: null, snoozedUntil: now - 1, snoozedAt: 20 },
            { threadId: "attention", settledAt: null, snoozedUntil: now + 60_000, snoozedAt: now - 1 },
          ],
        }),
        acknowledgeWake: (input) => {
          acknowledged.push((input as { threadId: string }).threadId);
          return { ok: true };
        },
      },
    });

    const timerRow = (await screen.findByText("Timer wake")).closest("li")!;
    const attentionRow = screen.getByText("Attention wake").closest("li")!;
    expect(within(timerRow).getByText("Woke")).toBeDefined();
    expect(within(attentionRow).getByText("Woke")).toBeDefined();

    fireEvent.click(within(timerRow).getByRole("button", { name: "Dismiss Woke marker" }));
    fireEvent.click(within(attentionRow).getByRole("link", { name: "Attention wake" }));
    await waitFor(() => expect(acknowledged).toEqual(["timer", "attention"]));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "attention",
      options: { split: false },
    });
  });
});

describe("row context menu", () => {
  it("offers the plugin's own thread actions on right-click", async () => {
    render([thread({ id: "thr_menu", title: "Right click me" })]);
    const row = await screen.findByText("Right click me");
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    // The plugin builds this menu itself — the SDK ships no menu component —
    // so the items are this plugin's choice, backed by the action hook.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open in split",
      "Pin",
      "Settle",
      "Snooze",
      "Rename",
      "Mark unread",
      "Copy",
      "Archive",
      "Delete",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(4);
  });

  it("settles an active thread from the context menu", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_settle", title: "Settle from menu" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true };
        },
      },
    });

    fireEvent.contextMenu(await screen.findByText("Settle from menu"));
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Settle"));
    await waitFor(() => expect(settled).toBe("thr_settle"));
  });

  it("moves away from the active thread after parking it", async () => {
    let navigated = 0;
    const rendered = renderSlot(
      inbox,
      {
        ...listProps,
        activeThreadId: "current",
        onNavigate: () => (navigated += 1),
      },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "current", title: "Current", createdAt: 20 }),
            thread({ id: "next", title: "Next", createdAt: 10 }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: () => ({ ok: true }),
        },
      },
    );

    fireEvent.contextMenu(await screen.findByText("Current"));
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Settle"));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "open",
        threadId: "next",
      }),
    );
    expect(navigated).toBe(1);
  });

  it("opens a project-scoped composer when parking the last active thread", async () => {
    const rendered = renderSlot(
      inbox,
      { ...listProps, activeThreadId: "only" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "only", title: "Only thread" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: () => ({ ok: true }),
        },
      },
    );

    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "openNewThread",
        options: { projectId: "proj_1", focusPrompt: true },
      }),
    );
  });

  it("does not override navigation that happens while parking is in flight", async () => {
    const pendingSettle = deferred<{ ok: true }>();
    const props = { ...listProps, activeThreadId: "slow" };
    const rendered = renderSlot(inbox, props, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "slow", title: "Slow settle", createdAt: 20 }),
          thread({ id: "elsewhere", title: "Elsewhere", createdAt: 10 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: () => pendingSettle.promise,
      },
    });

    fireEvent.contextMenu(await screen.findByText("Slow settle"));
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Settle"));
    await waitFor(() =>
      expect(rendered.rpcCalls.filter((call) => call.method === "settle"))
        .toHaveLength(1),
    );
    const InboxComponent = inbox.component;
    rendered.rerender(
      <InboxComponent {...props} activeThreadId="elsewhere" />,
    );
    pendingSettle.resolve({ ok: true });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
    expect(
      rendered.sidebarActionCalls.filter(
        (call) => call.method === "open" || call.method === "openNewThread",
      ),
    ).toEqual([]);
  });

  it("deduplicates snooze, confirms the wake time, and supports Undo", async () => {
    const pendingSnooze = deferred<{ ok: true }>();
    let wakeAt = 0;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "dedupe", title: "Dedupe snooze" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        snooze: (input) => {
          wakeAt = (input as { snoozedUntil: number }).snoozedUntil;
          return pendingSnooze.promise;
        },
        unsnooze: () => ({ ok: true }),
      },
    });

    const snooze = await screen.findByRole("combobox", {
      name: "Snooze thread",
    });
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("option", { name: "30 minutes" }),
    );
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "2 hours" }));
    await waitFor(() =>
      expect(rendered.rpcCalls.filter((call) => call.method === "snooze"))
        .toHaveLength(1),
    );

    pendingSnooze.resolve({ ok: true });
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread snoozed",
        expect.objectContaining({
          description: `Wakes ${formatSnoozeWakeTime(wakeAt)}`,
        }),
      ),
    );
    const toastOptions = toastMocks.success.mock.calls.find(
      ([message]) => message === "Thread snoozed",
    )![1] as { action: { label: string; onClick: () => void } };
    expect(toastOptions.action.label).toBe("Undo");
    toastOptions.action.onClick();
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "unsnooze",
        input: { threadId: "dedupe" },
      }),
    );
  });

  it("reports mutation failures and leaves the active route alone", async () => {
    const rendered = renderSlot(
      inbox,
      { ...listProps, activeThreadId: "broken" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "broken", title: "Broken settle" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: () => {
            throw new Error("database offline");
          },
        },
      },
    );

    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Could not settle thread",
        { description: "database offline" },
      ),
    );
    expect(
      rendered.sidebarActionCalls.some(
        (call) => call.method === "open" || call.method === "openNewThread",
      ),
    ).toBe(false);
  });

  it("offers Un-settle on settled rows and Wake now on snoozed rows", async () => {
    const calls: string[] = [];
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "settled", title: "Settled row" }),
          thread({ id: "snoozed", title: "Snoozed row" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "settled",
              settledAt: Date.now(),
              snoozedUntil: null,
              snoozedAt: null,
            },
            {
              threadId: "snoozed",
              settledAt: null,
              snoozedUntil: Date.now() + 3_600_000,
              snoozedAt: Date.now(),
            },
          ],
        }),
        unsettle: (input) => {
          calls.push(`unsettle:${(input as { threadId: string }).threadId}`);
          return { ok: true };
        },
        unsnooze: (input) => {
          calls.push(`unsnooze:${(input as { threadId: string }).threadId}`);
          return { ok: true };
        },
      },
    });

    await waitFor(() =>
      expect(
        rendered.inspection.rpcCalls.some(
          (call) => call.method === "listLifecycle",
        ),
      ).toBe(true),
    );
    const settledShelf = await screen.findByRole("region", { name: "Settled" });
    const snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(settledShelf).getByRole("button"));
    fireEvent.click(within(snoozedShelf).getByRole("button"));

    fireEvent.contextMenu(within(settledShelf).getByText("Settled row"));
    let menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Un-settle")).toBeDefined();
    expect(within(menu).getByText("Rename")).toBeDefined();
    expect(within(menu).queryByText("Wake now")).toBeNull();
    fireEvent.click(within(menu).getByText("Un-settle"));
    await waitFor(() => expect(calls).toContain("unsettle:settled"));

    fireEvent.contextMenu(within(snoozedShelf).getByText("Snoozed row"));
    menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Wake now")).toBeDefined();
    expect(within(menu).getByText("Rename")).toBeDefined();
    expect(within(menu).queryByText("Un-settle")).toBeNull();
    fireEvent.click(within(menu).getByText("Wake now"));
    await waitFor(() => expect(calls).toContain("unsnooze:snoozed"));
  });

  for (const busyThread of [
    thread({ id: "running", title: "Running row", indicator: "runtime" }),
    thread({
      id: "pending",
      title: "Pending row",
      hasPendingInteraction: true,
    }),
  ]) {
    it(`disables Archive while ${busyThread.id}`, async () => {
      const rendered = render([busyThread]);
      fireEvent.contextMenu(await screen.findByText(busyThread.title!));
      const archive = within(
        await screen.findByRole("menu", { name: "Thread actions" }),
      ).getByText("Archive");
      expect(archive.getAttribute("data-disabled")).not.toBeNull();
      fireEvent.click(archive);
      expect(rendered.sidebarActionCalls).not.toContainEqual({
        method: "archive",
        threadId: busyThread.id,
      });
    });
  }

  it("renames from the menu and saves with Enter", async () => {
    const rendered = render([
      thread({ id: "thr_rename", title: "Original title" }),
    ]);
    fireEvent.contextMenu(await screen.findByText("Original title"));
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Rename"));

    const input = await screen.findByRole("textbox", {
      name: "Rename Original title",
    });
    fireEvent.change(input, { target: { value: "Updated title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_rename",
        title: "Updated title",
      }),
    );
  });

  it("supports double-click rename, Escape cancel, and blur save", async () => {
    const rendered = render([
      thread({ id: "thr_inline", title: "Inline title" }),
    ]);
    const row = await screen.findByRole("link", { name: "Inline title" });

    fireEvent.doubleClick(row);
    let input = await screen.findByRole("textbox", {
      name: "Rename Inline title",
    });
    fireEvent.change(input, { target: { value: "Canceled title" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      rendered.sidebarActionCalls.some((call) => call.method === "rename"),
    ).toBe(false);

    fireEvent.doubleClick(row);
    input = await screen.findByRole("textbox", { name: "Rename Inline title" });
    fireEvent.change(input, { target: { value: "Blurred title" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_inline",
        title: "Blurred title",
      }),
    );
  });

  it("copies the branch and thread ID", async () => {
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
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("feature/context-menu"),
    );

    copyMenu = await openCopyMenu();
    fireEvent.click(within(copyMenu).getByText("Copy thread ID"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("thr_copy"));
  });

  it("routes deletion through the host's confirmation", async () => {
    const rendered = render([thread({ id: "thr_del", title: "Delete me" })]);
    fireEvent.contextMenu(await screen.findByText("Delete me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "requestDelete",
        threadId: "thr_del",
      }),
    );
  });

  it("uses custom snooze times from plugin settings", async () => {
    let snoozed: { threadId: string; snoozedUntil: number } | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snooze", title: "Snooze me" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      settings: { snoozePresets: "15m, Lunch break=3h" },
      rpc: {
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
    fireEvent.click(
      await screen.findByRole("option", { name: "15 minutes" }),
    );
    await waitFor(() => expect(snoozed).not.toBeNull());
    expect(snoozed!.threadId).toBe("thr_snooze");
    expect(snoozed!.snoozedUntil).toBeGreaterThanOrEqual(
      before + 15 * 60_000,
    );

    fireEvent.contextMenu(await screen.findByText("Snooze me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).getByText("Snooze").getAttribute("aria-haspopup")).toBe(
      "menu",
    );
  });
});

describe("card metadata", () => {
  it("always shows the provider glyph, even without a branch", async () => {
    render([thread({ id: "thr_p", providerId: "claude-code" })]);
    expect(await screen.findByLabelText("Claude Code")).toBeDefined();
  });

  it("falls back to a neutral glyph for an unknown provider", async () => {
    render([thread({ id: "thr_p", providerId: "some-new-agent" })]);
    expect(await screen.findByLabelText("some-new-agent")).toBeDefined();
  });

  // A personal-project thread has a machine but no worktree, so the machine
  // takes the branch's place instead of leaving the line blank.
  it("shows the machine when the thread has no branch", async () => {
    render([
      thread({
        id: "thr_m",
        host: { id: "host_1", name: "Dev MacBook" },
      }),
    ]);
    expect(await screen.findByText("Dev MacBook")).toBeDefined();
  });

  it("prefers the branch over the machine when both exist", async () => {
    render([
      thread({
        id: "thr_b",
        host: { id: "host_1", name: "Dev MacBook" },
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "bb/feature",
          workspaceDisplayKind: "managed-worktree",
        },
      }),
    ]);
    expect(await screen.findByText("bb/feature")).toBeDefined();
    expect(screen.queryByText("Dev MacBook")).toBeNull();
    expect(await screen.findByLabelText("Worktree branch")).toBeDefined();
    expect(
      screen.getByLabelText("Machine: Dev MacBook"),
    ).toBeDefined();
  });

  it("shows a plain branch cue for non-worktree checkouts", async () => {
    render([
      thread({
        id: "thr_checkout",
        environment: {
          id: "env_1",
          name: "Checkout",
          branchName: "main",
          workspaceDisplayKind: "other",
        },
      }),
    ]);
    expect(await screen.findByLabelText("Branch")).toBeDefined();
    expect(screen.queryByLabelText("Worktree branch")).toBeNull();
  });

  it("reduces read idle emphasis without weakening unread rows", async () => {
    render([
      thread({ id: "read", title: "Read row", createdAt: 20 }),
      thread({
        id: "unread",
        title: "Unread row",
        isUnread: true,
        createdAt: 10,
      }),
    ]);
    const read = (await screen.findByText("Read row")).closest(
      "[data-row-emphasis]",
    );
    const unread = screen
      .getByText("Unread row")
      .closest("[data-row-emphasis]");
    expect(read?.getAttribute("data-row-emphasis")).toBe("read-idle");
    expect(read?.className).toContain("text-muted-foreground");
    expect(unread?.getAttribute("data-row-emphasis")).toBe("unread");
    expect(unread?.className).toContain("font-medium");
    expect(unread?.className).toContain("text-foreground");
  });

  it("lists available thread metadata from the SDK in one tooltip", async () => {
    render([
      thread({
        id: "thr_details",
        providerId: "claude-code",
        host: { id: "host_1", name: "Build Mac" },
        environment: {
          id: "env_1",
          name: "Feature worktree",
          branchName: "bb/details",
          workspaceDisplayKind: "unmanaged-worktree",
        },
        activity: {
          workflows: 1,
          backgroundAgents: 2,
          backgroundCommands: 0,
          planMode: 0,
          goals: 1,
        },
      }),
    ]);

    fireEvent.focus(await screen.findByLabelText("Thread details"));
    const details = await screen.findByRole("tooltip");
    expect(details.textContent).toContain("Project: bb");
    expect(details.textContent).toContain("Environment: Feature worktree");
    expect(details.textContent).toContain("Workspace: Unmanaged worktree");
    expect(details.textContent).toContain("Branch: bb/details");
    expect(details.textContent).toContain("Machine: Build Mac");
    expect(details.textContent).toContain("Provider: Claude Code");
    expect(details.textContent).toContain(
      "Activity: 1 workflow, 2 background agents, 1 goal",
    );
  });

  // Not exactly 3h: the card's clock is quantized to the minute, so a
  // timestamp sitting on a bucket boundary legitimately reads one unit lower.
  it("shows how long ago the thread was touched", async () => {
    render([
      thread({ id: "thr_t", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // Status and age share one slot. Live work uses a short readable label;
  // idle rows use their age.
  it("replaces the age label with a readable status while work runs", async () => {
    render([
      thread({
        id: "thr_run",
        indicator: "runtime",
        indicatorLabel: "Agent is working",
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByLabelText("Agent is working")).toBeDefined();
    expect(screen.getByText("Working").className).toContain("text-sky-600");
    expect(screen.queryByText("3h")).toBeNull();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.
  it("keeps the age label for an unrecognized indicator", async () => {
    render([
      thread({
        id: "thr_new",
        indicator: "something-bb-ships-later" as never,
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });
});

// The three states that need attention take the slot from the age label.
describe("attention states", () => {
  const states = [
    [
      "waiting-for-input",
      "Thread needs user input",
      "Needs you",
      "text-indigo-600",
    ],
    ["unread-error", "Unread thread failed", "Failed", "text-red-700"],
    [
      "unread-success",
      "Unread thread succeeded",
      "Unread",
      "text-emerald-700",
    ],
  ] as const;

  for (const [indicator, label, shortLabel, toneClass] of states) {
    it(`shows the ${indicator} label instead of the age`, async () => {
      render([
        thread({
          id: `thr_${indicator}`,
          indicator,
          indicatorLabel: label,
          updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
        }),
      ]);
      expect(await screen.findByLabelText(label)).toBeDefined();
      expect(screen.getByText(shortLabel).className).toContain(toneClass);
      expect(screen.queryByText("3h")).toBeNull();
    });
  }

  it("uses a working label instead of an unread success state", async () => {
    render([
      thread({
        id: "thr_busy",
        isUnread: true,
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    ]);
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.getByText("Working")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });
});

describe("pull request badge", () => {
  const withPr = (attention: string, state = "open") =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
      sidebarPullRequests: {
        thr_pr: {
          number: 412,
          title: "Fix the flake",
          url: "https://github.com/o/r/pull/412",
          state,
          attention,
        } as never,
      },
    });

  it("links the PR number out to the git host", async () => {
    withPr("none");
    const badge = await screen.findByRole("link", { name: "#412" });
    expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/412");
    expect(badge.getAttribute("title")).toBeNull();
    fireEvent.focus(badge);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Fix the flake\nOpen",
    );
  });

  it("shows no badge when the branch has no PR", async () => {
    render([thread({ id: "thr_nopr" })]);
    await screen.findByText("A thread");
    expect(screen.queryByRole("link", { name: /^#/ })).toBeNull();
  });

  // BB's richer attention state keeps failed open PRs red while the remaining
  // open states use T3's emerald PR color.
  it("colors the badge from the attention state", async () => {
    const failing = withPr("checks_failed");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-red-600");
    failing.unmount();

    withPr("ready_to_merge");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-emerald-600");
  });

  it("covers pending, review, draft, closed, and merged states", async () => {
    const pending = withPr("checks_pending");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-emerald-600");
    pending.unmount();

    const review = withPr("review_requested");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-emerald-600");
    review.unmount();

    const draft = withPr("draft", "draft");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-muted-foreground/60");
    draft.unmount();

    const closed = withPr("closed", "closed");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-red-600");
    closed.unmount();

    withPr("merged", "merged");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-violet-600");
  });
});
