// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { idleSidebarThreadFields } from "./test-fixtures";
import { DEFAULT_SNOOZE_PRESET_CONFIG, formatSnoozeWakeTime } from "./lifecycle";
import { isWorkingTree } from "./working-tree";
import { projectColorsById } from "./project-colors";
import { WORKING_EMPTY_LINES } from "./working-empty-lines";
import type { SidebarProvider } from "./ProviderGlyph";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  dismiss: vi.fn(),
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
const { RowContextMenu } = await import("./RowContextMenu");
function PolicyMenu({ selected, actions = {} }: {
  selected: PluginSidebarThread;
  actions?: Omit<Parameters<typeof RowContextMenu>[0], "thread" | "children">;
}) {
  return <RowContextMenu thread={selected} {...actions}><button>Policy row</button></RowContextMenu>;
}
const inbox = app.threadLists[0]!;
const sidebarSettings = app.settingsSections[0]!;

/** A settle that found no runtime loaded and no terminals to report. */
const SETTLED_NOTHING = {
  closedTerminals: 0,
  keptTerminals: 0,
  stoppedRuntime: false,
};

const defaultSidebarSettings = {
  snoozePresets: "30m, 2h, 1d, 1w",
  inactiveThreadsEnabled: true,
  inactiveAfterHours: 6,
  showRunningChildrenWhenCollapsed: true,
  autoSettleInactive: true,
  autoSettleAfterDays: 3,
  autoSettleOnMerge: true,
  childSortField: "created",
  childSortDirection: "ascending",
  childIconStyle: "disc",
  compactWorkingThreads: false,
  workingShelf: false,
  dockShelves: false,
  projectColorsEnabled: false,
  projectColorDisplay: "all",
};

let nextPinnedKey = 0;

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    // Confirmed pins carry keys in canonical BB; explicit null models a provisional pin.
    ...(overrides.isPinned ? { pinnedAt: 100, pinSortKey: `U${String(nextPinnedKey++).padStart(6, "0")}U` } : {}),
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

function provider(
  id: string,
  displayName: string,
  logoUrl: string | null,
): SidebarProvider {
  return {
    id,
    pluginId: `provider-${id}`,
    displayName,
    available: true,
    completedTurnDisplay: "collapse",
    maintenance: {
      health: true,
      usage: false,
      installation: true,
    },
    logoUrl,
    capabilities: {
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
      supportsFork: true,
      supportsNativeUserQuestion: false,
      supportsServiceTier: false,
      supportsSessionRewind: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
    },
    composerActions: [],
  };
}

const defaultProviders = [
  provider("codex", "Codex", "/api/v1/system/providers/codex/logo"),
  provider(
    "claude-code",
    "Claude Code",
    "/api/v1/system/providers/claude-code/logo",
  ),
];

const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
  Original: () => null,
};

it("shows direct subthreads in the hover card and opens them by keyboard or click", async () => {
  const rendered = render([
    thread({ id: "parent", title: "Parent work" }),
    thread({ id: "b", parentThreadId: "parent", title: "Review", createdAt: 20, providerId: "claude-code", hasPendingInteraction: true }),
    thread({ id: "a", parentThreadId: "parent", title: null, titleFallback: "Implementation", createdAt: 10, indicator: "runtime", indicatorLabel: "Working" }),
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
  const items = within(list).getAllByRole("button");
  expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
    "Open subthread: Implementation", "Open subthread: Review",
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
  fireEvent.click(within(reopened).getByRole("button", { name: "Open subthread: Review" }));
  expect(rendered.sidebarActionCalls).toContainEqual({ method: "open", threadId: "b" });
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
  expect(rendered.sidebarActionCalls).toEqual([]);
  fireEvent.click(toggle);
  const source = within(details).getByRole("button", { name: "Open subthread: Child" });
  expect(source.draggable).toBe(false);
  fireEvent.pointerDown(source, { button: 0 });
  expect(rendered.sidebarActionCalls).toEqual([{ method: "open", threadId: "child" }]);
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
      reorderPinned: () => { mutations.push("reorderPinned"); return null; },
      reorderInbox: () => { mutations.push("reorderInbox"); return null; },
      setThreadParent: () => { mutations.push("setThreadParent"); return null; },
    },
  });
  for (const [relation, title, id] of [["child", "Child", "child"], ["grandchild", "Grandchild", "grandchild"]]) {
    const source = screen.getByRole("button", { name: new RegExp(`^Open ${relation} thread: ${title}`) });
    expect(source.draggable).toBe(false);
    expect(source.closest("[data-sidebar-thread-shortcut-target]")).toBeNull();
    fireEvent.pointerDown(source, { button: 0, clientX: 20, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 20, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 20, clientY: 100, pointerId: 1 });
    expect(rendered.sidebarActionCalls.at(-1)).toEqual({ method: "open", threadId: id });
  }
  expect(rendered.sidebarActionCalls).toHaveLength(2);
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
    expect(within(list).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Open subthread: New", "Open subthread: Old",
    ]);
  });
});

it("shows port details in the thread hover card", async () => {
  localStorage.setItem("bb-sidebar:port-link-host:v1", "host_local");
  const openUrl = vi.fn(() => true);
  renderSlot(inbox, listProps, {
    openUrl,
    sidebarThreads: {
      status: "ready",
      threads: [thread({ title: "Port details", host: { id: "host_local", name: "Local" }, environment: {
        id: "env_ports", name: null, branchName: "main", workspaceDisplayKind: "other", path: null, isWorktree: null, providerId: null
      } })],
      projects: [],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getOpenPorts: () => ({ groups: [{ environmentId: "env_ports", ports: [
        { port: 3000, processName: "node", pid: 1234, address: "127.0.0.1", source: "process" },
        { port: 5432, service: "postgres", container: "app-db-1", address: "0.0.0.0", source: "docker" },
      ] }] }),
      getThreadExecutionDetails: () => null,
    },
  });
  fireEvent.pointerMove(screen.getByRole("link", { name: "Port details" }), { pointerType: "mouse" });
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  expect(details.textContent).toContain("Workspace ports (2)");
  expect(details.textContent).not.toContain(":3000 node");
  const toggle = within(details).getByRole("button", { name: /Workspace ports/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(details.textContent).toContain(":3000 node");
  expect(details.textContent).toContain("127.0.0.1 · PID 1234");
  expect(details.textContent).toContain(":5432 postgres");
  expect(details.textContent).toContain("Docker · app-db-1");
  expect(within(details).getByRole("button", { name: "Stop process on port 3000" })).toBeDefined();
  // Docker containers are stopped with Docker, not by signalling a PID.
  expect(within(details).queryByRole("button", { name: "Stop process on port 5432" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Open ports started by this thread" })).toBeNull();
  const portLink = screen.getAllByRole("link", { name: "Open port 3000" })[0]!;
  expect(portLink.getAttribute("href")).toBe("http://127.0.0.1:3000/");
  fireEvent.click(portLink);
  expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:3000/");
  const row = screen.getByRole("link", { name: "Port details" });
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Tab" });
  expect(document.activeElement).toBe(toggle);
  fireEvent.keyDown(toggle, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
  expect(document.activeElement).toBe(row);

});

it("keeps a long workspace port list accessible even without local links", async () => {
  renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", projects: [], threads: [thread({ title: "Many ports", environment: {
      id: "env_ports", name: null, branchName: "main", workspaceDisplayKind: "other", path: null, isWorktree: null, providerId: null
    } })] },
    rpc: {
      listLifecycle: () => ({ rows: [] }), getThreadExecutionDetails: () => null,
      getOpenPorts: () => ({ groups: [{ environmentId: "env_ports", ports: Array.from({ length: 20 }, (_, i) => ({ port: 8000 + i })) }] }),
    },
  });
  const row = screen.getByRole("link", { name: "Many ports" });
  act(() => row.focus());
  fireEvent.click(await screen.findByRole("button", { name: /Workspace ports \(20\)/ }));
  const list = await screen.findByRole("region", { name: "Workspace port list" });
  expect(within(list).getByText(":8019")).toBeDefined();
});

it("stops a workspace port process only after a second press", async () => {
  const stopWorkspacePort = vi.fn(() => ({ signalled: [3000], skipped: [], failed: [] }));
  let groups = [{ environmentId: "env_ports", ports: [{ port: 3000, processName: "node", pid: 1234, source: "process" as const }] }];
  const getOpenPorts = vi.fn(() => ({ groups }));
  renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", projects: [], threads: [thread({ id: "thr_ports", title: "Stoppable", environment: {
      id: "env_ports", name: null, branchName: "main", workspaceDisplayKind: "other", path: null, isWorktree: null, providerId: null
    } })] },
    rpc: { listLifecycle: () => ({ rows: [] }), getThreadExecutionDetails: () => null, getOpenPorts, stopWorkspacePort },
  });
  fireEvent.pointerMove(screen.getByRole("link", { name: "Stoppable" }), { pointerType: "mouse" });
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  fireEvent.click(await within(details).findByRole("button", { name: /Workspace ports \(1\)/ }));
  fireEvent.click(within(details).getByRole("button", { name: "Stop process on port 3000" }));
  expect(stopWorkspacePort).not.toHaveBeenCalled();
  groups = [];
  const scans = getOpenPorts.mock.calls.length;
  fireEvent.click(within(details).getByRole("button", { name: "Confirm stopping PID 1234 on port 3000" }));
  await waitFor(() => expect(stopWorkspacePort).toHaveBeenCalledWith(
    { threadId: "thr_ports", port: { port: 3000, pid: 1234 } },
  ));
  await waitFor(() => expect(getOpenPorts.mock.calls.length).toBeGreaterThan(scans));
  await waitFor(() => expect(details.textContent).not.toContain("Workspace ports"));
});

it("marks only the owning thread without a count and clears its icon when the port closes", async () => {
  const environment = { id: "env_ports", name: null, branchName: "main", workspaceDisplayKind: "other" as const, path: null, isWorktree: null, providerId: null };
  let groups = [{ environmentId: environment.id, ports: [{ port: 3000, ownerThreadId: "ports_a" }, { port: 8080, ownerThreadId: "" }] }];
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "ports_a", environment }),
        thread({ id: "ports_b", environment }),
        thread({ id: "no_ports" }),
      ],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getOpenPorts: () => ({ groups }),
    },
  });
  const label = "Open ports started by this thread";
  await waitFor(() => expect(screen.getAllByRole("img", { name: label })).toHaveLength(1));
  expect(screen.getByRole("img", { name: label }).textContent).toBe("");
  expect(screen.getByRole("img", { name: label }).className).toContain("text-muted-foreground/60");
  vi.useFakeTimers();
  // Trigger a fresh provider mount so its next poll uses the fake clock.
  cleanup();
  renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads: [thread({ id: "ports_a", environment })], projects: [] },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getOpenPorts: () => ({ groups }),
    },
  });
  await act(async () => {});
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
  groups = [];
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.queryByRole("img", { name: label })).toBeNull();
  cleanup();
  vi.useRealTimers();
});

function render(
  threads: PluginSidebarThread[],
  projects = [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    providers: { status: "ready", providers: defaultProviders },
    // The lifecycle store is the plugin's own backend; an empty one means
    // every thread is active, which is what these list tests are about.
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}


/**
 * The card's trailing slot and the two spans it stacks: the status, and the
 * park actions that replace it on a hover device. On touch both stay put, so
 * the tests need each span separately.
 */
function statusSlotParts(row: HTMLElement, statusText: string) {
  const status = within(row).getByText(statusText);
  const statusWrapper = status.parentElement!;
  const slot = statusWrapper.parentElement!;
  return {
    status,
    statusWrapper,
    slot,
    actions: slot.lastElementChild as HTMLElement,
  };
}

/**
 * Controls nested inside other controls. A `<button>` inside an `<a>` is
 * invalid interactive nesting and breaks keyboard behaviour, so every row that
 * mixes a navigation target with its own buttons must report none.
 */
function nestedInteractiveControls(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll("a a, a button, button a, button button"),
  ).map((element) => element.outerHTML);
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
  nextPinnedKey = 0;
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
  vi.mocked(document.elementFromPoint).mockReset();
});

describe("BB Sidebar registration", () => {
  it("opens project settings and confirms project edits from the card menu", async () => {
    const renameProject = vi.fn(() => ({ ok: true }));
    const removeProject = vi.fn(() => ({ ok: true }));
    const addProjectPath = vi.fn(() => ({ ok: true }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads: [thread({ title: "Project card" })], projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }] },
      context: { projectId: "proj_other", threadId: "thr_other" },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        projectPathHosts: () => ({ hosts: [{ id: "host_2", name: "Laptop" }] }),
        renameProject, removeProject, addProjectPath,
      },
    });
    const openMenu = async () => {
      fireEvent.contextMenu(await screen.findByText("Project card"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Project" }));
      return (await screen.findByText("Project settings")).closest<HTMLElement>('[role="menu"]')!;
    };
    const settingsMenu = await openMenu();
    expect(settingsMenu.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(within(settingsMenu).getByText("Project settings").getAttribute("href")).toBe("/projects/proj_1/settings");
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
    await waitFor(() => expect(addProjectPath).toHaveBeenCalledWith({ projectId: "proj_1", hostId: "host_2", path: "/workspace/bb" }));
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

describe("sidebar settings", () => {
  it("keeps project colors opt-in and ignores the removed archive preview settings", async () => {
    localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ settled: true, archived: true }));
    let settings = { ...defaultSidebarSettings, archivedShelfEnabled: true };
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        threads: [
          thread({ id: "live", title: "Live work" }),
          thread({ id: "done", title: "Settled work" }),
          thread({ id: "old", title: "Old work", isArchived: true, archivedAt: 500 }),
        ],
      },
      rpc: {
        getSidebarSettings: () => settings,
        listLifecycle: () => ({ rows: [{ threadId: "done", settledAt: 200, snoozedUntil: null, snoozedAt: null }] }),
        getProjectColors: () => ({ colors: {} }),
      },
    });
    await screen.findByText("Live work");
    const settledShelf = await screen.findByRole("region", { name: "Settled" });
    await within(settledShelf).findByText("Settled work");
    expect(within(settledShelf).queryByRole("button", { name: "Archive thread" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Archived" })).toBeNull();
    expect(document.querySelector("[data-project-stripe]")).toBeNull();
    expect(rendered.rpcCalls.some((call) => call.method === "getProjectColors")).toBe(false);
    expect(screen.queryByRole("button", { name: "Archive all settled threads" })).toBeNull();
    settings = { ...settings, projectColorsEnabled: true };
    await rendered.emitRealtime("sidebar-settings", {});
    expect(screen.queryByText("Old work")).toBeNull();
    expect(within(settledShelf).queryByRole("button", { name: "Archive thread" })).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-project-stripe]")).not.toBeNull());
    settings = { ...settings, projectColorsEnabled: false };
    await rendered.emitRealtime("sidebar-settings", {});
    await waitFor(() => expect(screen.queryByRole("region", { name: "Archived" })).toBeNull());
    expect(within(settledShelf).queryByRole("button", { name: "Archive thread" })).toBeNull();
    expect(within(settledShelf).getByText("Settled work")).toBeDefined();
    expect(document.querySelector("[data-project-stripe]")).toBeNull();
  });

  it("uses one continuous stripe for a project group and refreshes its custom color", async () => {
    localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    let colors = { proj_1: "#123456" };
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects: [{ id: "proj_1", name: "add_on", isPersonal: false, href: "", settingsHref: "" }],
        threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second" })],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, projectColorsEnabled: true, inactiveThreadsEnabled: false }),
        getProjectColors: () => ({ colors }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const group = await screen.findByRole("region", { name: "add_on project" });
    await waitFor(() => expect((group.querySelector("[data-project-stripe]") as HTMLElement)?.style.getPropertyValue("--bb-sidebar-project")).toBe("#123456"));
    expect(group.querySelectorAll("[data-project-stripe]")).toHaveLength(1);
    expect(within(group).getByRole("list").querySelector("[data-project-stripe]")).toBeNull();
    colors = { proj_1: "#fedcba" };
    await rendered.emitRealtime("project-colors", { projectId: "proj_1" });
    await waitFor(() => expect((group.querySelector("[data-project-stripe]") as HTMLElement).style.getPropertyValue("--bb-sidebar-project")).toBe("#fedcba"));
    fireEvent.click(within(group).getByRole("button", { name: "add_on (2)" }));
    expect(group.querySelectorAll("[data-project-stripe]")).toHaveLength(1);
  });

  it("limits stripes by display mode while keeping all project names colored", async () => {
    localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ settled: true, archived: true }));
    let settings = {
      ...defaultSidebarSettings,
      projectColorsEnabled: true,
      inactiveThreadsEnabled: false,
      compactWorkingThreads: true,
    };
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects: ["group", "single", "busy", "settled"].map((id) => ({ id, name: id, isPersonal: false, href: "", settingsHref: "" })),
        threads: [
          thread({ id: "a", projectId: "group", title: "First grouped" }),
          thread({ id: "b", projectId: "group", title: "Second grouped" }),
          thread({ id: "single", projectId: "single", title: "Full card" }),
          thread({ id: "busy", projectId: "busy", title: "Compact card", indicator: "runtime", indicatorLabel: "Working" }),
          thread({ id: "settled", projectId: "settled", title: "Settled row" }),
        ],
      },
      rpc: {
        getSidebarSettings: () => settings,
        getProjectColors: () => ({ colors: {} }),
        listLifecycle: () => ({ rows: [{ threadId: "settled", settledAt: 200, snoozedUntil: null, snoozedAt: null }] }),
      },
    });
    const group = await screen.findByRole("region", { name: "group project" });
    await screen.findByText("Settled row");
    const assertColor = (element: Element, showStripe: boolean) => {
      expect(element.querySelectorAll("[data-project-stripe]")).toHaveLength(showStripe ? 1 : 0);
      expect(element.querySelector(".bb-sidebar-project-name")).not.toBeNull();
      expect(element.querySelector(".bb-sidebar-project-monogram")).not.toBeNull();
    };
    const row = (title: string) => screen.getByText(title).closest("li")!;
    await waitFor(() => expect(row("Compact card").querySelector(".h-8")).not.toBeNull());
    for (const display of ["all", "full", "grouped"]) {
      settings = { ...settings, projectColorDisplay: display };
      await rendered.emitRealtime("sidebar-settings", {});
      await waitFor(() => {
        assertColor(group, true);
        assertColor(row("Full card"), display !== "grouped");
        assertColor(row("Compact card"), display === "all");
        assertColor(row("Settled row"), display === "all");
      });
      expect(within(group).getByRole("list").querySelector("[data-project-stripe]")).toBeNull();
      fireEvent.click(within(group).getByRole("button", { name: "group (2)" }));
      assertColor(group, display !== "full");
      fireEvent.click(within(group).getByRole("button", { name: "group (2)" }));
    }
    fireEvent.keyDown(screen.getByRole("combobox", { name: /Sort active threads/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Manual order" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "group project" })).toBeNull());
    expect(document.querySelector("[data-project-stripe]")).toBeNull();
    for (const title of ["First grouped", "Second grouped", "Full card", "Compact card", "Settled row"]) {
      assertColor(row(title), false);
    }
    settings = { ...settings, projectColorsEnabled: false };
    await rendered.emitRealtime("sidebar-settings", {});
    await waitFor(() => expect(document.querySelector(".bb-sidebar-project-name")).toBeNull());
    expect(document.querySelector("[data-project-stripe]")).toBeNull();
    expect(document.querySelector(".bb-sidebar-project-monogram")).toBeNull();
  });

  it("saves the color switch and lets users choose and reset a project's color", async () => {
    let saved = { ...defaultSidebarSettings };
    let colors: Record<string, string> = {};
    const setProjectColor = vi.fn((input: unknown) => {
      const { projectId, color } = input as { projectId: string; color: string | null };
      if (color === null) delete colors[projectId];
      else colors = { ...colors, [projectId]: color };
      return { ok: true };
    });
    renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => saved,
        updateSidebarSettings: (input) => { saved = { ...saved, ...input as Partial<typeof saved> }; return saved; },
        listProjects: () => ({ projects: [] }),
        listProjectIconSettings: () => ({ projects: [{ id: "proj_1", name: "add_on", customPath: null, customUploadName: null }] }),
        getProjectColors: () => ({ colors }),
        setProjectColor,
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const toggle = await screen.findByRole("switch", { name: "Project colors" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Show project stripes in" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Archived shelf" })).toBeNull();
    fireEvent.click(toggle);
    const colorDisplay = screen.getByRole("combobox", { name: "Show project stripes in" });
    expect(colorDisplay).toHaveProperty("value", "all");
    expect(within(colorDisplay).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Full and collapsed mode", "Full mode only", "Grouped projects only",
    ]);
    fireEvent.change(colorDisplay, { target: { value: "grouped" } });
    await waitFor(() => expect(saved).toMatchObject({ projectColorsEnabled: true, projectColorDisplay: "grouped" }));
    fireEvent.click(toggle);
    expect(screen.queryByRole("combobox", { name: "Show project stripes in" })).toBeNull();
    await waitFor(() => expect(saved.projectColorsEnabled).toBe(false));
    fireEvent.click(toggle);
    expect(screen.getByRole("combobox", { name: "Show project stripes in" })).toHaveProperty("value", "grouped");
    const picker = await screen.findByLabelText("Project color");
    fireEvent.change(picker, { target: { value: "#13579b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save color" }));
    await waitFor(() => expect(setProjectColor).toHaveBeenCalledWith({ projectId: "proj_1", color: "#13579b" }));
    const reset = await screen.findByRole("button", { name: "Reset color" });
    await waitFor(() => expect(reset).toHaveProperty("disabled", false));
    fireEvent.click(reset);
    await waitFor(() => expect(setProjectColor).toHaveBeenCalledWith({ projectId: "proj_1", color: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset color" })).toBeNull());
  });

  it("lists device hosts in settings and saves the local port-link choice", async () => {
    renderSlot(sidebarSettings, {}, {
      sidebarThreads: { status: "ready", projects: [], threads: [thread({ host: { id: "host_local", name: "Local Mac" } })] },
      rpc: { getSidebarSettings: () => defaultSidebarSettings, listProjectIconSettings: () => ({ projects: [] }) },
    });
    const select = await screen.findByLabelText("Open port links on");
    expect(within(select).getByRole("option", { name: "Local Mac" })).toBeDefined();
    fireEvent.change(select, { target: { value: "host_local" } });
    expect(localStorage.getItem("bb-sidebar:port-link-host:v1")).toBe("host_local");
  });
  it("groups related controls and saves changes without a save button", async () => {
    let saved: typeof defaultSidebarSettings | null = null;
    renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        updateSidebarSettings: (input) => {
          saved = { ...defaultSidebarSettings, ...input as Partial<typeof defaultSidebarSettings> };
          return saved;
        },
        listProjectIconSettings: () => ({
          projects: [
            {
              id: "proj_1",
              name: "Sidebar",
              customPath: null,
              customUploadName: null,
            },
          ],
        }),
      },
    });

    expect(
      (await screen.findAllByRole("heading", { level: 2 })).map((heading) => heading.textContent),
    ).toEqual([
      "Sidebar layout", "Project appearance", "Thread behavior", "Child threads", "This device", "Project management",
    ]);
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    for (const link of within(navigation).getAllByRole("link")) {
      const target = document.querySelector(link.getAttribute("href")!);
      expect(target?.getAttribute("aria-labelledby")).toBe(`${target?.id}-heading`);
    }
    const layout = screen.getByRole("region", { name: "Sidebar layout" });
    expect(within(layout).getAllByText("Experimental")).toHaveLength(3);
    expect(within(layout).getByRole("switch", { name: "Working shelf" })).toBeDefined();
    expect(within(layout).queryByRole("switch", { name: "Archived shelf" })).toBeNull();
    const appearance = screen.getByRole("region", { name: "Project appearance" });
    expect(within(appearance).getByRole("switch", { name: "Project colors" })).toBeDefined();
    expect(await within(appearance).findByLabelText("Project color")).toBeDefined();
    expect(within(appearance).getByLabelText("Choose project icon image")).toBeDefined();
    expect(within(appearance).queryByRole("button", { name: "Remove…" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Archiving" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive all settled threads" })).toBeNull();
    fireEvent.click(within(navigation).getByRole("link", { name: "Project appearance" }));
    expect(document.activeElement).toBe(within(appearance).getByRole("heading", { level: 2 }));
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(
      screen
        .getByRole("switch", { name: "Inactive shelf" })
        .querySelector("span")?.className,
    ).toContain("left-0.5");
    expect(
      screen
        .getByRole("switch", { name: "Show children that need attention" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.change(screen.getByLabelText("Snooze shortcuts"), {
      target: { value: "1h, Wait refresh=5h, Tonight=evening@20:00, Morning=tomorrow@08:30, Monday=next-week@10:00" },
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Show children that need attention" }),
    );
    fireEvent.change(screen.getByLabelText("Child threads sort field"), {
      target: { value: "activity" },
    });
    fireEvent.change(screen.getByLabelText("Child threads sort direction"), {
      target: { value: "descending" },
    });
    fireEvent.change(screen.getByLabelText("Child thread icon"), {
      target: { value: "provider" },
    });
    await waitFor(() =>
      expect(saved).toEqual({
        ...defaultSidebarSettings,
        snoozePresets: "1h, Wait refresh=5h, Tonight=evening@20:00, Morning=tomorrow@08:30, Monday=next-week@10:00",
        showRunningChildrenWhenCollapsed: false,
        childSortField: "activity",
        childSortDirection: "descending",
        childIconStyle: "provider",
      }),
    );    // The section edited last says it saved; the others stay quiet.
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Child threads" })).getByRole("status").textContent,
      ).toBe("Saved"),
    );
    expect(
      within(screen.getByRole("region", { name: "Sidebar layout" })).getByRole("status").textContent,
    ).toBe("");
  });

  it("does not save invalid settings and previews valid snooze shortcuts", async () => {
    const saves: unknown[] = [];
    renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        updateSidebarSettings: (input) => {
          saves.push(input);
          return { ...defaultSidebarSettings, ...input as Partial<typeof defaultSidebarSettings> };
        },
        listProjectIconSettings: () => ({ projects: [] }),
      },
    });
    const preview = () =>
      within(screen.getByRole("list", { name: "Snooze menu preview" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent);

    const snoozeInput = await screen.findByLabelText("Snooze shortcuts");
    fireEvent.change(snoozeInput, { target: { value: "later" } });
    expect(snoozeInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(
        "Use comma-separated durations or calendar times, such as 1h, Wait refresh=5h, evening@18:00, tomorrow@09:00, or next-week@09:00.",
      ),
    ).toBeDefined();

    fireEvent.change(snoozeInput, {
      target: { value: "15m, Lunch=3h" },
    });
    expect(preview()).toEqual(["15 minutes", "Lunch"]);

    fireEvent.change(snoozeInput, { target: { value: "tomorrow@25:00" } });
    expect(snoozeInput.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(snoozeInput, { target: { value: "Morning=tomorrow@08:30" } });
    expect(preview()).toEqual(["Morning"]);

    const inactiveHours = screen.getByLabelText("Hours before inactive");
    fireEvent.change(inactiveHours, { target: { value: "0" } });
    expect(inactiveHours.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a whole number from 1 to 720.")).toBeDefined();
    // Past the save delay, nothing invalid has been sent.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(saves).toEqual([]);

    // Turning the rule off hides the value it no longer uses.
    fireEvent.click(screen.getByRole("switch", { name: "Inactive shelf" }));
    expect(screen.queryByLabelText("Hours before inactive")).toBeNull();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      inactiveThreadsEnabled: false,
      inactiveAfterHours: defaultSidebarSettings.inactiveAfterHours,
      snoozePresets: "Morning=tomorrow@08:30",
    });
  });

  it("uploads a project icon from the file picker", async () => {
    let upload:
      | {
          projectId: string;
          filename: string;
          mimeType: string;
          contentBase64: string;
        }
      | null = null;
    renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listProjectIconSettings: () => ({
          projects: [
            {
              id: "proj_1",
              name: "Sidebar",
              customPath: null,
              customUploadName: null,
            },
          ],
        }),
        uploadProjectIcon: (input) => {
          upload = input as typeof upload;
          return {
            customPath: null,
            customUploadName: "brand.svg",
          };
        },
      },
    });

    const picker = await screen.findByLabelText("Choose project icon image");
    fireEvent.change(picker, {
      target: {
        files: [new File(["<svg/>"], "brand.svg", { type: "image/svg+xml" })],
      },
    });
    await waitFor(() =>
      expect(upload).toEqual({
        projectId: "proj_1",
        filename: "brand.svg",
        mimeType: "image/svg+xml",
        contentBase64: "PHN2Zy8+",
      }),
    );
    expect(screen.getByText("Uploaded: brand.svg")).toBeDefined();
  });

  it("keeps a settings cache written before the child-thread settings", () => {
    const previous: Record<string, unknown> = {
      ...defaultSidebarSettings,
      inactiveAfterHours: 12,
    };
    delete previous.childSortField;
    delete previous.childSortDirection;
    delete previous.childIconStyle;
    delete previous.projectColorDisplay;
    previous.projectColorsEnabled = true;
    window.localStorage.setItem(
      "bb-sidebar:settings-cache:v1",
      JSON.stringify(previous),
    );
    renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => new Promise(() => {}),
        listProjectIconSettings: () => ({ projects: [] }),
      },
    });

    expect(screen.queryByText("Loading settings...")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Show project stripes in" })).toHaveProperty("value", "all");
    expect(
      (screen.getByLabelText("Hours before inactive") as HTMLInputElement).value,
    ).toBe("12");
    expect(
      (screen.getByLabelText("Child threads sort field") as HTMLSelectElement)
        .value,
    ).toBe("created");
    expect(
      (screen.getByLabelText("Child thread icon") as HTMLSelectElement).value,
    ).toBe("disc");
  });

  it("preserves unsaved settings when a realtime refresh arrives", async () => {
    let remoteSettings = defaultSidebarSettings;
    const rendered = renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => remoteSettings,
        listProjectIconSettings: () => ({ projects: [] }),
      },
    });

    const shortcuts = await screen.findByLabelText("Snooze shortcuts");
    fireEvent.change(shortcuts, { target: { value: "Local=45m" } });
    remoteSettings = { ...defaultSidebarSettings, inactiveAfterHours: 12 };

    await rendered.emitRealtime("sidebar-settings", {});

    expect((shortcuts as HTMLInputElement).value).toBe("Local=45m");
  });

  it("ignores an older project-icon load after a newer refresh", async () => {
    const older = deferred<{
      projects: Array<{
        id: string;
        name: string;
        customPath: null;
        customUploadName: null;
      }>;
    }>();
    let loads = 0;
    const rendered = renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listProjectIconSettings: () => {
          loads += 1;
          return loads === 1
            ? older.promise
            : {
                projects: [
                  {
                    id: "new",
                    name: "Newest project",
                    customPath: null,
                    customUploadName: null,
                  },
                ],
              };
        },
      },
    });

    await waitFor(() => expect(loads).toBe(1));
    await rendered.emitRealtime("project-icons", {});
    expect(await screen.findByText("Newest project")).toBeDefined();

    older.resolve({
      projects: [
        {
          id: "old",
          name: "Stale project",
          customPath: null,
          customUploadName: null,
        },
      ],
    });
    await Promise.resolve();
    expect(screen.queryByText("Stale project")).toBeNull();
    expect(screen.getByText("Newest project")).toBeDefined();
  });

  it("keeps project removal separate from appearance and requires confirmation", async () => {
    let removal: { projectId: string; confirmation: string } | null = null;
    renderSlot(sidebarSettings, {}, {
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listProjectIconSettings: () => ({ projects: [
          { id: "proj_1", name: "Sidebar", customPath: null, customUploadName: null },
          { id: "personal", name: "Personal", customPath: null, customUploadName: null },
        ] }),
        listProjects: () => ({
          projects: [{ id: "proj_1", name: "Sidebar" }],
        }),
        removeProject: (input) => {
          removal = input as typeof removal;
          return { ok: true as const };
        },
      },
    });

    const appearance = await screen.findByRole("region", { name: "Project appearance" });
    fireEvent.change(await within(appearance).findByRole("combobox", { name: "Project" }), { target: { value: "personal" } });
    expect(within(appearance).queryByRole("button", { name: "Remove…" })).toBeNull();
    const management = screen.getByRole("region", { name: "Project management" });
    expect(within(management).getByRole("combobox", { name: "Project to remove" })).toHaveProperty("value", "proj_1");
    expect(within(management).queryByRole("option", { name: "Personal" })).toBeNull();
    fireEvent.click(await within(management).findByRole("button", { name: "Remove…" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const confirmation = screen.getByRole("group", {
      name: "Confirm removal of Sidebar",
    });
    expect(within(confirmation).getByText("Remove Sidebar?")).toBeDefined();
    expect(removal).toBeNull();

    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Remove from BB" }),
    );

    await waitFor(() =>
      expect(removal).toEqual({
        projectId: "proj_1",
        confirmation: "Sidebar",
      }),
    );
    expect(await within(management).findByText("No projects to remove.")).toBeDefined();
    expect(within(appearance).getByRole("combobox", { name: "Project" })).toHaveProperty("value", "personal");
    expect(toastMocks.success).toHaveBeenCalledWith("Sidebar removed from BB");
  });
});

describe("thread list loading state", () => {
  function renderStatus(status: "loading" | "error" | "ready") {
    return renderSlot(inbox, listProps, {
      sidebarThreads: {
        status,
        threads: status === "ready" ? [thread({ title: "Loaded thread" })] : [],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
  }

  function loadingStatus() {
    return screen
      .queryAllByRole("status")
      .find((region) => region.textContent === "Loading threads…");
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays quiet while a load is still fast", () => {
    vi.useFakeTimers();
    renderStatus("loading");
    act(() => vi.advanceTimersByTime(199));
    expect(screen.queryByText("Loading threads…")).toBeNull();
    expect(loadingStatus()).toBeUndefined();
  });

  it("shows a spinner and text once loading outlasts the delay", () => {
    vi.useFakeTimers();
    renderStatus("loading");
    const regionsBefore = screen.getAllByRole("status");
    act(() => vi.advanceTimersByTime(200));
    const region = loadingStatus();
    expect(region).toBeDefined();
    // The same live region was already mounted, empty, before the text came.
    expect(regionsBefore).toContain(region);
    const spinner = region!.querySelector('[data-icon="Loading"]');
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Could not load threads.")).toBeNull();
  });

  it("reports a failed load without the loading indicator", () => {
    vi.useFakeTimers();
    renderStatus("error");
    act(() => vi.advanceTimersByTime(1_000));
    const region = screen
      .getAllByRole("status")
      .find((status) => status.textContent === "Could not load threads.");
    expect(region).toBeDefined();
    expect(screen.queryByText("Loading threads…")).toBeNull();
  });

  it("shows the list and no loading text once ready", () => {
    vi.useFakeTimers();
    renderStatus("ready");
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("Loaded thread")).toBeDefined();
    expect(screen.queryByText("Loading threads…")).toBeNull();
    expect(loadingStatus()).toBeUndefined();
  });
});

describe("ThreadInbox", () => {
  it("renders provider names, logos, and theme tints from bb's directory", () => {
    const view = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ providerId: "pi", title: "Pi thread" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: {
        status: "ready",
        providers: [
          {
            id: "pi",
            pluginId: "provider-pi",
            displayName: "Pi",
            available: true,
            completedTurnDisplay: "collapse",
            maintenance: {
              health: true,
              usage: false,
              installation: true,
            },
            logoUrl: "/api/v1/system/providers/pi/logo",
            capabilities: {
              modelCatalogScope: "workspace",
              permissionModes: ["full"],
              supportsFork: true,
              supportsNativeUserQuestion: false,
              supportsServiceTier: false,
              supportsSessionRewind: true,
              supportsThreadArchive: false,
              supportsThreadRename: false,
            },
            composerActions: [],
            strings: {
              signInHint: "Run pi to sign in.",
              expiredHint: "Run pi to sign in again.",
              installUrl: "https://pi.dev",
              iconTint: { light: "#6D5DFB", dark: "#A99EFF" },
            },
          },
        ],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const glyph = screen.getByRole("img", { name: "Pi" });
    const marks = glyph.querySelectorAll<HTMLElement>("[aria-hidden=true]");
    expect(marks).toHaveLength(2);
    expect(marks[0]!.style.maskImage).toContain(
      "/api/v1/system/providers/pi/logo",
    );
    expect(marks[0]!.style.backgroundColor).toBe("rgb(109, 93, 251)");
    expect(marks[1]!.style.backgroundColor).toBe("rgb(169, 158, 255)");
    expect(view.container.querySelector('[aria-label="pi"]')).toBeNull();
  });

  it("falls back to the provider id when the directory has no match", () => {
    render([thread({ providerId: "custom-agent" })]);

    const glyph = screen.getByRole("img", { name: "custom-agent" });
    expect(glyph.querySelector(".rounded-full")).not.toBeNull();
  });

  it("loads a project favicon beside the project name", async () => {
    const view = render([
      thread({
        id: "icon-thread",
        environment: {
          id: "env_1",
          name: "main",
          branchName: "main",
          workspaceDisplayKind: "other", path: null, isWorktree: null, providerId: null
        },
      }),
    ]);

    const preload = await waitFor(() => {
      const image = view.container.querySelector<HTMLImageElement>(
        'img[src*="project-icon"]',
      );
      expect(image).not.toBeNull();
      return image!;
    });
    expect(preload.src).toContain("projectId=proj_1");
    expect(preload.src).not.toContain("environmentId");
    fireEvent.load(preload);
    expect(
      view.container.querySelector('img.object-contain[src*="project-icon"]'),
    ).not.toBeNull();
  });

  it("shows active threads in a collapsible Active shelf", () => {
    render([
      thread({ id: "a", title: "First active" }),
      thread({ id: "b", title: "Second active" }),
    ]);

    const activeShelf = screen.getByRole("region", { name: "Active" });
    expect(
      within(activeShelf).getByRole("button", { expanded: true }),
    ).toBeDefined();
    fireEvent.click(
      within(activeShelf).getByRole("button", { expanded: true }),
    );
    expect(within(activeShelf).getByText("Active (2)")).toBeDefined();
    expect(within(activeShelf).queryByText("First active")).toBeNull();
    expect(within(activeShelf).queryByText("Second active")).toBeNull();
  });

  it("keeps the currently open active row visible while collapsed", () => {
    renderSlot(inbox, { ...listProps, activeThreadId: "open" }, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "open", title: "Open active" }),
          thread({ id: "other", title: "Other active" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const activeShelf = screen.getByRole("region", { name: "Active" });
    fireEvent.click(
      within(activeShelf).getByRole("button", { expanded: true }),
    );
    expect(within(activeShelf).getByText("Open active")).toBeDefined();
    expect(within(activeShelf).queryByText("Other active")).toBeNull();
  });

  it("moves stale unpinned threads to a collapsed Inactive shelf", () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "recent",
            title: "Recent work",
            updatedAt: now - 60 * 60 * 1_000,
          }),
          thread({
            id: "stale",
            title: "Stale work",
            updatedAt: now - 7 * 60 * 60 * 1_000,
          }),
          thread({
            id: "stale-pin",
            title: "Pinned old work",
            isPinned: true,
            updatedAt: now - 7 * 60 * 60 * 1_000,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      settings: {
        inactiveThreadsEnabled: true,
        inactiveAfterHours: "6",
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const active = screen.getByRole("region", { name: "Active" });
    const inactive = screen.getByRole("region", { name: "Inactive" });
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(active).getByText("Recent work")).toBeDefined();
    expect(within(active).queryByText("Stale work")).toBeNull();
    expect(within(inactive).getByText("Inactive (1)")).toBeDefined();
    expect(within(inactive).queryByText("Stale work")).toBeNull();
    expect(within(pinned).getByText("Pinned old work")).toBeDefined();

    fireEvent.click(
      within(inactive).getByRole("button", { expanded: false }),
    );
    expect(within(inactive).getByText("Stale work")).toBeDefined();
  });

  it("keeps stale threads Active when the feature is disabled", () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "stale",
            title: "Still active",
            updatedAt: Date.now() - 24 * 60 * 60 * 1_000,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      settings: {
        inactiveThreadsEnabled: false,
        inactiveAfterHours: "6",
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    expect(
      within(screen.getByRole("region", { name: "Active" })).getByText(
        "Still active",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("region", { name: "Inactive" })).toBeNull();
  });

  it("uses the configured inactivity threshold", () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "seven-hours",
            title: "Seven hours old",
            updatedAt: now - 7 * 60 * 60 * 1_000,
          }),
          thread({
            id: "nine-hours",
            title: "Nine hours old",
            updatedAt: now - 9 * 60 * 60 * 1_000,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      settings: {
        inactiveThreadsEnabled: true,
        inactiveAfterHours: "8",
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    expect(
      within(screen.getByRole("region", { name: "Active" })).getByText(
        "Seven hours old",
      ),
    ).toBeDefined();
    expect(
      within(screen.getByRole("region", { name: "Inactive" })).getByText(
        "Inactive (1)",
      ),
    ).toBeDefined();
  });

  it("sorts active threads from the subtle header menu", async () => {
    render(
      [
        thread({
          id: "alpha-new",
          projectId: "proj_alpha",
          title: "Alpha new",
          createdAt: 3,
          updatedAt: 10,
        }),
        thread({
          id: "beta-new",
          projectId: "proj_beta",
          title: "Beta new",
          createdAt: 4,
          updatedAt: 30,
        }),
        thread({
          id: "alpha-old",
          projectId: "proj_alpha",
          title: "Alpha old",
          createdAt: 1,
          updatedAt: 40,
        }),
        thread({
          id: "beta-old",
          projectId: "proj_beta",
          title: "Beta old",
          createdAt: 2,
          updatedAt: 20,
        }),
      ],
      [
        { id: "proj_alpha", name: "Alpha", isPersonal: false, href: "", settingsHref: "" },
        { id: "proj_beta", name: "Beta", isPersonal: false, href: "", settingsHref: "" },
      ],
    );

    const activeShelf = screen.getByRole("region", { name: "Active" });
    const sortMenu = within(activeShelf).getByRole("combobox", {
      name: "Sort active threads: Manual order",
    });
    expect(sortMenu.querySelector('[data-icon="ArrowUpDown"]')).not.toBeNull();
    expect(sortMenu.classList.contains("focus:ring-0")).toBe(true);
    expect(sortMenu.classList.contains("focus-visible:ring-1")).toBe(true);
    expect(sortMenu.classList.contains("focus:ring-1")).toBe(false);
    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Beta new"),
      expect.stringContaining("Alpha new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha old"),
    ]);

    fireEvent.keyDown(sortMenu, { key: "Enter" });
    expect(screen.getByRole("option", { name: "Manual order" })).toBeDefined();
    expect(
      screen.getByRole("option", { name: "Recent activity" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: "Date created" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Project" })).toBeDefined();
    fireEvent.click(screen.getByRole("option", { name: "Recent activity" }));

    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Alpha old"),
      expect.stringContaining("Beta new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha new"),
    ]);
    expect(
      within(activeShelf)
        .getAllByRole("link")
        .every((link) => link.getAttribute("aria-keyshortcuts") === null),
    ).toBe(true);

    fireEvent.keyDown(
      within(activeShelf).getByRole("combobox", {
        name: "Sort active threads: Recent activity",
      }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("option", { name: "Date created" }));
    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Beta new"),
      expect.stringContaining("Alpha new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha old"),
    ]);

    fireEvent.keyDown(
      within(activeShelf).getByRole("combobox", {
        name: "Sort active threads: Date created",
      }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("option", { name: "Project" }));
    // Projects sit where their first thread is in manual order.
    expect(
      within(activeShelf)
        .getAllByRole("listitem")
        .filter((row) => !row.hasAttribute("data-reorder-unit"))
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Beta new"),
      expect.stringContaining("Beta old"),
      expect.stringContaining("Alpha new"),
      expect.stringContaining("Alpha old"),
    ]);
    expect(
      within(activeShelf).getByRole("list", {
        name: "Alpha active threads",
      }),
    ).toBeDefined();
    expect(
      within(activeShelf).getByRole("button", { name: "Alpha (2)", expanded: true }),
    ).toBeDefined();
    expect(
      within(activeShelf)
        .getAllByRole("link")
        .every(
          (link) =>
            link.getAttribute("aria-keyshortcuts") ===
            "Alt+ArrowUp Alt+ArrowDown",
        ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        window.localStorage.getItem("bb-sidebar:active-sort:v1"),
      ).toBe("project"),
    );
  });

  it("migrates the previous project grouping preference", async () => {
    window.localStorage.setItem("bb-sidebar:active-grouping:v1", "true");
    render([thread({ id: "saved", title: "Saved grouping" })]);

    expect(
      screen.getByRole("combobox", {
        name: "Sort active threads: Project",
      }),
    ).toBeDefined();
    await waitFor(() =>
      expect(window.localStorage.getItem("bb-sidebar:active-sort:v1")).toBe(
        "project",
      ),
    );
  });

  it("names a project once in a header when it has two or more threads", () => {
    window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    window.localStorage.setItem(
      "bb-sidebar:inbox-order-cache:v1",
      JSON.stringify(["web-1", "zed-1", "web-2", "api-1"]),
    );
    render(
      [
        thread({ id: "web-1", projectId: "web", title: "First" }),
        thread({ id: "zed-1", projectId: "zed", title: "Loose Z" }),
        thread({ id: "web-2", projectId: "web", title: "Second" }),
        thread({ id: "api-1", projectId: "api", title: "Loose A" }),
      ],
      [
        { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
        { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
        { id: "zed", name: "Zed", isPersonal: false, href: "", settingsHref: "" },
      ],
    );

    const headers = screen.getAllByRole("button", { name: /\(\d+\)$/ });
    expect(headers.map((header) => header.getAttribute("aria-label"))).toEqual([
      "Web (2)",
    ]);
    // One-thread projects stay ordinary cards. Everything keeps manual
    // order, with a project drawn where its first thread is.
    expect(
      screen
        .getAllByRole("listitem")
        .filter((row) => !row.hasAttribute("data-reorder-unit"))
        .map((row) => row.textContent),
    ).toEqual([
      expect.not.stringContaining("Web"),
      expect.not.stringContaining("Web"),
      expect.stringMatching(/^Zed.*Loose Z/),
      expect.stringMatching(/^Api.*Loose A/),
    ]);
  });

  it("hides project headers while Active is collapsed", async () => {
    window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "web-2" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "web-1", projectId: "web", title: "First" }),
            thread({ id: "web-2", projectId: "web", title: "Second" }),
          ],
          projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const active = await screen.findByRole("region", { name: "Active" });
    expect(within(active).getByRole("button", { name: "Web (2)" })).toBeDefined();
    fireEvent.click(
      within(active).getByRole("button", { name: "Active", expanded: true }),
    );
    expect(within(active).queryByRole("button", { name: "Web (2)" })).toBeNull();
    expect(
      within(active).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/^Web.*Second/)]);
  });

  it("looks like manual order when no project has a second thread", () => {
    window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    render(
      [
        thread({ id: "zed-1", projectId: "zed", title: "Zed thread", createdAt: 2 }),
        thread({ id: "api-1", projectId: "api", title: "Api thread", createdAt: 1 }),
      ],
      [
        { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
        { id: "zed", name: "Zed", isPersonal: false, href: "", settingsHref: "" },
      ],
    );

    expect(screen.queryAllByRole("button", { name: /\(\d+\)$/ })).toEqual([]);
    expect(
      screen.getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/^Zed.*Zed thread/),
      expect.stringMatching(/^Api.*Api thread/),
    ]);
  });

  it("collapses a project, keeping the open thread and the choice", async () => {
    window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "web-2" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "web-1", projectId: "web", title: "First" }),
            thread({ id: "web-2", projectId: "web", title: "Second" }),
            thread({ id: "api-1", projectId: "api", title: "Third" }),
          ],
          projects: [
            { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
            { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Web (2)" }));
    expect(
      screen.getByRole("button", { name: "Web (2)" }).getAttribute("aria-expanded"),
    ).toBe("false");
    const web = screen.getByRole("list", { name: "Web active threads" });
    expect(
      within(web).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Second")]);
    expect(screen.getByText("Third")).toBeDefined();
    await waitFor(() =>
      expect(
        window.localStorage.getItem("bb-sidebar:project-collapse:v1"),
      ).toBe(JSON.stringify(["web"])),
    );
  });

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
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
          workspaceDisplayKind: "managed-worktree", path: null, isWorktree: null, providerId: null
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
    expect(
      badge.compareDocumentPosition(machine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      machine.compareDocumentPosition(providerGlyph) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /No children.*child/i }),
    ).toBeNull();
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
    expect(badge.className).toContain(
      "bg-[color:var(--bb-sidebar-badge-failed-bg)]",
    );
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
    expect(badge.className).toContain(
      "bg-[color:var(--bb-sidebar-badge-working-bg)]",
    );
    expect(badge.querySelector('[data-icon="Loading"]')).not.toBeNull();
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
    expect(badge.className).toContain(
      "bg-[color:var(--bb-sidebar-badge-needs-you-bg)]",
    );
    expect(badge.querySelector('[data-icon="CircleQuestion"]')).not.toBeNull();
    expect(badge.querySelector('[data-icon="Loading"]')).toBeNull();
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
    for (const title of [
      "Failed child",
      "Waiting child",
      "Unread child",
      "Working child",
      "Carrier child",
    ]) {
      expect(within(childList).getByText(title)).toBeDefined();
    }
    expect(within(childList).queryByText("Idle child")).toBeNull();
    expect(
      within(
        screen.getByRole("list", { name: "Grandchildren of Carrier child" }),
      ).getByText("Failed grandchild"),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /6 child threads/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
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

    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Child threads" }),
      ).toBeNull(),
    );
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
      const rows = within(
        screen.getByRole("list", { name: "Child threads" }),
      ).getAllByText(/child$/);
      expect(rows.map((row) => row.textContent)).toEqual([
        "New child",
        "Old child",
      ]);
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
      expect(
        within(childList).getByRole("img", { name: "Codex" }),
      ).toBeDefined();
      expect(
        within(childList).getByRole("img", { name: "Claude Code" }),
      ).toBeDefined();
    });
  });

  it("ignores a settings load that answers after a newer one", async () => {
    const stale = deferred<typeof defaultSidebarSettings>();
    let loads = 0;
    const rendered = renderSlot(inbox, listProps, {
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
        getSidebarSettings: () => {
          loads += 1;
          return loads === 1
            ? stale.promise
            : {
                ...defaultSidebarSettings,
                showRunningChildrenWhenCollapsed: false,
              };
        },
        listLifecycle: () => ({ rows: [] }),
      },
    });

    await rendered.emitRealtime("sidebar-settings", {});
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Child threads" }),
      ).toBeNull(),
    );

    stale.resolve(defaultSidebarSettings);
    await stale.promise;
    await waitFor(() => expect(loads).toBe(2));
    expect(screen.queryByRole("list", { name: "Child threads" })).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem("bb-sidebar:settings-cache:v1") ?? "{}",
      ).showRunningChildrenWhenCollapsed,
    ).toBe(false);
  });

  it("highlights the active grandchild row", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              parentThreadId: "child",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const childRow = screen.getByRole("button", {
      name: "Open child thread: Child",
    });
    expect(childRow.getAttribute("aria-current")).toBeNull();
    const grandchildRow = screen.getByRole("button", {
      name: "Open grandchild thread: Grandchild",
    });
    expect(grandchildRow.getAttribute("aria-current")).toBe("page");
    expect(
      grandchildRow.closest("[data-child-thread-row]")?.className,
    ).toContain("bg-sidebar-accent");
  });

  it("marks a child from another project than its parent", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "child",
              title: "Child",
              projectId: "proj_2",
              parentThreadId: "parent",
            }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              projectId: "proj_2",
              parentThreadId: "child",
            }),
          ],
          projects: [
            { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
            { id: "proj_2", name: "xPlan", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const childRow = screen.getByRole("button", {
      name: "Open child thread: Child, in project xPlan",
    });
    expect(
      childRow.querySelector("[data-foreign-project]")?.getAttribute("data-foreign-project"),
    ).toBe("proj_2");
    // Same project as its own parent, so no mark.
    const grandchildRow = screen.getByRole("button", {
      name: "Open grandchild thread: Grandchild",
    });
    expect(grandchildRow.querySelector("[data-foreign-project]")).toBeNull();
  });

  it("shows every child status or an idle age in expanded rows and accessible names", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({
        monitoring: minute - 5 * 60_000,
        planning: minute - 5 * 60_000,
      }),
    );
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "failed",
        title: "Failed child",
        parentThreadId: "parent",
        indicator: "unread-error",
      }),
      thread({
        id: "unread",
        title: "Unread child",
        parentThreadId: "parent",
        indicator: "unread-success",
      }),
      thread({
        id: "waiting",
        title: "Waiting child",
        parentThreadId: "parent",
        indicator: "waiting-for-input",
      }),
      thread({
        id: "monitoring",
        title: "Monitoring child",
        parentThreadId: "parent",
        indicator: "runtime",
        indicatorLabel: "Thread monitoring",
      }),
      thread({
        id: "planning",
        title: "Planning child",
        parentThreadId: "parent",
        indicator: "plan-mode",
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 1,
          goals: 0,
        },
      }),
      thread({
        id: "pending-runtime",
        title: "Pending runtime child",
        parentThreadId: "parent",
        hasPendingInteraction: true,
        indicator: "runtime",
        indicatorLabel: "Agent is working",
      }),
      thread({
        id: "idle",
        title: "Idle child",
        parentThreadId: "parent",
        updatedAt: minute - 31 * 60_000,
      }),
    ]);

    const badge = screen.getByRole("button", {
      name: "7 child threads, 1 failed, 2 need you, 1 done, 2 working",
    });
    fireEvent.click(badge);

    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(badge.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();
    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(childList.getAttribute("data-child-thread-list")).toBe("sidebar");
    for (const label of [
      "Failed",
      "Unread",
      "Monitoring · 5m",
      "Planning · 5m",
    ]) {
      expect(within(childList).getByText(label)).toBeDefined();
    }
    expect(within(childList).getAllByText("Needs you")).toHaveLength(2);
    expect(within(childList).getByText("31m")).toBeDefined();
    expect(within(childList).queryByText("Agent is working")).toBeNull();

    for (const name of [
      "Open child thread: Failed child, Failed",
      "Open child thread: Unread child, Unread",
      "Open child thread: Waiting child, Needs you",
      "Open child thread: Monitoring child, Monitoring · 5m",
      "Open child thread: Planning child, Planning · 5m",
      "Open child thread: Pending runtime child, Needs you",
      "Open child thread: Idle child",
    ]) {
      expect(within(childList).getByRole("button", { name })).toBeDefined();
    }
    // Tint plus a leading rule: in dark the amber fill is only a 1.07:1 step
    // off the sidebar, so the rule is what actually finds the row.
    const needsYouRow = within(childList).getByRole("button", {
      name: "Open child thread: Pending runtime child, Needs you",
    }).parentElement!;
    expect(needsYouRow.className).toContain(
      "bg-[color:var(--bb-sidebar-needs-you-tint)]",
    );
    expect(needsYouRow.className).toContain(
      "shadow-[inset_2px_0_0_0_var(--bb-sidebar-needs-you-accent)]",
    );
    // and only that row: the rule is the tint's partner, not a row border.
    expect(
      within(childList).getByRole("button", {
        name: "Open child thread: Failed child, Failed",
      }).parentElement?.className,
    ).not.toContain("--bb-sidebar-needs-you-accent");

    // The slot takes exactly the width its label needs, up to the 112px the
    // longest status wants, so a short status or age hands the rest back to a
    // child title that a narrow sidebar has little room for.
    const monitoringSlot = within(childList).getByText("Monitoring · 5m")
      .parentElement!;
    expect(monitoringSlot.className).toContain("w-auto");
    expect(monitoringSlot.className).toContain("max-w-28");
    expect(monitoringSlot.className.split(" ")).not.toContain("w-28");
    expect(monitoringSlot.className.split(" ")).not.toContain("min-w-20");
    const idleSlot = within(childList).getByText("31m").parentElement!;
    expect(idleSlot.className).toContain("w-auto");
    expect(idleSlot.className.split(" ")).not.toContain("min-w-20");

    fireEvent.click(
      within(childList).getByRole("button", {
        name: "Open child thread: Monitoring child, Monitoring · 5m",
      }),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "monitoring",
      options: { split: false },
    });
    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem("bb-sidebar:child-expansion:v1") ?? "[]",
        ),
      ).toEqual(["parent"]),
    );
  });

  // bb adds indicator kinds over time. One this build has never seen has to
  // fall through to the age on a child row exactly as it does on a parent
  // card, and must not tint the rollup badge either.
  it("keeps the age on child and grandchild rows with an unrecognized indicator", () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Future child",
        parentThreadId: "parent",
        indicator: "something-bb-ships-later" as never,
        indicatorLabel: "Doing something new",
        updatedAt: minute - 4 * 60_000,
      }),
      thread({
        id: "grandchild",
        title: "Future grandchild",
        parentThreadId: "child",
        indicator: "another-thing-bb-ships-later" as never,
        indicatorLabel: "Also new",
        updatedAt: minute - 7 * 60_000,
      }),
    ]);

    const badge = screen.getByRole("button", { name: "1 child thread" });
    expect(badge.getAttribute("data-child-status")).toBeNull();
    expect(badge.className).toContain("bg-muted");
    fireEvent.click(badge);

    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByText("4m")).toBeDefined();
    expect(within(childList).queryByText("Doing something new")).toBeNull();
    expect(
      within(childList).getByRole("button", {
        name: "Open child thread: Future child",
      }),
    ).toBeDefined();

    fireEvent.click(
      within(childList).getByRole("button", {
        name: "Show 1 grandchild thread for Future child",
      }),
    );
    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Future child",
    });
    expect(within(grandchildList).getByText("7m")).toBeDefined();
    expect(within(grandchildList).queryByText("Also new")).toBeNull();
    expect(
      within(grandchildList).getByRole("button", {
        name: "Open grandchild thread: Future grandchild",
      }),
    ).toBeDefined();
  });

  // Grandchildren are rows like any other: they get the same vocabulary, and
  // the status sits beside the disclosure button rather than displacing it.
  it("shows the shared status on grandchild rows and beside a disclosure", () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ child: minute - 5 * 60_000 }),
    );
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Busy child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({
        id: "failed-grandchild",
        title: "Failed grandchild",
        parentThreadId: "child",
        indicator: "unread-error",
        indicatorLabel: "Unread thread failed",
      }),
      thread({
        id: "asking-grandchild",
        title: "Asking grandchild",
        parentThreadId: "child",
        hasPendingInteraction: true,
        indicator: "runtime",
        indicatorLabel: "Agent is working",
      }),
    ]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "1 child thread, 1 failed, 1 need you, 1 working",
      }),
    );
    const childList = screen.getByRole("list", { name: "Child threads" });
    const childRow = within(childList)
      .getByRole("button", { name: "Open child thread: Busy child, Working · 5m" })
      .closest("[data-child-thread-row]") as HTMLElement;
    const disclosure = within(childRow).getByRole("button", {
      name: "Show 2 grandchild threads for Busy child",
    });
    expect(within(childRow).getByText("Working · 5m")).toBeDefined();
    fireEvent.click(disclosure);

    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Busy child",
    });
    expect(within(grandchildList).getByText("Failed")).toBeDefined();
    expect(within(grandchildList).getByText("Needs you")).toBeDefined();
    // A raised hand outranks the runtime bb still reports for that thread.
    expect(within(grandchildList).queryByText(/^Working/)).toBeNull();
    for (const name of [
      "Open grandchild thread: Failed grandchild, Failed",
      "Open grandchild thread: Asking grandchild, Needs you",
    ]) {
      expect(within(grandchildList).getByRole("button", { name })).toBeDefined();
    }

    fireEvent.click(
      within(grandchildList).getByRole("button", {
        name: "Open grandchild thread: Failed grandchild, Failed",
      }),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "failed-grandchild",
      options: { split: false },
    });
  });

  it("retains the newest child expansions after saving and remounting", async () => {
    const key = "bb-sidebar:child-expansion:v1";
    const oldIds = Array.from({ length: 100 }, (_, index) => `z${String(index).padStart(3, "0")}`);
    const allThreads = [...oldIds, "a-newest", "b-next"].flatMap((id) => [
      thread({ id, title: id }),
      thread({ id: `${id}-child`, title: `${id}-child`, parentThreadId: id }),
    ]);
    localStorage.setItem(key, JSON.stringify(oldIds));
    const first = render(allThreads);
    const expand = (id: string) => {
      const card = screen.getByRole("link", { name: id }).closest("li")!;
      fireEvent.click(within(card).getByRole("button", { name: "1 child thread" }));
    };
    expand("a-newest");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(100));
    first.lifecycle.unmount();

    render(allThreads);
    expand("b-next");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toEqual([
      ...oldIds.slice(2), "a-newest", "b-next",
    ]));
    // 200 threads rendered twice: the default 5s budget leaves this stress
    // case no headroom on a loaded CI runner.
  }, 30_000);

  it("restores child expansion outside the parent card body", () => {
    window.localStorage.setItem(
      "bb-sidebar:child-expansion:v1",
      JSON.stringify(["parent"]),
    );
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);

    expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined();
    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(childList.closest("[data-parent-card]")).toBeNull();
  });

  it("reveals the active child without persisted expansion", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined();
    expect(screen.getByText("Child")).toBeDefined();
  });

  it("collapses a parent while its child is active, keeping only that child visible", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child-a" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child-a", title: "Child A", parentThreadId: "parent" }),
            thread({ id: "child-b", title: "Child B", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const badge = screen.getByRole("button", { name: "2 child threads" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.queryByText("Child B")).toBeNull();
    const activeRow = screen.getByRole("button", {
      name: "Open child thread: Child A",
    });
    expect(activeRow.getAttribute("aria-current")).toBe("page");
    expect(activeRow.closest("[data-child-thread-row]")?.className).toContain(
      "bg-sidebar-accent",
    );

    fireEvent.click(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.getByText("Child B")).toBeDefined();

    fireEvent.click(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Child A")).toBeDefined();
    expect(screen.queryByText("Child B")).toBeNull();
  });

  it("collapses a grandchild disclosure while a grandchild is active", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild-a" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({
              id: "grandchild-a",
              title: "Grandchild A",
              parentThreadId: "child",
            }),
            thread({
              id: "grandchild-b",
              title: "Grandchild B",
              parentThreadId: "child",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const disclosure = screen.getByRole("button", {
      name: "Show 2 grandchild threads for Child",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Grandchild A")).toBeDefined();
    expect(screen.queryByText("Grandchild B")).toBeNull();

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Grandchild B")).toBeDefined();

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Grandchild A")).toBeDefined();
    expect(screen.queryByText("Grandchild B")).toBeNull();
  });

  it("keeps an active child's parked parent visible on a collapsed shelf", async () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parked parent" }),
            thread({ id: "child", title: "Active child", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [
              {
                threadId: "parent",
                settledAt: 200,
                snoozedUntil: null,
                snoozedAt: null,
              },
            ],
          }),
        },
      },
    );

    const settled = await screen.findByRole("region", { name: "Settled" });
    expect(
      within(settled).getByRole("button", { expanded: false }),
    ).toBeDefined();
    expect(within(settled).getByText("Parked parent")).toBeDefined();
  });

  it("reveals the active grandchild and its child disclosure", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              parentThreadId: "child",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    expect(
      screen.getByRole("list", { name: "Grandchildren of Child" }),
    ).toBeDefined();
    expect(screen.getByText("Grandchild")).toBeDefined();
  });

  it("prunes expansion state for parents that no longer have children", async () => {
    window.localStorage.setItem(
      "bb-sidebar:child-expansion:v1",
      JSON.stringify(["parent", "deleted-parent"]),
    );
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);

    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem("bb-sidebar:child-expansion:v1") ?? "[]",
        ),
      ).toEqual(["parent"]),
    );
  });

  it("archives the selected child instead of its parent", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Open child thread: Child" }),
    );

    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Thread actions" })).getByText(
        "Archive",
      ),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "archive",
      threadId: "child",
    });
    expect(rendered.sidebarActionCalls).not.toContainEqual({
      method: "archive",
      threadId: "parent",
    });
  });

  it("releases the agent sessions archive leaves loaded", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "idle-child", title: "Idle child", parentThreadId: "parent" }),
      thread({
        id: "busy-child",
        title: "Busy child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({ id: "stranger", title: "Stranger" }),
    ]);

    fireEvent.contextMenu(screen.getByText("Parent"));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Thread actions" })).getByText(
        "Archive",
      ),
    );

    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "archive",
      threadId: "parent",
    });
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "releaseRuntimes",
        input: { threadIds: ["parent", "idle-child"] },
      }),
    );
  });

  for (const busyChild of [
    thread({ id: "running", title: "Running child", indicator: "runtime" }),
    thread({
      id: "needs-input",
      title: "Needs input child",
      hasPendingInteraction: true,
    }),
  ]) {
    it(`disables Archive for a busy child: ${busyChild.id}`, async () => {
      render([
        thread({ id: "parent", title: "Parent" }),
        { ...busyChild, parentThreadId: "parent" },
      ]);
      fireEvent.click(screen.getByRole("button", { name: /^1 child thread/ }));
      fireEvent.contextMenu(
        screen.getByRole("button", {
          name: `Open child thread: ${busyChild.title}${
            busyChild.hasPendingInteraction ? ", Needs you" : ", Working"
          }`,
        }),
      );

      const archive = within(
        await screen.findByRole("menu", { name: "Thread actions" }),
      ).getByText("Archive");
      expect(archive.getAttribute("data-disabled")).not.toBeNull();
    });
  }

  it("shows one collapsed grandchild level without changing the parent count", () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Child",
        parentThreadId: "parent",
      }),
      thread({
        id: "grandchild",
        title: "Grandchild",
        parentThreadId: "child",
      }),
      thread({
        id: "great-grandchild",
        title: "Great-grandchild",
        parentThreadId: "grandchild",
      }),
    ]);

    const parentBadge = screen.getByRole("button", {
      name: "1 child thread",
    });
    fireEvent.click(parentBadge);

    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByText("Child")).toBeDefined();
    expect(screen.queryByText("Grandchild")).toBeNull();
    expect(screen.queryByText("Great-grandchild")).toBeNull();

    const disclosure = within(childList).getByRole("button", {
      name: "Show 1 grandchild thread for Child",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();

    fireEvent.click(disclosure);

    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Child",
    });
    expect(grandchildList.getAttribute("data-grandchild-thread-list")).toBe(
      "sidebar",
    );
    expect(within(grandchildList).getByText("Grandchild")).toBeDefined();
    expect(screen.queryByText("Great-grandchild")).toBeNull();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();

    fireEvent.click(
      within(grandchildList).getByRole("button", {
        name: "Open grandchild thread: Grandchild",
      }),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "grandchild",
      options: { split: false },
    });
  });

  it("removes archived children from the sidebar badge and list", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "visible-child",
        title: "Visible child",
        parentThreadId: "parent",
      }),
      thread({
        id: "archived-child",
        title: "Archived child",
        parentThreadId: "parent",
        isArchived: true,
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(screen.getByText("Visible child")).toBeDefined();
    expect(screen.queryByText("Archived child")).toBeNull();
  });

  it("shows bb's jump shortcut hints only while the modifier is held", () => {
    vi.useFakeTimers();
    try {
      render(
        Array.from({ length: 10 }, (_, index) =>
          thread({ id: `thr_${index}`, title: `Thread ${index}` }),
        ),
      );
      const hints = () =>
        [...document.querySelectorAll("kbd")].map((hint) => hint.textContent);

      // jsdom reports no Mac platform, so the modifier is Control.
      fireEvent.keyDown(window, { key: "Control" });
      act(() => vi.advanceTimersByTime(699));
      expect(hints()).toEqual([]);

      act(() => vi.advanceTimersByTime(1));
      expect(hints()).toEqual(
        Array.from({ length: 9 }, (_, index) => `Ctrl + ${index + 1}`),
      );

      fireEvent.keyUp(window, { key: "Control" });
      expect(hints()).toEqual([]);

      // A quick chord never shows them.
      fireEvent.keyDown(window, { key: "Control" });
      fireEvent.keyDown(window, { key: "c", ctrlKey: true });
      act(() => vi.advanceTimersByTime(1_000));
      expect(hints()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a thread normally when the platform modifier is held", () => {
    const rendered = render([thread({ id: "thr_modifier" })]);
    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_modifier",
      options: { split: false },
    });
    expect(
      screen.queryByRole("toolbar", { name: /threads selected/ }),
    ).toBeNull();
  });

  it("keeps a separate collapsible Pinned shelf above Active", () => {
    render([
      thread({ id: "a", title: "Plain" }),
      thread({ id: "b", title: "Stuck", isPinned: true }),
    ]);

    const active = screen.getByRole("region", { name: "Active" });
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      pinned.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(active).queryByText("Inbox")).toBeNull();
    expect(within(active).getByText("Plain")).toBeDefined();
    expect(within(active).queryByText("Stuck")).toBeNull();
    expect(within(pinned).getByText("Stuck")).toBeDefined();
    fireEvent.click(within(pinned).getByRole("button", { expanded: true }));
    expect(within(pinned).getByText("Pinned (1)")).toBeDefined();
    expect(within(pinned).queryByText("Stuck")).toBeNull();
    expect(within(active).getByText("Plain")).toBeDefined();
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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

  it.each([false, true])("skips provisional null pin keys and retains eligible child roots: child=%s", async (withChild) => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Confirmed A", isPinned: true, pinnedAt: 1, pinSortKey: "A" }),
          thread({ id: "b", title: "Confirmed B", isPinned: true, pinnedAt: 2, pinSortKey: "C" }),
          thread({ id: "pending", title: "Provisional pin", isPinned: true, pinnedAt: 3, pinSortKey: null }),
          ...(withChild ? [thread({ id: "child", title: "Keyed child", parentThreadId: "pending", isPinned: true, pinnedAt: 4, pinSortKey: "D" })] : []),
        ],
        projects: [],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          const { threadId, previousThreadId, nextThreadId } = input as { threadId: string; previousThreadId: string | null; nextThreadId: string | null };
          // Canonical BB excludes null-key rows from both moving roots and neighbours.
          if ([threadId, previousThreadId, nextThreadId].includes("pending")) throw new Error("stale_neighbor");
          return { pinnedThreadIds: ["b", "a", ...(withChild ? ["child"] : []), "pending"] };
        },
      },
    });
    const card = await screen.findByRole("link", { name: "Confirmed A" });
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(rendered.rpcCalls.find((call) => call.method === "reorderPinned")?.input).toEqual({
      threadId: "a", previousThreadId: "b", nextThreadId: withChild ? "child" : null,
    }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Pinned" })).getAllByRole("link")[0]!.getAttribute("aria-label")).toBe("Confirmed B"));
    const pending = screen.getByRole("link", { name: "Provisional pin" });
    expect(pending.getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.keyDown(pending, { key: "ArrowUp", altKey: true });
    expect(rendered.rpcCalls.filter((call) => call.method === "reorderPinned")).toHaveLength(1);
  });

  it("sorts pins across projects before choosing reorder neighbors", async () => {
    let reorderInput: unknown = null;
    const pin = (id: string, key: string, projectId: string) => ({
      ...thread({ id, title: `Pin ${id.toUpperCase()}`, isPinned: true, projectId }),
      pinSortKey: key,
    });
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        // The SDK flattens project groups, not the global pinned order.
        threads: [pin("c", "c", "proj_1"), pin("a", "a", "proj_2"), pin("b", "b", "proj_2")],
        projects: [
          { id: "proj_1", name: "One", isPersonal: false, href: "", settingsHref: "" },
          { id: "proj_2", name: "Two", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          reorderInput = input;
          return { pinnedThreadIds: ["a", "c", "b"] };
        },
      },
    });
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    expect(within(pinned).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Pin A"),
      expect.stringContaining("Pin B"),
      expect.stringContaining("Pin C"),
    ]);
    fireEvent.keyDown(screen.getByRole("link", { name: "Pin C" }), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(reorderInput).toEqual({
      threadId: "c", previousThreadId: "a", nextThreadId: "b",
    }));
    await waitFor(() => expect(within(pinned).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Pin A"),
      expect.stringContaining("Pin C"),
      expect.stringContaining("Pin B"),
    ]));
  });

  it("allows a pinned child of an unpinned parent to anchor a reorder", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "child", title: "Pinned child", parentThreadId: "unpinned-parent", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          reorderInput = input;
          return { pinnedThreadIds: ["a", "child", "c", "b"] };
        },
      },
    });
    fireEvent.keyDown(await screen.findByRole("link", { name: "Pin C" }), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(reorderInput).toEqual({
      threadId: "c", previousThreadId: "child", nextThreadId: "b",
    }));
  });

  it("never sends a pinned child thread as a reorder neighbor", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          // Hidden behind A's header chip, but still in bb's pinned order.
          thread({
            id: "child",
            title: "Pinned child",
            parentThreadId: "a",
            isPinned: true,
          }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          reorderInput = input;
          return { pinnedThreadIds: ["a", "c", "child", "b"] };
        },
      },
    });

    const pinC = await screen.findByRole("link", { name: "Pin C" });
    fireEvent.keyDown(pinC, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "c",
        previousThreadId: "a",
        nextThreadId: "b",
      }),
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned).getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Pin A"),
      expect.stringContaining("Pin C"),
      expect.stringContaining("Pin B"),
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
      buttons: 1,
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    const list = card.closest("ul")!;
    expect(list.hasAttribute("data-drag-preview")).toBe(true);
    expect(card.closest("[data-drag-visual]")).not.toBeNull();
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    expect(list.hasAttribute("data-drag-preview")).toBe(false);
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "a",
        previousThreadId: "b",
        nextThreadId: "c",
      }),
    );
  });

  it("retains attention root across reorder", async () => {
    window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ pinned: true }));
    const pending = deferred<{ pinnedThreadIds: string[] }>();
    let reorderInput: unknown = null;
    const rendered = renderSlot(inbox, { ...listProps, activeThreadId: null }, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "attention-root", title: "Attention root", isPinned: true }),
          thread({ id: "idle-root", title: "Idle root", isPinned: true }),
          thread({ id: "attention-child", title: "Attention child", parentThreadId: "attention-root", indicator: "waiting-for-input" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listLifecycle: () => ({ rows: [] }),
        reorderPinned: (input) => {
          reorderInput = input;
          return pending.promise;
        },
      },
    });
    await waitFor(() => {
      expect(rendered.rpcCalls.some((call) => call.method === "getSidebarSettings")).toBe(true);
      expect(rendered.rpcCalls.some((call) => call.method === "listLifecycle")).toBe(true);
    });
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual(["Attention root", "Idle root"]);
    expect(within(pinned).getByRole("button", { name: /^1 child thread/, expanded: false })).toBeDefined();
    const card = within(pinned).getByRole("link", { name: "Attention root" });
    const target = within(pinned).getByRole("link", { name: "Idle root" }).closest("li")!;
    vi.mocked(document.elementFromPoint).mockReturnValue(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 40, left: 0, right: 200, width: 200, height: 40,
      x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
    expect(card.closest("ul")!.hasAttribute("data-drag-preview")).toBe(true);
    expect(within(pinned).getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual(["Idle root", "Attention root"]);
    expect(within(pinned).getByRole("button", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
    fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });
    await waitFor(() => expect(reorderInput).toEqual({
      threadId: "attention-root", previousThreadId: "idle-root", nextThreadId: null,
    }));
    fireEvent.click(within(pinned).getByRole("button", { name: /^Pinned/, expanded: true }));
    expect(within(pinned).getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual(["Attention root"]);
    expect(within(pinned).queryByRole("link", { name: "Idle root" })).toBeNull();
    expect(within(pinned).getByRole("button", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
    await act(async () => {
      pending.resolve({ pinnedThreadIds: ["idle-root", "attention-root"] });
      await pending.promise;
    });
    expect(within(pinned).getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual(["Attention root"]);
    expect(within(pinned).getByRole("button", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
    fireEvent.click(within(pinned).getByRole("button", { name: /^Pinned/, expanded: false }));
    expect(within(pinned).getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual(["Idle root", "Attention root"]);
    expect(within(pinned).getByRole("button", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
  });

  it.each(
    [true, false].flatMap((pinned) =>
      ["down", "up"].flatMap((direction) =>
        [60, 120].map((neighbourHeight) => ({ pinned, direction, neighbourHeight })),
      ),
    ),
  )("crosses the row boundary without oscillation: $pinned/$direction/$neighbourHeight", async ({ pinned, direction, neighbourHeight }) => {
    const movingId = direction === "down" ? "a" : "b";
    const neighbourId = movingId === "a" ? "b" : "a";
    const finalOrder = ["b", "a"];
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Row A", isPinned: pinned }),
          thread({ id: "b", title: "Row B", isPinned: pinned }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listInboxOrder: () => ({ inboxThreadIds: ["a", "b"] }),
        reorderPinned: () => ({ pinnedThreadIds: finalOrder }),
        reorderInbox: () => ({ inboxThreadIds: finalOrder }),
      },
    });
    const card = await screen.findByRole("link", { name: movingId === "a" ? "Row A" : "Row B" });
    const list = card.closest("ul")!;
    const rows = Array.from(list.children) as HTMLElement[];
    const scroll = list.parentElement!;
    let frame: FrameRequestCallback | undefined;
    const checkScroll = direction === "down" && neighbourHeight === 120;
    if (checkScroll) {
      scroll.style.overflowY = "auto";
      Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
      vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, left: 0, right: 200 } as DOMRect);
      const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
      onTestFinished(() => animationFrame.mockRestore());
    }
    const id = (row: Element) => row.querySelector<HTMLElement>("[data-sidebar-thread-id]")!.dataset.sidebarThreadId!;
    const height = (row: Element) => id(row) === movingId ? 60 : neighbourHeight;
    const rect = (row: Element) => {
      const ordered = Array.from(list.children);
      const top = ordered.slice(0, ordered.indexOf(row)).reduce((sum, r) => sum + height(r), 0) - scroll.scrollTop;
      return { top, bottom: top + height(row), height: height(row), left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) };
    };
    for (const row of rows) vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => rect(row));
    vi.mocked(document.elementFromPoint).mockImplementation((_x, y) =>
      rows.find((row) => y >= rect(row).top && y < rect(row).bottom) ?? null,
    );
    const neighbour = rows.find((row) => id(row) === neighbourId)!;
    const start = rect(card.closest("li")!).top + 30;
    const boundary = direction === "down" ? rect(neighbour).top + 1 : rect(neighbour).bottom - 1;
    const move = (y: number) => fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: y, pointerId: 1 });
    const order = () => Array.from(list.children).map(id);
    fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: start, pointerId: 1 });
    move(boundary);
    expect(order()).toEqual(finalOrder); // Just 1px inside the neighbour, before its midpoint.
    for (let i = 0; i < 3; i += 1) move(boundary);
    expect(order()).toEqual(finalOrder);
    const forward = boundary + (direction === "down" ? 1 : -1);
    move(forward);
    expect(order()).toEqual(finalOrder); // Tall neighbour still under cursor after the swap.
    expect(rendered.rpcCalls.filter((call) => call.method.startsWith("reorder"))).toHaveLength(0);
    move(boundary); // Immediate 1px reversal, with no timer or extra distance threshold.
    expect(order()).toEqual(neighbourHeight > 60 ? ["a", "b"] : finalOrder);
    if (neighbourHeight > 60) move(forward);
    expect(order()).toEqual(finalOrder);
    if (checkScroll) {
      for (let i = 0; i < 3; i += 1) {
        act(() => frame!(i * 16));
        expect(order()).toEqual(finalOrder);
      }
      expect(scroll.scrollTop).toBeGreaterThan(0);
    }
    fireEvent.pointerUp(window, { clientX: 20, clientY: forward, pointerId: 1 });
    await waitFor(() => expect(rendered.rpcCalls.filter((call) => call.method === (pinned ? "reorderPinned" : "reorderInbox"))).toHaveLength(1));
    const saved = rendered.rpcCalls.find((call) => call.method === (pinned ? "reorderPinned" : "reorderInbox"))!;
    expect(saved.input).toEqual(pinned
      ? { threadId: movingId, previousThreadId: direction === "down" ? neighbourId : null, nextThreadId: direction === "up" ? neighbourId : null }
      : { inboxThreadIds: finalOrder });
  });

  it.each(["Escape", "blur", "pointercancel", "unmount"])(
    "cleans up the drag preview on %s without saving",
    async (reason) => {
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Pin A", isPinned: true }),
            thread({ id: "b", title: "Pin B", isPinned: true }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      });
      const card = await screen.findByRole("link", { name: "Pin A" });
      const list = card.closest("ul")!;
      const target = screen.getByText("Pin B").closest("li")!;
      vi.mocked(document.elementFromPoint).mockReturnValue(target);
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
      expect(list.hasAttribute("data-drag-preview")).toBe(true);
      if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (reason === "blur") fireEvent.blur(window);
      else if (reason === "pointercancel") fireEvent.pointerCancel(window, { pointerId: 1 });
      else rendered.unmount();
      expect(list.hasAttribute("data-drag-preview")).toBe(false);
      expect(document.body.style.cursor).toBe(previousCursor);
      expect(document.body.style.userSelect).toBe(previousSelect);
      fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });
      expect(rendered.rpcCalls.filter((call) => call.method === "reorderPinned")).toHaveLength(0);
    },
  );

  it("cancels shelf reordering when bb takes over a split drag", async () => {
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
      buttons: 1,
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

  it("stops suppressing clicks once the drag's own click is swallowed", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
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
      buttons: 1,
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });

    const openCalls = () =>
      rendered.sidebarActionCalls.filter((call) => call.method === "open")
        .length;
    const settled = openCalls();

    // The gesture's own click.
    fireEvent.click(card);
    expect(openCalls()).toBe(settled);

    // Enter on the same row raises a click with no pointer press in front of
    // it. Staying armed would swallow that one too, indefinitely.
    fireEvent.click(card);
    expect(openCalls()).toBe(settled + 1);
  });

  it("announces the new position after a keyboard reorder", async () => {
    renderSlot(inbox, listProps, {
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
        reorderPinned: () => ({ pinnedThreadIds: ["b", "a"] }),
      },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    expect(screen.getByText("Pin A moved to 2 of 2 in Pinned")).toBeDefined();

    // The row is last now, so the same key is a no-op — and silence would leave
    // a keyboard user unsure whether the press registered at all.
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Pinned" }))
          .getAllByRole("listitem")[0]!.textContent,
      ).toContain("Pin B"),
    );
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(screen.getByText("Pin A is already last in Pinned")).toBeDefined(),
    );
  });

  it("leaves a touch gesture to the scroller instead of reordering", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 20,
      clientY: 0,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 20,
      clientY: 30,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
      pointerType: "touch",
    });

    expect(
      rendered.rpcCalls.filter((call) => call.method === "reorderPinned"),
    ).toHaveLength(0);
    expect(
      within(screen.getByRole("region", { name: "Pinned" }))
        .getAllByRole("listitem")[0]!.textContent,
    ).toContain("Pin A");
  });

  it("does not open the thread when a drag is cancelled with Escape", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
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
      buttons: 1,
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
    });
    const openedBeforeClick = rendered.sidebarActionCalls.filter(
      (call) => call.method === "open",
    ).length;
    // The browser raises this once the gesture ends. Cancelling a drag must not
    // navigate into the row the drag started from.
    fireEvent.click(card);

    expect(
      rendered.sidebarActionCalls.filter((call) => call.method === "open"),
    ).toHaveLength(openedBeforeClick);
  });

  describe("moving projects as a whole", () => {
    it.each([true, false])("retains scoped active and deep queued attention in a collapsed project: setting=%s", async (showAttention) => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:project-collapse:v1", JSON.stringify(["web"]));
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "b" }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", projectId: "web", title: "Attention root", updatedAt: Date.now() }),
            thread({ id: "b", projectId: "web", title: "Active root", updatedAt: Date.now() }),
            thread({ id: "child", projectId: "web", parentThreadId: "a", title: "Child" }),
            thread({ id: "grandchild", projectId: "web", parentThreadId: "child", title: "Grandchild" }),
            thread({ id: "deep", projectId: "web", parentThreadId: "grandchild", title: "Queued failed leaf", queuedWork: "failed" }),
          ],
          projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => ({ ...defaultSidebarSettings, showRunningChildrenWhenCollapsed: showAttention }),
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: ["a", "b", "child", "grandchild", "deep"] }),
        },
      });
      await waitFor(() => expect(rendered.rpcCalls.some((call) => call.method === "getSidebarSettings")).toBe(true));
      const active = screen.getByRole("region", { name: "Active" });
      await waitFor(() => expect(within(active).getAllByRole("link").map((row) => row.getAttribute("aria-label"))).toEqual(showAttention ? ["Attention root", "Active root"] : ["Active root"]));
      expect(within(active).getByRole("button", { name: "Web (2)", expanded: false })).toBeDefined();
      expect(Boolean(within(active).queryByText("Queued failed leaf"))).toBe(showAttention);
      expect(rendered.rpcCalls.filter((call) => call.method.startsWith("reorder"))).toEqual([]);
    });

    it.each(["keyboard", "pointer"].flatMap((gesture) => [false, true].map((singleton) => ({ gesture, singleton }))))("persists collapsed project attention rows: $gesture/singleton=$singleton", async ({ gesture, singleton }) => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      const childIds = ["a1", "a2", "a3", "b1", ...(singleton ? ["x1"] : [])];
      const storedIds = ["a", "x", "b", "c", ...childIds];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            ...["a", "b", "c"].map((id) => thread({ id, projectId: "web", title: `Web ${id}`, updatedAt: Date.now() })),
            thread({ id: "x", projectId: "api", title: "Hidden other project", updatedAt: Date.now() }),
            thread({ id: "a1", projectId: "web", parentThreadId: "a", title: "Child a" }),
            thread({ id: "a2", projectId: "web", parentThreadId: "a1", title: "Grandchild a" }),
            thread({ id: "a3", projectId: "web", parentThreadId: "a2", title: "Deep failed", queuedWork: "failed" }),
            thread({ id: "b1", projectId: "web", parentThreadId: "b", title: "Child b", hasPendingInteraction: true }),
            ...(singleton ? [thread({ id: "x1", projectId: "api", parentThreadId: "x", title: "Child x", hasPendingInteraction: true })] : []),
          ],
          projects: [
            { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
            { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: storedIds }),
          reorderInbox: (input) => input,
        },
      });
      const active = await screen.findByRole("region", { name: "Active" });
      const rowOrder = () => within(active).getAllByRole("link").map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(rowOrder()).toEqual(singleton ? ["Web a", "Hidden other project", "Web b"] : ["Web a", "Web b"]));
      expect(within(active).queryByRole("button", { name: "Web (3)" })).toBeNull();
      expect(within(active).getByText("Deep failed")).toBeDefined();
      const card = within(active).getByRole("link", { name: singleton ? "Hidden other project" : "Web a" });
      let preview: Array<string | null> | undefined;
      if (gesture === "keyboard") {
        fireEvent.keyDown(card, { key: singleton ? "ArrowUp" : "ArrowDown", altKey: true });
      } else {
        const target = within(active).getByRole("link", { name: singleton ? "Web a" : "Web b" }).closest("li")!;
        vi.mocked(document.elementFromPoint).mockReturnValue(target);
        fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: singleton ? 60 : 0, pointerId: 1 });
        fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: singleton ? 30 : 60, pointerId: 1 });
        preview = rowOrder();
        fireEvent.pointerUp(window, { clientX: 20, clientY: singleton ? 30 : 60, pointerId: 1 });
      }
      await waitFor(() => expect(rendered.rpcCalls.filter((call) => call.method === "reorderInbox")).toHaveLength(1));
      const expectedVisible = singleton ? ["Hidden other project", "Web a", "Web b"] : ["Web b", "Web a"];
      expect({ preview, input: rendered.rpcCalls.find((call) => call.method === "reorderInbox")!.input }).toEqual({
        preview: gesture === "pointer" ? expectedVisible : undefined,
        input: { inboxThreadIds: [...(singleton ? ["x", "a", "b", "c"] : ["b", "x", "a", "c"]), ...childIds] },
      });
      await waitFor(() => expect(rowOrder()).toEqual(expectedVisible));
      fireEvent.click(within(active).getByRole("button", { name: /^Active/, expanded: false }));
      expect(within(active).getByRole("button", { name: "Web (3)" })).toBeDefined();
      expect(within(active).getByRole("link", { name: "Web c" })).toBeDefined();
      expect(rendered.rpcCalls.filter((call) => /^(pin|setThreadParent|reorderPinned)$/.test(call.method))).toEqual([]);
    });

    it.each(["shelf", "project"].flatMap(fold => ["keyboard", "pointer"].map(gesture => ({fold,gesture}))))("F1 keeps hidden sibling slot: $fold/$gesture", async ({fold,gesture}) => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      if (fold === "shelf") window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({active:false}));
      else window.localStorage.setItem("bb-sidebar:project-collapse:v1", JSON.stringify(["web"]));
      const order = ["a","hidden","b","ca","cb"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: { status:"ready", projects:[{id:"web",name:"Web",isPersonal:false,href:"",settingsHref:""}], threads:[
          ...["a","hidden","b"].map(id=>thread({id,title:id,projectId:"web",updatedAt:Date.now()})),
          thread({id:"ca",title:"ca",projectId:"web",parentThreadId:"a",hasPendingInteraction:true}),
          thread({id:"cb",title:"cb",projectId:"web",parentThreadId:"b",hasPendingInteraction:true}),
        ]},
        rpc:{getSidebarSettings:()=>defaultSidebarSettings,listLifecycle:()=>({rows:[]}),listInboxOrder:()=>({inboxThreadIds:order}),reorderInbox:input=>input}
      });
      const active=screen.getByRole("region",{name:"Active"});
      const visible=()=>within(active).getAllByRole("link").map(e=>e.getAttribute("aria-label"));
      await waitFor(()=>expect(visible()).toEqual(["a","b"]));
      await waitFor(()=>expect(rendered.rpcCalls.some(c=>c.method==="listInboxOrder")).toBe(true));
      const a=within(active).getByRole("link",{name:"a"});
      if(gesture==="keyboard") fireEvent.keyDown(a,{key:"ArrowDown",altKey:true});
      else {
        vi.mocked(document.elementFromPoint).mockReturnValue(within(active).getByRole("link",{name:"b"}).closest("li")!);
        fireEvent.pointerDown(a,{button:0,clientX:20,clientY:0,pointerId:1});
        fireEvent.pointerMove(window,{buttons:1,clientX:20,clientY:60,pointerId:1});
        expect(visible()).toEqual(["b","a"]);
        fireEvent.pointerUp(window,{clientX:20,clientY:60,pointerId:1});
      }
      await waitFor(()=>expect(rendered.rpcCalls.filter(c=>c.method==="reorderInbox")).toHaveLength(1));
      const actual=rendered.rpcCalls.find(c=>c.method==="reorderInbox")!.input;
      expect(actual).toEqual({inboxThreadIds:["b","hidden","a","ca","cb"]});
    });
    it.each(["keyboard","pointer"])("F1 keeps unrepresented project slot: %s",async gesture=>{
      window.localStorage.setItem("bb-sidebar:active-sort:v1","project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1",JSON.stringify({active:false}));
      const order=["a","hidden-project","x","b","ca","cx"];
      const rendered=renderSlot(inbox,listProps,{
        sidebarThreads:{status:"ready",projects:["web","hidden-project","api"].map(id=>({id,name:id,isPersonal:false,href:"",settingsHref:""})),threads:[
          thread({id:"a",title:"a",projectId:"web",updatedAt:Date.now()}),
          thread({id:"b",title:"b",projectId:"web",updatedAt:Date.now()}),
          thread({id:"hidden-project",title:"hidden-project",projectId:"hidden-project",updatedAt:Date.now()}),
          thread({id:"x",title:"x",projectId:"api",updatedAt:Date.now()}),
          thread({id:"ca",title:"ca",projectId:"web",parentThreadId:"a",hasPendingInteraction:true}),
          thread({id:"cx",title:"cx",projectId:"api",parentThreadId:"x",hasPendingInteraction:true}),
        ]},rpc:{getSidebarSettings:()=>defaultSidebarSettings,listLifecycle:()=>({rows:[]}),listInboxOrder:()=>({inboxThreadIds:order}),reorderInbox:input=>input}
      });
      const active=screen.getByRole("region",{name:"Active"});
      await waitFor(()=>expect(within(active).getAllByRole("link").map(e=>e.getAttribute("aria-label"))).toEqual(["a","x"]));
      const x=within(active).getByRole("link",{name:"x"});
      if(gesture==="keyboard")fireEvent.keyDown(x,{key:"ArrowUp",altKey:true});
      else{
        vi.mocked(document.elementFromPoint).mockReturnValue(within(active).getByRole("link",{name:"a"}).closest("li")!);
        fireEvent.pointerDown(x,{button:0,clientX:20,clientY:90,pointerId:1});
        fireEvent.pointerMove(window,{buttons:1,clientX:20,clientY:30,pointerId:1});
        fireEvent.pointerUp(window,{clientX:20,clientY:30,pointerId:1});
      }
      await waitFor(()=>expect(rendered.rpcCalls.filter(c=>c.method==="reorderInbox")).toHaveLength(1));
      const actual=rendered.rpcCalls.find(c=>c.method==="reorderInbox")!.input;
      expect(actual).toEqual({inboxThreadIds:["x","hidden-project","a","b","ca","cx"]});
    });

    it("F1 rebases participating siblings onto a pushed order without moving hidden slots", async () => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      let order = ["a", "hidden", "b", "z", "ca", "cb"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
          threads: [
            ...["a", "hidden", "b", "z"].map((id) => thread({ id, title: id, projectId: "web", updatedAt: Date.now() })),
            thread({ id: "ca", title: "ca", projectId: "web", parentThreadId: "a", hasPendingInteraction: true }),
            thread({ id: "cb", title: "cb", projectId: "web", parentThreadId: "b", hasPendingInteraction: true }),
          ],
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          reorderInbox: (input) => input,
        },
      });
      const active = screen.getByRole("region", { name: "Active" });
      const visible = () => within(active).getAllByRole("link").map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(visible()).toEqual(["a", "b"]));
      const a = within(active).getByRole("link", { name: "a" });
      vi.mocked(document.elementFromPoint).mockReturnValue(within(active).getByRole("link", { name: "b" }).closest("li")!);
      fireEvent.pointerDown(a, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 60, pointerId: 1 });
      expect(visible()).toEqual(["b", "a"]);
      order = ["z", "a", "hidden", "b", "ca", "cb"];
      await rendered.behavior.emitRealtime("inbox-order", {});
      fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 1 });
      await waitFor(() => expect(rendered.rpcCalls.find((call) => call.method === "reorderInbox")?.input).toEqual({
        inboxThreadIds: ["z", "b", "hidden", "a", "ca", "cb"],
      }));
      expect(visible()).toEqual(["b", "a"]);
    });

    it.each(["singleton-grows", "source-joins-target"])("F2 cancels a vanished moving unit key: %s", async (change) => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      const rows = [
        thread({ id: "a", title: "a", projectId: "web", updatedAt: Date.now() }),
        thread({ id: "x", title: "x", projectId: "api", updatedAt: Date.now() }),
        thread({ id: "y", title: "y", projectId: "zed", updatedAt: Date.now() }),
        thread({ id: "b", title: "b", projectId: "web", updatedAt: Date.now() }),
        ...[["ca", "a", "web"], ["cx", "x", "api"], ["cy", "y", "zed"]].map(([id, parentThreadId, projectId]) =>
          thread({ id, title: id, parentThreadId, projectId, hasPendingInteraction: true }),
        ),
      ];
      let order = ["a", "x", "y", "b", "ca", "cx", "cy"];
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: null }, {
        sidebarThreads: {
          status: "ready",
          threads: rows,
          projects: ["web", "api", "zed"].map((id) => ({ id, name: id, isPersonal: false, href: "", settingsHref: "" })),
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          reorderInbox: (input) => {
            order = (input as { inboxThreadIds: string[] }).inboxThreadIds;
            return { inboxThreadIds: order };
          },
        },
      });
      const active = screen.getByRole("region", { name: "Active" });
      const visible = () => within(active).getAllByRole("link").map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(visible()).toEqual(["a", "x", "y"]));
      vi.mocked(document.elementFromPoint).mockReturnValue(within(active).getByRole("link", { name: "a" }).closest("li")!);
      fireEvent.pointerDown(within(active).getByRole("link", { name: "x" }), { button: 0, clientX: 20, clientY: 90, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
      expect(visible()).toEqual(["x", "a", "y"]);
      // Update the public harness input, then refresh through its public event drivers.
      if (change === "singleton-grows") {
        rows.push(thread({ id: "x2", title: "x2", projectId: "api", updatedAt: Date.now() }));
        order = ["a", "x", "y", "b", "x2", "ca", "cx", "cy"];
      } else {
        const index = rows.findIndex((row) => row.id === "x");
        rows[index] = { ...rows[index]!, projectId: "web" };
      }
      const expected = [...order];
      await rendered.behavior.emitRealtime("lifecycle", {});
      await rendered.behavior.emitRealtime("inbox-order", {});
      await waitFor(() => expect(visible()).toEqual(["a", "x", "y"]));
      fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });
      await act(async () => {});
      expect({ order, rpc: rendered.rpcCalls.filter((call) => call.method === "reorderInbox") }).toEqual({ order: expected, rpc: [] });
      expect(visible()).toEqual(["a", "x", "y"]);
      expect(active.querySelector("[data-drag-preview]")).toBeNull();
      expect(document.body.style.cursor).toBe("");
    });

    it("F2 preserves the member-shrinks no-op", async () => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      const rows = [
        ...["a", "hidden", "b"].map((id) => thread({ id, title: id, projectId: "web", updatedAt: Date.now() })),
        thread({ id: "ca", title: "ca", projectId: "web", parentThreadId: "a", hasPendingInteraction: true }),
        thread({ id: "cb", title: "cb", projectId: "web", parentThreadId: "b", hasPendingInteraction: true }),
      ];
      let order = ["a", "hidden", "b", "ca", "cb"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: { status: "ready", threads: rows, projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }] },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          reorderInbox: (input) => input,
        },
      });
      const active = screen.getByRole("region", { name: "Active" });
      const visible = () => within(active).getAllByRole("link").map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(visible()).toEqual(["a", "b"]));
      vi.mocked(document.elementFromPoint).mockReturnValue(within(active).getByRole("link", { name: "b" }).closest("li")!);
      fireEvent.pointerDown(within(active).getByRole("link", { name: "a" }), { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 60, pointerId: 1 });
      expect(visible()).toEqual(["b", "a"]);
      rows.splice(0, rows.length, ...rows.filter((row) => ["a", "ca"].includes(row.id)));
      order = ["a", "ca"];
      await rendered.behavior.emitRealtime("lifecycle", {});
      await rendered.behavior.emitRealtime("inbox-order", {});
      await waitFor(() => expect(visible()).toEqual(["a"]));
      fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 1 });
      await act(async () => {});
      expect(rendered.rpcCalls.filter((call) => call.method === "reorderInbox")).toEqual([]);
      expect(order).toEqual(["a", "ca"]);
      expect(active.querySelector("[data-drag-preview]")).toBeNull();
    });

    function renderProjects(onReorder: (ids: string[]) => void) {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      const storedIds = ["w1", "x", "w2", "y"];
      return renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "w1", projectId: "web", title: "Web one" }),
            thread({ id: "x", projectId: "api", title: "Loose X" }),
            thread({ id: "w2", projectId: "web", title: "Web two" }),
            thread({ id: "y", projectId: "zed", title: "Loose Y" }),
          ],
          projects: [
            { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
            { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
            { id: "zed", name: "Zed", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: storedIds }),
          reorderInbox: (input) => {
            const parsed = input as { inboxThreadIds: string[] };
            onReorder(parsed.inboxThreadIds);
            return { inboxThreadIds: parsed.inboxThreadIds };
          },
        },
      });
    }

    it("drags a project header past a lone thread, taking its threads along", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const header = await screen.findByRole("button", { name: "Web (2)" });
      const target = screen.getByText("Loose Y").closest("li")!;
      vi.mocked(document.elementFromPoint).mockReturnValue(target);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        top: 0, bottom: 40, left: 0, right: 200, width: 200, height: 40, x: 0, y: 0,
        toJSON: () => ({}),
      });

      fireEvent.pointerDown(header, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });

      await waitFor(() => expect(saved).toEqual(["x", "y", "w1", "w2"]));
      // The drag must not also toggle the project it started on.
      expect(header.getAttribute("aria-expanded")).toBe("true");
    });

    it("moves a lone thread over a whole project from the keyboard", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const card = await screen.findByRole("link", { name: "Loose X" });
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      await waitFor(() => expect(saved).toEqual(["x", "w1", "w2", "y"]));
    });

    it("moves a project header from the keyboard", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const header = await screen.findByRole("button", { name: "Web (2)" });
      fireEvent.keyDown(header, { key: "ArrowDown", altKey: true });
      await waitFor(() => expect(saved).toEqual(["x", "w1", "w2", "y"]));
    });

    it("reorders inside a project without moving the project", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const card = await screen.findByRole("link", { name: "Web two" });
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      // The project's threads swap within the slots they already held.
      await waitFor(() => expect(saved).toEqual(["w2", "x", "w1", "y"]));
    });
  });

  it("drops against the inbox order the host pushed mid-drag", async () => {
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
      settings: {
        inactiveThreadsEnabled: true,
        inactiveAfterHours: "6",
      },
      rpc: {
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
    await waitFor(() =>
      expect(reorderInput).toEqual({ inboxThreadIds: ["z", "b", "a"] }),
    );
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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

  it.each(["Active", "Inactive"])(
    "keeps %s order on remount while the saved order reloads",
    async (shelf) => {
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
      const titles = () => within(screen.getByRole("region", { name: shelf }))
        .getAllByRole("listitem").map((item) => item.textContent);
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
    },
  );

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
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
        "Inbox B",
      ),
    );

    await act(async () => staleRead.resolve({ inboxThreadIds: ["a", "b"] }));
    expect(JSON.parse(localStorage.getItem("bb-sidebar:inbox-order-cache:v1")!)).toEqual(["b", "a"]);
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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

  it.each(["Active", "Settled", "Snoozed", "Parked"])(
    "pins a thread from %s through the lifecycle RPC",
    async (shelf) => {
      const now = Date.now();
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "to-pin", title: "Pin this thread" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: shelf === "Active" ? [] : [{
            threadId: "to-pin",
            parkedAt: shelf === "Parked" ? now : null,
            settledAt: shelf === "Settled" ? now : null,
            settledOverride: shelf === "Settled" ? "settled" : null,
            snoozedUntil: shelf === "Snoozed" ? now + 60_000 : null,
            snoozedAt: shelf === "Snoozed" ? now : null,
          }] }),
          pin: () => ({ ok: true }),
        },
      });
      const section = await screen.findByRole("region", { name: shelf });
      if (shelf !== "Active") {
        fireEvent.click(within(section).getByRole("button", { expanded: false }));
      }
      fireEvent.contextMenu(within(section).getByText("Pin this thread"));
      fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" }))
        .getByRole("menuitem", { name: "Pin" }));

      await waitFor(() => expect(rendered.rpcCalls).toContainEqual({
        method: "pin", input: { threadId: "to-pin" },
      }));
      expect(rendered.sidebarActionCalls.filter(call => call.method === "setPinned")).toEqual([]);
    },
  );

  it("reports a failed pin and keeps the thread on its shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "to-pin", title: "Still settled" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [{
          threadId: "to-pin", settledAt: Date.now(), settledOverride: "settled",
          snoozedUntil: null, snoozedAt: null,
        }] }),
        pin: () => { throw new Error("pin update failed"); },
      },
    });
    const section = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(section).getByRole("button", { expanded: false }));
    fireEvent.contextMenu(within(section).getByText("Still settled"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" }))
      .getByRole("menuitem", { name: "Pin" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("Could not pin thread", {
      description: "pin update failed",
    }));
    expect(within(section).getByText("Still settled")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  });

  it("keeps explicit shelf changes visible while the host's pin flag is stale", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "auto", title: "Pinned auto", isPinned: true }),
          thread({ id: "manual", title: "Pinned manual", isPinned: true }),
          thread({ id: "snoozed", title: "Pinned snooze", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("Sidebar work")).toBeDefined();
  });

  it("includes matching child threads in search results", () => {
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "needle" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "child",
              title: "Needle child",
              parentThreadId: "parent",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const results = screen.getByRole("listbox", {
      name: "Thread search results",
    });
    expect(within(results).getByText("Needle child")).toBeDefined();
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
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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

  // A plain search row puts the title, the project and the status on one line.
  // A fixed 112px project column left the title about six characters at a
  // 280px sidebar, so the project yields first: the title is what was searched
  // for. The woke row keeps its own two-row grid instead.
  it("caps the project proportionally on a single-line search row", async () => {
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "match" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "plain", title: "Match plain" })],
          projects: [
            { id: "proj_1", name: "A very long project name", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
      },
    );

    const result = await screen.findByRole("option", { name: /Match plain/ });
    const project = within(result).getByText("A very long project name")
      .parentElement!;
    expect(project.className).toContain("max-w-[30%]");
    expect(project.className.split(" ")).not.toContain("max-w-28");
  });

  it("keeps Woke beside pending, failed, running, and idle states in search", async () => {
    const acknowledged: string[] = [];
    let navigated = 0;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ search_runtime: now - 5 * 60_000 }),
    );
    const threads = [
      thread({
        id: "search_pending",
        title: "Match pending",
        indicator: "waiting-for-input",
        hasPendingInteraction: true,
      }),
      thread({
        id: "search_failed",
        title: "Match failed",
        indicator: "unread-error",
      }),
      thread({
        id: "search_runtime",
        title: "Match runtime",
        indicator: "runtime",
      }),
      thread({
        id: "search_idle",
        title: "Match idle",
        updatedAt: now - 31 * 60_000,
      }),
    ];

    const rendered = renderSlot(
      inbox,
      {
        ...listProps,
        searchQuery: "match",
        onNavigate: () => (navigated += 1),
      },
      {
        sidebarThreads: {
          status: "ready",
          threads,
          projects: [{ id: "proj_1", name: "A very long project name", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: threads.map((candidate) => ({
              threadId: candidate.id,
              settledAt: null,
              snoozedUntil:
                candidate.id === "search_pending" ? now + 60_000 : now - 1,
              snoozedAt: now - 60_000,
            })),
          }),
          acknowledgeWake: (input) => {
            acknowledged.push((input as { threadId: string }).threadId);
            return { ok: true };
          },
        },
      },
    );

    const expected = [
      ["Match pending", "Needs you"],
      ["Match failed", "Failed"],
      ["Match runtime", "Working · 5m"],
      ["Match idle", "31m"],
    ] as const;
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    for (const [title, status] of expected) {
      const result = screen.getByRole("option", { name: new RegExp(title) });
      expect(within(result).getByText("Woke")).toBeDefined();
      expect(within(result).getByText(status)).toBeDefined();
      expect(within(result).queryByRole("button")).toBeNull();
    }

    fireEvent.click(screen.getByRole("option", { name: /Match runtime/ }));
    await waitFor(() => expect(acknowledged).toEqual(["search_runtime"]));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "search_runtime",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  // The woke row is a two-row grid instead of a flex line, so the roving
  // listbox has to keep working across a mix of the two shapes.
  it("moves through woke and plain search results with the keyboard", async () => {
    const acknowledged: string[] = [];
    let navigated = 0;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const rendered = renderSlot(
      inbox,
      {
        ...listProps,
        searchQuery: "match",
        onNavigate: () => (navigated += 1),
      },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({
              id: "woke_match",
              title: "Woke match",
              indicator: "unread-error",
              indicatorLabel: "Unread thread failed",
              updatedAt: now,
            }),
            thread({
              id: "plain_match",
              title: "Plain match",
              updatedAt: now - 31 * 60_000,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [
              {
                threadId: "woke_match",
                settledAt: null,
                snoozedUntil: now - 1,
                snoozedAt: now - 60_000,
              },
            ],
          }),
          acknowledgeWake: (input) => {
            acknowledged.push((input as { threadId: string }).threadId);
            return { ok: true };
          },
        },
      },
    );

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const options = screen.getAllByRole("option");
    const woke = options.find(
      (option) => within(option).queryByText("Woke") !== null,
    )!;
    const plain = options.find((option) => option !== woke)!;
    // Woke, the real status, and the project all keep their place on the row.
    expect(within(woke).getByText("Failed")).toBeDefined();
    expect(within(woke).getByText("bb")).toBeDefined();
    expect(within(plain).getByText("31m")).toBeDefined();
    expect(within(plain).queryByText("Woke")).toBeNull();
    // Woke is text in search, not a control: an option must not nest one.
    expect(within(woke).queryByRole("button")).toBeNull();
    expect(nestedInteractiveControls(woke)).toEqual([]);

    const next = options[(options.indexOf(woke) + 1) % options.length]!;
    woke.focus();
    fireEvent.keyDown(woke, { key: "ArrowDown" });
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "ArrowUp" });
    expect(document.activeElement).toBe(woke);
    expect(woke.tabIndex).toBe(0);
    expect(plain.tabIndex).toBe(-1);

    fireEvent.keyDown(woke, { key: "Enter" });
    await waitFor(() => expect(acknowledged).toEqual(["woke_match"]));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "woke_match",
      options: { split: false },
    });
    expect(navigated).toBe(1);
  });

  // The woke grid moves the project name to its own row. Without a project
  // there is nothing to move, and the accessible name stays the bare title.
  it("keeps Woke and the status on a search result with no project", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "match" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({
              id: "orphan_match",
              title: "Orphan match",
              projectId: "proj_unknown",
              indicator: "unread-success",
              indicatorLabel: "Unread thread succeeded",
              updatedAt: now,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [
              {
                threadId: "orphan_match",
                settledAt: null,
                snoozedUntil: now - 1,
                snoozedAt: now - 60_000,
              },
            ],
          }),
        },
      },
    );

    const result = await screen.findByRole("option", { name: "Orphan match" });
    expect(within(result).getByText("Woke")).toBeDefined();
    expect(within(result).getByText("Unread")).toBeDefined();
  });

  // The slot renders one status, and a raised hand outranks the runtime bb
  // still reports for the same thread.
  it("prefers a pending question to a running indicator in search results", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ asking_match: now - 5 * 60_000 }),
    );
    renderSlot(
      inbox,
      { ...listProps, searchQuery: "match" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({
              id: "asking_match",
              title: "Asking match",
              hasPendingInteraction: true,
              indicator: "runtime",
              indicatorLabel: "Agent is working",
              updatedAt: now,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const result = await screen.findByRole("option", { name: /Asking match/ });
    expect(within(result).getByText("Needs you")).toBeDefined();
    expect(within(result).queryByText(/^Working/)).toBeNull();
    // The runtime's own label must not outlive the status it was replaced by.
    expect(within(result).getByLabelText("Needs you")).toBeDefined();
    expect(within(result).queryByLabelText("Agent is working")).toBeNull();
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
            { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
            { id: "proj_2", name: "other", isPersonal: false, href: "", settingsHref: "" },
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

  it("filters the project scope card from its search row", async () => {
    renderSlot(
      inbox,
      listProps,
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Sidebar thread", projectId: "proj_1" }),
            thread({ id: "b", title: "Board thread", projectId: "proj_2" }),
          ],
          projects: [
            { id: "proj_1", name: "bb-sidebar", isPersonal: false, href: "", settingsHref: "" },
            { id: "proj_2", name: "kanban", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    // The card opens with the caret already in the search row.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Filter projects"),
      ),
    );
    const projectList = screen.getByRole("listbox", { name: "Projects" });
    expect(within(projectList).getAllByRole("option")).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("Filter projects"), {
      target: { value: "KAN" },
    });
    expect(
      within(projectList)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["kanban"]);

    // Enter takes the highlighted row, which filtering moved to the top.
    fireEvent.keyDown(screen.getByLabelText("Filter projects"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/Project scope: kanban/)).toBeDefined(),
    );
    expect(screen.getByText("Board thread")).toBeDefined();
    expect(screen.queryByText("Sidebar thread")).toBeNull();
  });

  it("says so when no project matches the scope search", () => {
    render([thread({ title: "Sidebar thread" })]);

    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Filter projects"), {
      target: { value: "nope" },
    });
    expect(
      within(screen.getByRole("listbox", { name: "Projects" })).queryAllByRole(
        "option",
      ),
    ).toHaveLength(0);
    expect(screen.getByText("No projects found")).toBeDefined();
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
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
        { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
        { id: "proj_2", name: "other", isPersonal: false, href: "", settingsHref: "" },
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

  it("invites a break when there are no active threads", () => {
    const view = render([]);
    expect(
      screen.getByText("All clear. Time to touch some grass."),
    ).toBeDefined();
    expect(view.container.querySelector("svg")).not.toBeNull();
  });

  it("shows a working scene when every thread is working", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "busy", title: "Busy work", indicator: "runtime" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          inactiveThreadsEnabled: false,
          workingShelf: true,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const lines: readonly string[] = WORKING_EMPTY_LINES;
    expect(await screen.findByText((text) => lines.includes(text))).toBeDefined();
    expect(screen.queryByText("All clear. Time to touch some grass.")).toBeNull();
  });
});

describe("parking threads", () => {
  it("previews every Settled row and cleans only after confirmation", async () => {
    const settledThreads = Array.from({ length: 11 }, (_, index) =>
      thread({ id: `thr_${index}`, title: `Finished ${index}` }),
    );
    const previewSettledCleanup = vi.fn((input: unknown) => ({
      token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
      threads: (input as { threadIds: string[] }).threadIds.slice(0, 2).map((threadId, index) => ({
        threadId, title: threadId, terminalCount: index === 0 ? 1 : 0, ports: index === 1 ? [3000] : [],
      })),
      skipped: [],
    }));
    const cleanSettled = vi.fn(() => ({
      closedTerminals: 1,
      signalledPorts: [{ threadId: "thr_1", port: 3000 }],
      remainingPorts: [],
      skipped: [],
      failed: [],
    }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: settledThreads,
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: settledThreads.map((item) => ({
          threadId: item.id, settledAt: 200, snoozedUntil: null, snoozedAt: null,
        })) }),
        previewSettledCleanup,
        cleanSettled,
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    await waitFor(() => expect(previewSettledCleanup).toHaveBeenCalledTimes(1));
    expect(new Set((previewSettledCleanup.mock.calls[0]![0] as { threadIds: string[] }).threadIds)).toEqual(new Set(settledThreads.map((item) => item.id)));
    expect(dialog.textContent).toContain("1 terminal to close · 1 listening port to stop");
    expect(dialog.textContent).not.toContain("0 terminals");
    expect(dialog.textContent).not.toContain("session");
    expect(within(dialog).queryByText("thr_2")).toBeNull();
    expect(cleanSettled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clean resources" }));
    await waitFor(() => expect(cleanSettled).toHaveBeenCalledWith({ token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55" }));
    expect(dialog.textContent).toContain("1 terminal closed · 1 port shutdown request sent");
  });

  it("marks each project's rows with that project's own soft colour", async () => {
    const settled = [
      thread({ id: "thr_a", title: "In bb" }),
      thread({ id: "thr_b", title: "Also bb" }),
      thread({ id: "thr_c", title: "In Git-Local", projectId: "proj_2" }),
    ];
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: settled,
        projects: [
          { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
          { id: "proj_2", name: "Git-Local", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, projectColorsEnabled: true }),
        getProjectColors: () => ({ colors: {} }),
        listLifecycle: () => ({ rows: settled.map((item) => ({
          threadId: item.id, settledAt: 200, snoozedUntil: null, snoozedAt: null,
        })) }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: /Settled/ }));
    const stripeOf = async (title: string) =>
      (await within(shelf).findByText(title)).closest("li")!.querySelector("[data-project-stripe]")!.getAttribute("style");
    const colors = projectColorsById(["proj_1", "proj_2"], {});
    expect(colors.get("proj_1")).not.toBe(colors.get("proj_2"));
    expect(await stripeOf("In bb")).toContain(colors.get("proj_1")!);
    expect(await stripeOf("Also bb")).toContain(colors.get("proj_1")!);
    expect(await stripeOf("In Git-Local")).toContain(colors.get("proj_2")!);
    const name = within((await within(shelf).findByText("In Git-Local")).closest("li")!).getByText("Git-Local");
    expect(name.className).toContain("bb-sidebar-project-name");
    expect(name.style.getPropertyValue("--bb-sidebar-project")).toBe(colors.get("proj_2"));
  });

  it("shows an empty preview without a Clean confirmation button", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_empty", title: "Finished" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [{ threadId: "thr_empty", settledAt: 200, snoozedUntil: null, snoozedAt: null }] }),
        previewSettledCleanup: () => ({ token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55", threads: [], skipped: [] }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    await waitFor(() => expect(dialog.textContent).toContain("No live terminals or thread-owned listening ports found."));
    expect(within(dialog).queryByRole("button", { name: "Clean resources" })).toBeNull();
  });

  it("opens a thread from the Clean preview and closes the dialog", async () => {
    const onNavigate = vi.fn();
    const rendered = renderSlot(inbox, { ...listProps, onNavigate }, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_terminal", title: "Check this terminal" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [{ threadId: "thr_terminal", settledAt: 200, snoozedUntil: null, snoozedAt: null }] }),
        previewSettledCleanup: () => ({
          token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
          threads: [{ threadId: "thr_terminal", title: "Check this terminal", terminalCount: 1, ports: [] }],
          skipped: [],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Open thread: Check this terminal" }));
    expect(rendered.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thr_terminal" });
    expect(onNavigate).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clean settled resources?" })).toBeNull());
  });

  it("keeps the Clean preview open while cleanup is running", async () => {
    const pending = deferred<{ closedTerminals: number; signalledPorts: never[]; remainingPorts: never[]; skipped: never[]; failed: never[] }>();
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_terminal", title: "Check this terminal" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [{ threadId: "thr_terminal", settledAt: 200, snoozedUntil: null, snoozedAt: null }] }),
        previewSettledCleanup: () => ({
          token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
          threads: [{ threadId: "thr_terminal", title: "Check this terminal", terminalCount: 1, ports: [] }],
          skipped: [],
        }),
        cleanSettled: () => pending.promise,
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    const cleanButton = await within(dialog).findByRole("button", { name: "Clean resources" });
    fireEvent.click(cleanButton);
    const openButton = within(dialog).getByRole("button", { name: "Open thread: Check this terminal" });
    expect(openButton).toHaveProperty("disabled", true);
    fireEvent.click(openButton);
    expect(rendered.sidebarActionCalls).not.toContainEqual({ method: "open", threadId: "thr_terminal" });
    expect(screen.getByRole("dialog", { name: "Clean settled resources?" })).toBeDefined();
    pending.resolve({ closedTerminals: 1, signalledPorts: [], remainingPorts: [], skipped: [], failed: [] });
    await waitFor(() => expect(dialog.textContent).toContain("1 terminal closed"));
  });

  it("keeps cleanup failures visible after the last thread leaves Settled", async () => {
    const pending = deferred<never>();
    let settled = true;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_terminal", title: "Last settled thread" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: settled ? [{ threadId: "thr_terminal", settledAt: 200, snoozedUntil: null, snoozedAt: null }] : [] }),
        previewSettledCleanup: () => ({
          token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
          threads: [{ threadId: "thr_terminal", title: "Last settled thread", terminalCount: 1, ports: [] }],
          skipped: [],
        }),
        cleanSettled: () => pending.promise,
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Clean resources" }));
    await within(dialog).findByRole("button", { name: "Cleaning..." });

    settled = false;
    await rendered.emitRealtime("lifecycle", {});
    await waitFor(() => expect(shelf.hidden).toBe(true));
    expect(screen.getByRole("dialog", { name: "Clean settled resources?" })).toBe(dialog);

    await act(async () => pending.reject(new Error("Cleanup connection lost")));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Cleanup connection lost");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
  });

  it("moves a settled thread to the Settled shelf", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_done", title: "Finished work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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

  it.each([
    ["an unread thread whose turn is still running", { status: "active" as const, indicator: "unread-success" as const }],
    ["a message waiting to send", { queuedWork: "waiting" as const }],
    ["a message that failed to send", { queuedWork: "failed" as const }],
  ])("keeps %s out of the shelves and offers no park action", async (_, overrides) => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_busy", title: "Not done", ...overrides })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
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
    expect(await screen.findByText("Not done")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
    expect(screen.queryByLabelText("Settle thread")).toBeNull();
  });

  it("offers Park thread below the snooze times and allows parking again after Undo", async () => {
    const park = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
    const resume = vi.fn(() => ({ ok: true }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), park, resume },
    });
    // Rendered (not merely accepted as props): a card whose park controls
    // never mount leaves the whole feature unreachable.
    expect(await screen.findByLabelText("Settle thread")).toBeDefined();
    const snooze = screen.getByRole("combobox", { name: "Snooze thread" });
    expect(
      snooze.querySelector('[data-icon="Clock"]'),
    ).not.toBeNull();
    expect(snooze.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
    expect(snooze.classList.contains("[&>svg:last-child]:hidden")).toBe(true);
    expect(snooze.classList.contains("w-5")).toBe(true);
    fireEvent.keyDown(snooze, { key: "Enter" });
    expect(
      await screen.findByRole("option", { name: "1 hour" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: "Wait refresh (5 hours)" })).toBeDefined();
    expect(screen.getByRole("option", { name: "This evening" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Next week" })).toBeDefined();
    const menu = screen.getByRole("listbox");
    const parkOption = within(menu).getByRole("option", { name: "Park thread" });
    expect(within(menu).getAllByRole("option").at(-1)).toBe(parkOption);
    fireEvent.click(parkOption);
    await waitFor(() => expect(park).toHaveBeenCalledTimes(1));
    expect(rendered.rpcCalls).toContainEqual({ method: "park", input: { threadId: "thr_park" } });
    expect(rendered.rpcCalls.some(call => call.method === "snooze" || call.method === "settle")).toBe(false);

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
    const undo = toastMocks.success.mock.calls.find(([message]) => message === "Thread parked")![1].action;
    act(() => undo.onClick());
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Park thread" }));
    await waitFor(() => expect(park).toHaveBeenCalledTimes(2));
  });

  it("keeps status rows actionable through snooze, settle, and unpin controls", async () => {
    const snooze = vi.fn(() => ({ ok: true }));
    const settle = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_failed",
            title: "Failed work",
            indicator: "unread-error",
            indicatorLabel: "Failed",
            isPinned: true,
          }),
          thread({
            id: "thr_unread",
            title: "Unread work",
            indicator: "unread-success",
            indicatorLabel: "Unread",
          }),
          thread({
            id: "thr_idle",
            title: "Idle work",
            updatedAt: Date.now() - 2 * 60_000,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), snooze, settle },
    });

    expect(await screen.findByText("Failed")).toBeDefined();
    expect(screen.getByText("Unread")).toBeDefined();
    expect(screen.getByText(/^\d+m$/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Failed work" }));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "setPinned",
        threadId: "thr_failed",
        pinned: false,
      }),
    );

    const unreadRow = screen.getByText("Unread work").closest("li")!;
    fireEvent.click(
      within(unreadRow).getByRole("button", { name: "Settle thread" }),
    );
    await waitFor(() =>
      expect(settle).toHaveBeenCalledWith({ threadId: "thr_unread" }),
    );

    const idleRow = screen.getByText("Idle work").closest("li")!;
    fireEvent.keyDown(
      within(idleRow).getByRole("combobox", { name: "Snooze thread" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));
    await waitFor(() =>
      expect(snooze).toHaveBeenCalledWith({
        threadId: "thr_idle",
        snoozedUntil: expect.any(Number),
      }),
    );
  });

  it.each([false, true])(
    "folds working threads to one line only when the experiment is on (%s)",
    async (compactWorkingThreads) => {
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "busy", title: "Busy work", indicator: "runtime", indicatorLabel: "Working" }),
            thread({ id: "asking", title: "Asking work", indicator: "runtime", hasPendingInteraction: true }),
            thread({ id: "idle", title: "Idle work" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          // Fixture threads are old; keep them all in Active.
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            inactiveThreadsEnabled: false,
            compactWorkingThreads,
          }),
          listLifecycle: () => ({ rows: [] }),
        },
      });
      const card = (title: string) =>
        screen.getByRole("link", { name: title }).closest("[data-parent-card]")!;
      await screen.findByRole("link", { name: "Busy work" });

      await waitFor(() =>
        expect(card("Busy work").classList.contains("h-8")).toBe(compactWorkingThreads),
      );
      expect(card("Asking work").classList.contains("h-8")).toBe(false);
      expect(card("Idle work").classList.contains("h-8")).toBe(false);
      // The folded row keeps bb's spinner and the full label for screen readers.
      expect(card("Busy work").querySelector('[data-icon="Loading"]') !== null).toBe(
        compactWorkingThreads,
      );
      expect(within(card("Busy work") as HTMLElement).getByText("Working")).toBeDefined();
    },
  );

  it.each([false, true])(
    "keeps a compact row's working children folded until expanded (compact %s)",
    async (compactWorkingThreads) => {
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent work", indicator: "runtime" }),
            thread({ id: "child", parentThreadId: "parent", title: "Child work", indicator: "runtime" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            inactiveThreadsEnabled: false,
            showRunningChildrenWhenCollapsed: true,
            compactWorkingThreads,
          }),
          listLifecycle: () => ({ rows: [] }),
        },
      });
      await screen.findByRole("link", { name: "Parent work" });
      // The full card surfaces a working child; the one-line row does not.
      await waitFor(() =>
        expect(screen.queryByText("Child work") === null).toBe(compactWorkingThreads),
      );

      if (compactWorkingThreads) {
        fireEvent.click(screen.getByRole("button", { name: /1 child thread/ }));
        expect(await screen.findByText("Child work")).toBeDefined();
      }
    },
  );

  it("keeps a row compact until its children and agents are done", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "waiting-on-child", title: "Waiting on child" }),
          thread({ id: "child", parentThreadId: "waiting-on-child", title: "Child work", indicator: "runtime" }),
          thread({ id: "asking", title: "Asking parent", hasPendingInteraction: true }),
          thread({ id: "asking-child", parentThreadId: "asking", title: "Asking child", indicator: "runtime" }),
          thread({
            id: "agent",
            title: "Agent parent",
            activity: { workflows: 0, backgroundAgents: 1, backgroundCommands: 0, planMode: 0, goals: 0 },
          }),
          thread({ id: "done", title: "Done parent" }),
          thread({ id: "done-child", parentThreadId: "done", title: "Done child" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          inactiveThreadsEnabled: false,
          compactWorkingThreads: true,
        }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const isCompact = (title: string) =>
      screen
        .getByRole("link", { name: title })
        .closest("[data-parent-card]")!
        .classList.contains("h-8");
    await screen.findByRole("link", { name: "Waiting on child" });

    await waitFor(() => expect(isCompact("Waiting on child")).toBe(true));
    expect(isCompact("Agent parent")).toBe(true);
    // The parent's own question outranks its children's work.
    expect(isCompact("Asking parent")).toBe(false);
    expect(isCompact("Done parent")).toBe(false);
  });

  it("counts live descendants despite unread success and keeps requests for input in Active", () => {
    const parent = thread({ id: "parent" });
    const liveChild = thread({ id: "child", parentThreadId: "parent", indicator: "unread-success", status: "active" });
    expect(isWorkingTree(parent, [liveChild], new Map())).toBe(true);
    const askingParent = thread({ id: "asking", indicator: "waiting-for-input", activity: {
      workflows: 0, backgroundAgents: 1, backgroundCommands: 0, planMode: 0, goals: 0,
    } });
    expect(isWorkingTree(askingParent, [], new Map())).toBe(false);
  });

  it("keeps Unpin clickable on a parent compacted by child work", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Pinned parent", isPinned: true }),
          thread({ id: "child", parentThreadId: "parent", indicator: "runtime" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, compactWorkingThreads: true }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
    const button = await screen.findByRole("button", { name: "Unpin Pinned parent" });
    expect(button.classList.contains("pointer-events-auto")).toBe(true);
  });

  it.each([true, false])(
    "moves threads with work running under them to a Working shelf (enabled %s)",
    async (workingShelf) => {
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "busy", title: "Busy work", indicator: "runtime" }),
            thread({ id: "waiting", title: "Waiting on child" }),
            thread({ id: "child", parentThreadId: "waiting", title: "Child work", indicator: "runtime" }),
            thread({ id: "asking", title: "Asking parent", hasPendingInteraction: true }),
            thread({ id: "asking-child", parentThreadId: "asking", title: "Asking child", indicator: "runtime" }),
            thread({ id: "done", title: "Done work", indicator: "unread-success", isUnread: true }),
            thread({ id: "pinned", title: "Pinned busy", indicator: "runtime", isPinned: true }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            inactiveThreadsEnabled: false,
            workingShelf,
          }),
          listLifecycle: () => ({ rows: [] }),
        },
      });
      await screen.findByRole("link", { name: "Busy work" });
      const titlesIn = (name: string) =>
        within(screen.getByRole("region", { name }))
          .getAllByRole("link")
          .map((link) => link.getAttribute("aria-label"));

      if (!workingShelf) {
        await waitFor(() => expect(titlesIn("Active")).toContain("Busy work"));
        expect(screen.queryByRole("region", { name: "Working" })).toBeNull();
        return;
      }
      await waitFor(() =>
        expect(titlesIn("Working")).toEqual(["Busy work", "Waiting on child"]),
      );
      // Done, or needing you, is Active's business; pinned stays pinned.
      expect(titlesIn("Active")).toEqual(["Asking parent", "Done work"]);
      expect(titlesIn("Pinned")).toEqual(["Pinned busy"]);
      // One line like the other shelves, even with compact mode off.
      for (const title of ["Busy work", "Waiting on child"]) {
        expect(
          screen
            .getByRole("link", { name: title })
            .closest("[data-parent-card]")!
            .classList.contains("h-8"),
        ).toBe(true);
      }
    },
  );

  it.each([true, false])(
    "docks the shelves after Active to the bottom when enabled (%s)",
    async (dockShelves) => {
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "open", title: "Open work" }),
            thread({ id: "done", title: "Settled work" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            inactiveThreadsEnabled: false,
            dockShelves,
          }),
          listLifecycle: () => ({ rows: [{
            threadId: "done", settledAt: Date.now(), settledOverride: "settled",
            snoozedUntil: null, snoozedAt: null,
          }] }),
        },
      });
      const settled = await screen.findByRole("region", { name: "Settled" });
      const active = screen.getByRole("region", { name: "Active" });
      await waitFor(() =>
        expect(settled.closest("[data-shelf-dock]") !== null).toBe(dockShelves),
      );
      // Active never moves into the dock; it scrolls in the space above.
      expect(active.closest("[data-shelf-dock]")).toBeNull();
    },
  );

  it("snoozes to a picked date and time from the snooze menu", async () => {
    const snooze = vi.fn(() => ({ ok: true }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pick", title: "Later work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }), snooze },
    });

    fireEvent.keyDown(
      await screen.findByRole("combobox", { name: "Snooze thread" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Pick date & time…" }));
    const dialog = await screen.findByRole("dialog", { name: "Snooze until" });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(within(dialog).getByText(/^Wakes /)).toBeDefined();

    const time = within(dialog).getByLabelText("Time");
    fireEvent.change(time, { target: { value: "" } });
    expect(within(dialog).getByText("Enter a time.")).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: "Snooze" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(time, { target: { value: "16:45" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
    await waitFor(() =>
      expect(snooze).toHaveBeenCalledWith({
        threadId: "thr_pick",
        snoozedUntil: new Date(
          tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 16, 45,
        ).getTime(),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // jsdom cannot evaluate `@media (hover: none)`, so the regression this
  // guards — a touch layout that faded the status out behind the park actions
  // — only shows in the class contract. The structural half is asserted too:
  // status and actions are rendered together, and neither is hidden.
  it("keeps the status beside the touch park actions instead of fading it out", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const parkable = [
      ["Touch failed", "unread-error", "Failed"],
      ["Touch unread", "unread-success", "Unread"],
      // A question bb reports without a pending interaction is still parkable.
      ["Touch asked", "waiting-for-input", "Needs you"],
      ["Touch idle", "none", "4m"],
    ] as const;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: parkable.map(([title, indicator]) =>
          thread({
            id: title,
            title,
            indicator,
            updatedAt: minute - 4 * 60_000,
          }),
        ),
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    await screen.findByText("Touch failed");
    for (const [title, , statusText] of parkable) {
      const row = screen.getByText(title).closest("li")!;
      // The actions the touch layout has to sit beside, not on top of.
      expect(
        within(row).getByRole("combobox", { name: "Snooze thread" }),
      ).toBeDefined();
      expect(
        within(row).getByRole("button", { name: "Settle thread" }),
      ).toBeDefined();
      // The card's anchor is a sibling of the controls, not their ancestor.
      expect(nestedInteractiveControls(row)).toEqual([]);

      const { status, statusWrapper, slot, actions } = statusSlotParts(
        row,
        statusText,
      );
      expect(actions).not.toBe(statusWrapper);
      expect(status.getAttribute("aria-hidden")).toBeNull();
      expect(status.hasAttribute("hidden")).toBe(false);
      expect(statusWrapper.getAttribute("aria-hidden")).toBeNull();
      // Touch: both spans return to the flow at full opacity, and the slot
      // widens so they sit side by side instead of stacked.
      for (const className of [
        "[@media(hover:none)]:static",
        "[@media(hover:none)]:opacity-100",
      ]) {
        expect(statusWrapper.className).toContain(className);
        expect(actions.className).toContain(className);
      }
      expect(slot.className).toContain("[@media(hover:none)]:w-auto");
      expect(slot.className).toContain("[@media(hover:none)]:gap-1.5");
      expect(statusWrapper.className).not.toContain(
        "[@media(hover:none)]:opacity-0",
      );
      // A hover device still trades the status for the actions.
      expect(statusWrapper.className).toContain(
        "[@media(hover:hover)]:group-hover/card:opacity-0",
      );
    }
  });

  // Opening the snooze menu pins the actions open on a hover device by hiding
  // the status. On touch the two already share the row, so the status stays.
  it("keeps the touch status visible while the snooze menu is open", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_open", title: "Menu open", indicator: "unread-error" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const row = (await screen.findByText("Menu open")).closest("li")!;
    fireEvent.keyDown(
      within(row).getByRole("combobox", { name: "Snooze thread" }),
      { key: "Enter" },
    );
    await screen.findByRole("option", { name: "1 hour" });

    const { statusWrapper } = statusSlotParts(row, "Failed");
    expect(within(row).getByText("Failed")).toBeDefined();
    expect(statusWrapper.className).toContain("opacity-0");
    expect(statusWrapper.className).toContain(
      "[@media(hover:none)]:opacity-100",
    );
  });

  // A working or blocked thread cannot be parked, so it has no actions to
  // share the slot with — but it must still show its status on touch.
  it("keeps the status on rows that offer no park actions", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_working: now - 5 * 60_000 }),
    );
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_working",
            title: "Still working",
            indicator: "runtime",
            indicatorLabel: "Agent is working",
            updatedAt: now,
          }),
          thread({
            id: "thr_pending",
            title: "Still asking",
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
            updatedAt: now,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    await screen.findByText("Still working");
    for (const [title, statusText] of [
      ["Still working", "Working · 5m"],
      ["Still asking", "Needs you"],
    ] as const) {
      const row = screen.getByText(title).closest("li")!;
      expect(
        within(row).queryByRole("combobox", { name: "Snooze thread" }),
      ).toBeNull();
      expect(
        within(row).queryByRole("button", { name: "Settle thread" }),
      ).toBeNull();
      const { status, statusWrapper, slot } = statusSlotParts(row, statusText);
      expect(status.getAttribute("aria-hidden")).toBeNull();
      expect(statusWrapper.className).not.toContain("opacity-0");
      // Intrinsic width with a floor: nothing is layered over the status.
      expect(slot.className).toContain("w-auto");
      expect(slot.className).toContain("min-w-20");
    }
  });

  it("settles a thread when the user clicks Settle", async () => {
    let settled: string | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_park", title: "Quiet" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: (input) => {
          settled = (input as { threadId: string }).threadId;
          return { ok: true, reclaim: SETTLED_NOTHING };
        },
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() => expect(settled).toBe("thr_park"));
  });

  it("plays the settle sweep before settling, unless motion is reduced", async () => {
    for (const reduced of [false, true]) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: reduced && query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      let settled: string | null = null;
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_park", title: "Quiet" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: (input) => {
            settled = (input as { threadId: string }).threadId;
            return { ok: true, reclaim: SETTLED_NOTHING };
          },
        },
      });
      const button = await screen.findByLabelText("Settle thread");
      fireEvent.click(button);
      const card = button.closest("[data-parent-card]")!;
      if (reduced) {
        expect(card.hasAttribute("data-settling")).toBe(false);
      } else {
        expect(card.hasAttribute("data-settling")).toBe(true);
        expect(card.querySelector(".bb-sidebar-settle-sweep")).not.toBeNull();
        // A second click while the sweep plays is not a second settle.
        fireEvent.click(button);
        expect(settled).toBeNull();
      }
      await waitFor(() => expect(settled).toBe("thr_park"));
      rendered.unmount();
    }
  });

  // A raised hand outranks a reported runtime in the slot, and it also
  // outranks any stored shelf: the row stays on Active with no park controls.
  it("prefers a pending question to a running indicator on a parent card", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_ask: now - 5 * 60_000 }),
    );
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_ask",
            title: "Asking while working",
            hasPendingInteraction: true,
            indicator: "runtime",
            indicatorLabel: "Agent is working",
            updatedAt: now,
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      // Settled in the store, but a raised hand brings it straight back.
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_ask",
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    const active = screen.getByRole("region", { name: "Active" });
    const row = (
      await within(active).findByText("Asking while working")
    ).closest("li")!;
    expect(within(row).getByText("Needs you")).toBeDefined();
    expect(within(row).queryByText(/^Working/)).toBeNull();
    expect(within(row).getByLabelText("Needs you")).toBeDefined();
    expect(within(row).queryByLabelText("Agent is working")).toBeNull();
    expect(screen.queryByRole("region", { name: "Settled" })).toBeNull();
  });

  // Parked rows share the status vocabulary: a settled thread that failed
  // says so rather than falling back to its age.
  it("shows a settled row's status instead of its age", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({
            id: "thr_settled",
            title: "Settled failure",
            indicator: "unread-error",
            indicatorLabel: "Unread thread failed",
            updatedAt: now - (3 * 3_600_000 + 60_000),
            createdAt: now - (3 * 3_600_000 + 60_000),
            latestAttentionAt: now - (3 * 3_600_000 + 60_000),
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "thr_settled",
              settledAt: now,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    const row = within(shelf).getByText("Settled failure").closest("li")!;
    expect(within(row).getByText("Failed").className).toContain(
      "text-[color:var(--bb-sidebar-tone-error)]",
    );
    expect(within(row).queryByText("3h")).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Un-settle thread" }),
    ).toBeDefined();
  });

  it("keeps the last usable view when lifecycle refresh fails", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_available", title: "Still available" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => Promise.reject(new Error("backend reloading")),
      },
    });

    expect(screen.getByText("Still available")).toBeDefined();
    await waitFor(() => expect(screen.getByText("Still available")).toBeDefined());
  });

  it("shows the wake countdown on a snoozed row", async () => {
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snz", title: "Later" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
    expect(within(shelf).getByLabelText("bb · Later")).toBeDefined();
    expect(within(shelf).getByText("bb").className).toContain(
      "text-muted-foreground/50",
    );
    expect(within(shelf).getByText("·").className).toContain("text-sm");
    expect(within(shelf).getByText("Later").className).toContain(
      "text-foreground/80",
    );
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
          thread({ id: "thr_active", title: "Active work", updatedAt: now }),
          thread({
            id: "thr_inactive",
            title: "Inactive work",
            updatedAt: now - 7 * 60 * 60 * 1_000,
          }),
          thread({ id: "thr_done", title: "Finished work" }),
          thread({ id: "thr_later", title: "Later work" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      settings: {
        inactiveThreadsEnabled: true,
        inactiveAfterHours: "6",
      },
      rpc: { listLifecycle: () => ({ rows }) },
    };

    renderSlot(inbox, listProps, options);
    let activeShelf = screen.getByRole("region", { name: "Active" });
    let inactiveShelf = screen.getByRole("region", { name: "Inactive" });
    let settledShelf = await screen.findByRole("region", { name: "Settled" });
    let snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(
      within(activeShelf).getByRole("button", { expanded: true }),
    );
    fireEvent.click(within(inactiveShelf).getByRole("button"));
    fireEvent.click(within(settledShelf).getByRole("button", { expanded: false }));
    fireEvent.click(within(snoozedShelf).getByRole("button"));
    expect(within(activeShelf).queryByText("Active work")).toBeNull();
    expect(within(inactiveShelf).getByText("Inactive work")).toBeDefined();
    expect(within(settledShelf).getByText("Finished work")).toBeDefined();
    expect(within(snoozedShelf).getByText("Later work")).toBeDefined();

    cleanup();
    renderSlot(inbox, listProps, options);
    activeShelf = screen.getByRole("region", { name: "Active" });
    inactiveShelf = screen.getByRole("region", { name: "Inactive" });
    settledShelf = await screen.findByRole("region", { name: "Settled" });
    snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    expect(
      within(activeShelf).getByRole("button", { expanded: false }),
    ).toBeDefined();
    expect(
      within(inactiveShelf).getByRole("button", { expanded: true }),
    ).toBeDefined();
    expect(
      within(settledShelf).getByRole("button", { expanded: true }),
    ).toBeDefined();
    expect(
      within(snoozedShelf).getByRole("button", { expanded: true }),
    ).toBeDefined();
    expect(within(activeShelf).queryByText("Active work")).toBeNull();
    expect(within(inactiveShelf).getByText("Inactive work")).toBeDefined();
    expect(within(settledShelf).getByText("Finished work")).toBeDefined();
    expect(within(snoozedShelf).getByText("Later work")).toBeDefined();
  });

  it("does not flash inactive and parked threads as Active after an app restart", async () => {
    const now = Date.now();
    const pendingSettings = deferred<typeof defaultSidebarSettings>();
    const pendingLifecycle = deferred<{
      rows: Array<{
        threadId: string;
        settledAt: number;
        snoozedUntil: null;
        snoozedAt: null;
      }>;
    }>();
    const props = { ...listProps };
    const sidebarThreads = {
      status: "ready" as const,
      threads: [
        thread({
          id: "inactive",
          title: "Inactive work",
          updatedAt: now - 7 * 60 * 60 * 1_000,
        }),
        thread({ id: "settled", title: "Settled work" }),
      ],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    };
    renderSlot(inbox, props, {
      sidebarThreads,
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listLifecycle: () => ({
          rows: [
            {
              threadId: "settled",
              settledAt: now,
              snoozedUntil: null,
              snoozedAt: null,
            },
          ],
        }),
      },
    });

    await screen.findByRole("region", { name: "Inactive" });
    await screen.findByRole("region", { name: "Settled" });
    cleanup();

    renderSlot(inbox, props, {
      sidebarThreads,
      rpc: {
        getSidebarSettings: () => pendingSettings.promise,
        listLifecycle: () => pendingLifecycle.promise,
      },
    });

    const inactiveShelf = screen.getByRole("region", { name: "Inactive" });
    const settledShelf = screen.getByRole("region", { name: "Settled" });
    expect(
      within(inactiveShelf).getByRole("button", { expanded: false }),
    ).toBeDefined();
    expect(
      within(settledShelf).getByRole("button", { expanded: false }),
    ).toBeDefined();
    expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
    expect(screen.queryByText("Inactive work")).toBeNull();
    expect(screen.queryByText("Settled work")).toBeNull();
  });

  it("keeps the currently open parked row visible while collapsed", async () => {
    renderSlot(inbox, { ...listProps, activeThreadId: "thr_open" }, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_open", title: "Open but settled" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
    fireEvent.click(within(settledShelf).getByRole("button", { expanded: false }));
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 25 more" }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(35);
    fireEvent.click(within(shelf).getByRole("button", { name: "Load 1 more" }));
    expect(within(shelf).getAllByRole("listitem")).toHaveLength(36);
    expect(within(shelf).queryByText(/Load .* more/)).toBeNull();
  });

  it("keeps Woke beside the current card status and preserves its controls", async () => {
    const acknowledged: string[] = [];
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ runtime: now - 5 * 60_000 }),
    );
    const threads = [
      thread({
        id: "pending",
        title: "Pending wake",
        indicator: "waiting-for-input",
        hasPendingInteraction: true,
      }),
      thread({
        id: "failed",
        title: "Failed wake",
        indicator: "unread-error",
        isPinned: true,
      }),
      thread({ id: "runtime", title: "Runtime wake", indicator: "runtime" }),
      thread({
        id: "idle",
        title: "Idle wake",
        updatedAt: now - 31 * 60_000,
      }),
    ];
    let lifecycleRows = threads.map((candidate) => ({
      threadId: candidate.id,
      settledAt: null,
      snoozedUntil: candidate.id === "pending" ? now + 60_000 : now - 1,
      snoozedAt: now - 60_000,
    }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "A very long project name", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: lifecycleRows }),
        acknowledgeWake: (input) => {
          const threadId = (input as { threadId: string }).threadId;
          acknowledged.push(threadId);
          lifecycleRows = lifecycleRows.filter((row) => row.threadId !== threadId);
          return { ok: true };
        },
      },
    });

    const expected = [
      ["Pending wake", "Needs you"],
      ["Failed wake", "Failed"],
      ["Runtime wake", "Working · 5m"],
      ["Idle wake", "31m"],
    ] as const;
    for (const [title, status] of expected) {
      const row = (await screen.findByText(title)).closest("li")!;
      expect(within(row).getByRole("button", { name: "Dismiss Woke marker" })).toBeDefined();
      expect(within(row).getByText(status)).toBeDefined();
    }

    const pendingRow = screen.getByText("Pending wake").closest("li")!;
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Dismiss Woke marker" }));
    await waitFor(() => expect(acknowledged).toEqual(["pending"]));
    await rendered.emitRealtime("lifecycle", {});
    await waitFor(() =>
      expect(
        within(screen.getByText("Pending wake").closest("li")!).queryByRole(
          "button",
          { name: "Dismiss Woke marker" },
        ),
      ).toBeNull(),
    );
    expect(
      within(screen.getByText("Pending wake").closest("li")!).getByText(
        "Needs you",
      ),
    ).toBeDefined();
    expect(rendered.sidebarActionCalls.some((call) => call.method === "open")).toBe(false);

    const failedRow = screen.getByText("Failed wake").closest("li")!;
    fireEvent.click(within(failedRow).getByRole("button", { name: "Unpin Failed wake" }));
    await waitFor(() =>
      expect(rendered.sidebarActionCalls).toContainEqual({
        method: "setPinned",
        threadId: "failed",
        pinned: false,
      }),
    );
    expect(acknowledged).toEqual(["pending"]);
    expect(within(failedRow).getByText("Failed")).toBeDefined();

    fireEvent.click(within(failedRow).getByRole("link", { name: "Failed wake" }));
    await waitFor(() => expect(acknowledged).toEqual(["pending", "failed"]));
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "failed",
      options: { split: false },
    });
  });
  // Dismissing the marker is a correction, not navigation: the row stays put
  // with its real status, and nothing opens.
  it("dismisses the Woke marker without opening or navigating", async () => {
    const acknowledged: string[] = [];
    let navigated = 0;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    let lifecycleRows = [
      {
        threadId: "woke",
        settledAt: null,
        snoozedUntil: now - 1,
        snoozedAt: now - 60_000,
      },
    ];
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({
              id: "woke",
              title: "Woke work",
              indicator: "unread-error",
              indicatorLabel: "Unread thread failed",
              updatedAt: now,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: lifecycleRows }),
          acknowledgeWake: (input) => {
            acknowledged.push((input as { threadId: string }).threadId);
            lifecycleRows = [];
            return { ok: true };
          },
        },
      },
    );

    const row = (await screen.findByText("Woke work")).closest("li")!;
    const dismiss = within(row).getByRole("button", {
      name: "Dismiss Woke marker",
    });
    expect(within(row).getByText("Failed")).toBeDefined();
    // The card's navigation anchor is a sibling of the controls, never their
    // ancestor, so no control ends up inside another control.
    expect(dismiss.closest("a")).toBeNull();
    expect(nestedInteractiveControls(row)).toEqual([]);

    fireEvent.click(dismiss);
    await waitFor(() => expect(acknowledged).toEqual(["woke"]));
    expect(navigated).toBe(0);
    expect(rendered.sidebarActionCalls).toEqual([]);

    await rendered.emitRealtime("lifecycle", {});
    const settled = () => screen.getByText("Woke work").closest("li")!;
    await waitFor(() =>
      expect(
        within(settled()).queryByRole("button", {
          name: "Dismiss Woke marker",
        }),
      ).toBeNull(),
    );
    expect(within(settled()).getByText("Failed")).toBeDefined();
    expect(navigated).toBe(0);
  });

});

type ParkingAction = "settle" | "snooze" | "park";
const parkingActions: readonly ParkingAction[] = ["settle", "snooze", "park"];

async function parkFromCard(row: HTMLElement, action: ParkingAction) {
  if (action === "settle") {
    fireEvent.click(within(row).getByRole("button", { name: "Settle thread" }));
  } else {
    fireEvent.keyDown(within(row).getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", {
      name: action === "park" ? "Park thread" : "1 hour",
    }));
  }
}

async function parkFromMenu(row: HTMLElement, action: ParkingAction) {
  fireEvent.contextMenu(row);
  const menu = await screen.findByRole("menu", { name: "Thread actions" });
  if (action === "snooze") {
    fireEvent.click(within(menu).getByText("Snooze"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "1 hour" }));
  } else {
    fireEvent.click(within(menu).getByText(action === "park" ? "Park thread" : "Settle"));
  }
}

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
      "Parent",
      "Project",
      "Pin",
      "Snooze",
      "Park thread",
      "Settle",
      "Rename",
      "Regenerate title",
      "Mark unread",
      "Copy",
      "Archive",
      "Delete",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(4);
  });

  describe.each(parkingActions)("%s navigation", (action) => {
    it("updates another thread from the context menu without changing the open thread", async () => {
      let settled: string | null = null;
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "open" }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "thr_settle", title: "Settle from menu" }),
            thread({ id: "open", title: "Stay here" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          [action]: (input) => {
            settled = (input as { threadId: string }).threadId;
            return { ok: true, reclaim: SETTLED_NOTHING };
          },
        },
      });

      await parkFromMenu(await screen.findByText("Settle from menu"), action);
      await waitFor(() => expect(settled).toBe("thr_settle"));
      await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
      expect(rendered.sidebarActionCalls).toEqual([]);
    });

    it("opens the next Active thread when leaving its first row", async () => {
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
            projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      await parkFromMenu(await screen.findByText("Current"), action);
      await waitFor(() =>
        expect(rendered.sidebarActionCalls).toContainEqual({
          method: "open",
          threadId: "next",
        }),
      );
      expect(navigated).toBe(1);
    });

    it.each([
      ["manual", "manual", false],
      ["manual", "manual", true],
      ["created", "created", true],
      ["activity", "activity", true],
      // The first project unit always starts with the first manual thread.
      ["project", "manual", true],
    ] as const)("leaving a thread in %s order opens %s first with Active collapsed: %s", async (mode, expectedId, collapsed) => {
      localStorage.setItem("bb-sidebar:active-sort:v1", mode);
      const order = ["manual", "current", "created", "activity", "project"];
      localStorage.setItem("bb-sidebar:inbox-order-cache:v1", JSON.stringify(order));
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "current" }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "current", title: "Current", createdAt: 50, updatedAt: 50 }),
            thread({ id: "manual", title: "Manual first", createdAt: 20, updatedAt: 20 }),
            thread({ id: "created", title: "Newest first", createdAt: 100, updatedAt: 100 }),
            thread({ id: "activity", title: "Recent first", createdAt: 10, updatedAt: 200 }),
            thread({ id: "project", title: "Alpha first", projectId: "alpha", createdAt: 5 }),
          ],
          projects: [
            { id: "proj_1", name: "Zulu", isPersonal: false, href: "", settingsHref: "" },
            { id: "alpha", name: "Alpha", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
        },
      });

      const active = await screen.findByRole("region", { name: "Active" });
      if (collapsed) {
        fireEvent.click(
          within(active).getByRole("button", { name: "Active", expanded: true }),
        );
      }
      const current = within(active).getByText("Current").closest("li")!;
      await parkFromCard(current, action);
      await waitFor(() => expect(rendered.sidebarActionCalls).toContainEqual({
        method: "open", threadId: expectedId,
      }));
    });

    it.each([
      ["current", "first-pin"],
      ["first-pin", "second-pin"],
    ])("leaving %s selects %s before Active, using the full pinned order", async (currentId, expectedId) => {
      localStorage.setItem("bb-sidebar:active-sort:v1", "created");
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: currentId }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "first-pin", title: "First pin", isPinned: true, createdAt: 10 }),
            thread({ id: "second-pin", title: "Second pin", isPinned: true, createdAt: 100 }),
            thread({ id: "current", title: "Current", createdAt: 20 }),
            thread({ id: "active", title: "First active", createdAt: 200 }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
        },
      });

      const pinned = await screen.findByRole("region", { name: "Pinned" });
      fireEvent.click(within(pinned).getByRole("button", { expanded: true }));
      const current = screen.getByText(currentId === "current" ? "Current" : "First pin").closest("li")!;
      await parkFromCard(current, action);
      await waitFor(() => expect(rendered.sidebarActionCalls).toContainEqual({
        method: "open", threadId: expectedId,
      }));
    });

    it("selects the first Active thread when leaving the last Pinned thread", async () => {
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "pinned" }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "pinned", title: "Last pin", isPinned: true }),
            thread({ id: "first", title: "First active", createdAt: 20 }),
            thread({ id: "last", title: "Last active", createdAt: 10 }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
        },
      });

      const pinned = await screen.findByRole("region", { name: "Pinned" });
      await parkFromCard(within(pinned).getByText("Last pin").closest("li")!, action);
      await waitFor(() => expect(rendered.sidebarActionCalls).toContainEqual({
        method: "open", threadId: "first",
      }));
    });

    it.each([false, true])("opens a project-scoped composer when Pinned and Active are empty after the action, with the last thread pinned: %s", async (isPinned) => {
      const now = Date.now();
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "only" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "only", title: "Only thread", updatedAt: now, isPinned }),
              thread({ id: "inactive", title: "Inactive thread" }),
              thread({ id: "parked", title: "Parked thread" }),
              thread({ id: "snoozed", title: "Snoozed thread" }),
              thread({ id: "settled", title: "Settled thread" }),
            ],
            projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
          },
          settings: { inactiveThreadsEnabled: true, inactiveAfterHours: "6" },
          rpc: {
            listLifecycle: () => ({ rows: [
              { threadId: "parked", parkedAt: now, settledAt: null, snoozedUntil: null, snoozedAt: null },
              { threadId: "snoozed", settledAt: null, snoozedUntil: now + 60_000, snoozedAt: now },
              { threadId: "settled", settledAt: now, snoozedUntil: null, snoozedAt: null },
            ] }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      await screen.findByRole("region", { name: "Settled" });
      const current = screen.getByText("Only thread").closest("li")!;
      await parkFromCard(current, action);
      await waitFor(() =>
        expect(rendered.sidebarActionCalls).toContainEqual({
          method: "openNewThread",
          options: { projectId: "proj_1", focusPrompt: true },
        }),
      );
    });

    it("uses the remaining Active threads when the first one settles elsewhere during the request", async () => {
      const pendingSettle = deferred<{ ok: true; reclaim: typeof SETTLED_NOTHING }>();
      let firstSettled = false;
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "current" }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "first", title: "First active", createdAt: 30 }),
            thread({ id: "second", title: "Second active", createdAt: 20 }),
            thread({ id: "current", title: "Current", createdAt: 10 }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: firstSettled ? [
            { threadId: "first", settledAt: Date.now(), snoozedUntil: null, snoozedAt: null },
          ] : [] }),
          [action]: () => pendingSettle.promise,
        },
      });
      const current = (await screen.findByText("Current")).closest("li")!;
      await parkFromCard(current, action);
      await waitFor(() => expect(rendered.rpcCalls.some(call => call.method === action)).toBe(true));

      firstSettled = true;
      await rendered.emitRealtime("lifecycle", {});
      await waitFor(() => expect(
        within(screen.getByRole("region", { name: "Active" })).queryByText("First active"),
      ).toBeNull());
      pendingSettle.resolve({ ok: true, reclaim: SETTLED_NOTHING });
      await waitFor(() => expect(rendered.sidebarActionCalls).toContainEqual({
        method: "open", threadId: "second",
      }));
    });

  });

  describe.each([
    ["Parked", "settle"],
    ["Parked", "snooze"],
    ["Snoozed", "settle"],
    ["Snoozed", "park"],
    ["Settled", "snooze"],
    ["Settled", "park"],
  ] as const)("%s compact card: %s", (shelf, action) => {
    it.each(["pinned", "active", "empty"])("follows the same navigation with %s candidates", async (destination) => {
      const now = Date.now();
      const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "current" }, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "current", title: "Current" }),
            ...(destination === "pinned" ? [
              thread({ id: "first-pin", title: "First pin", isPinned: true }),
              thread({ id: "second-pin", title: "Second pin", isPinned: true }),
            ] : []),
            ...(destination !== "empty" ? [
              thread({ id: "first-active", title: "First active", updatedAt: now, createdAt: 200 }),
              thread({ id: "last-active", title: "Last active", updatedAt: now, createdAt: 100 }),
            ] : []),
            thread({ id: "inactive", title: "Inactive" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        settings: { inactiveThreadsEnabled: true, inactiveAfterHours: "6" },
        rpc: {
          listLifecycle: () => ({ rows: [{
            threadId: "current",
            parkedAt: shelf === "Parked" ? now : null,
            settledAt: shelf === "Settled" ? now : null,
            snoozedUntil: shelf === "Snoozed" ? now + 60_000 : null,
            snoozedAt: shelf === "Snoozed" ? now : null,
          }] }),
          [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
        },
      });

      const region = await screen.findByRole("region", { name: shelf });
      await parkFromMenu(within(region).getByText("Current"), action);
      await waitFor(() => expect(rendered.sidebarActionCalls).toEqual([
        destination === "empty"
          ? { method: "openNewThread", options: { projectId: "proj_1", focusPrompt: true } }
          : { method: "open", threadId: destination === "pinned" ? "first-pin" : "first-active" },
      ]));
    });
  });

  it("reminds the user what settling released and what it left running", async () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "only" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "only", title: "Only thread" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          settle: () => ({
            ok: true,
            reclaim: {
              closedTerminals: 1,
              keptTerminals: 2,
              stoppedRuntime: true,
            },
          }),
        },
      },
    );

    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread settled",
        expect.objectContaining({
          description:
            "Agent session stopped · closed 1 terminal nobody used · 2 terminals left running",
          duration: 10_000,
        }),
      ),
    );
  });

  it.each(parkingActions)("does not override navigation while %s is in flight", async (action) => {
    const pendingSettle =
      deferred<{ ok: true; reclaim: typeof SETTLED_NOTHING }>();
    const props = { ...listProps, activeThreadId: "slow" };
    const rendered = renderSlot(inbox, props, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "slow", title: "Slow settle", createdAt: 20 }),
          thread({ id: "elsewhere", title: "Elsewhere", createdAt: 10 }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        [action]: () => pendingSettle.promise,
      },
    });

    await parkFromMenu(await screen.findByText("Slow settle"), action);
    await waitFor(() =>
      expect(rendered.rpcCalls.filter((call) => call.method === action))
        .toHaveLength(1),
    );
    const InboxComponent = inbox.component;
    rendered.rerender(
      <InboxComponent {...props} activeThreadId="elsewhere" />,
    );
    pendingSettle.resolve({ ok: true, reclaim: SETTLED_NOTHING });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
    expect(
      rendered.sidebarActionCalls.filter(
        (call) => call.method === "open" || call.method === "openNewThread",
      ),
    ).toEqual([]);
  });

  it("appends the reclaim reminder after the snooze wake time", async () => {
    let wakeAt = 0;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "loud", title: "Loud snooze" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        snooze: (input) => {
          wakeAt = (input as { snoozedUntil: number }).snoozedUntil;
          return {
            ok: true,
            reclaim: {
              closedTerminals: 0,
              keptTerminals: 1,
              stoppedRuntime: true,
            },
          };
        },
      },
    });

    const snooze = await screen.findByRole("combobox", {
      name: "Snooze thread",
    });
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread snoozed",
        expect.objectContaining({
          description: `Wakes ${formatSnoozeWakeTime(wakeAt)} · Agent session stopped · 1 terminal left running`,
          duration: 10_000,
        }),
      ),
    );
  });

  it("deduplicates snooze, confirms the wake time, and supports Undo", async () => {
    const pendingSnooze =
      deferred<{ ok: true; reclaim: typeof SETTLED_NOTHING }>();
    let wakeAt = 0;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "dedupe", title: "Dedupe snooze" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
      await screen.findByRole("option", { name: "1 hour" }),
    );
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Wait refresh (5 hours)" }));
    await waitFor(() =>
      expect(rendered.rpcCalls.filter((call) => call.method === "snooze"))
        .toHaveLength(1),
    );

    pendingSnooze.resolve({ ok: true, reclaim: SETTLED_NOTHING });
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

  it("asks to close owned ports after settling, and only closes on confirmation", async () => {
    const ports = [{ port: 3000, pid: 123 }];
    const close = vi.fn(() => ({ signalled: [3000], skipped: [], failed: [] }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_ports", title: "Port owner" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
        getThreadPorts: () => ({ ports }),
        closeThreadPorts: close,
      },
    });
    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() => expect(toastMocks.message).toHaveBeenCalledWith("Close this thread's ports?", expect.anything()));
    expect(close).not.toHaveBeenCalled();
    const options = toastMocks.message.mock.calls.find(([message]) => message === "Close this thread's ports?")![1];
    await act(async () => options.action.onClick());
    expect(close).toHaveBeenCalledWith({ threadId: "thr_ports", ports });
  });

  it("ends snapshot Undo without offering an unrestricted tree redo", async () => {
    const undoToken = "cfb8bb71-7a2a-4d81-a3ab-c497bbd3a154";
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "round-trip", title: "Round trip" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        settle: () => ({ ok: true, reclaim: SETTLED_NOTHING, undoToken }),
        unsettle: () => ({ ok: true }),
      },
    });

    fireEvent.click(await screen.findByLabelText("Settle thread"));
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread settled",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Undo" }),
        }),
      ),
    );
    const settleToast = toastMocks.success.mock.calls.find(
      ([message]) => message === "Thread settled",
    )![1] as { action: { onClick: () => void } };
    settleToast.action.onClick();

    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "unsettle",
        input: { threadId: "round-trip", undoToken },
      }),
    );
    const unsettleToast = toastMocks.success.mock.calls.find(
      ([message]) => message === "Settling undone",
    )![1] as { action: { label: string; onClick: () => void } };
    expect(unsettleToast.action).toBeUndefined();
    expect(rendered.rpcCalls.filter((call) => call.method === "settle")).toHaveLength(1);
  });

  it("restores the original wake time when undoing an unsnooze", async () => {
    const wakeAt = Date.now() + 3_600_000;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "wake", title: "Wake round trip" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [
            {
              threadId: "wake",
              settledAt: null,
              snoozedUntil: wakeAt,
              snoozedAt: Date.now(),
            },
          ],
        }),
        unsnooze: () => ({ ok: true }),
        snooze: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
      },
    });

    const shelf = await screen.findByRole("region", { name: "Snoozed" });
    fireEvent.click(within(shelf).getByRole("button", { expanded: false }));
    fireEvent.click(within(shelf).getByLabelText("Wake thread now"));
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread woke up",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Undo" }),
        }),
      ),
    );
    const wakeToast = toastMocks.success.mock.calls.find(
      ([message]) => message === "Thread woke up",
    )![1] as { action: { onClick: () => void } };
    wakeToast.action.onClick();

    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "snooze",
        input: { threadId: "wake", snoozedUntil: wakeAt },
      }),
    );
  });

  it.each(parkingActions)("reports %s failures and leaves the active route alone", async (action) => {
    const rendered = renderSlot(
      inbox,
      { ...listProps, activeThreadId: "broken" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "broken", title: "Broken settle" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          [action]: () => {
            throw new Error("database offline");
          },
        },
      },
    );

    await parkFromCard((await screen.findByText("Broken settle")).closest("li")!, action);
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        `Could not ${action} thread`,
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
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
    fireEvent.click(within(settledShelf).getByRole("button", { expanded: false }));
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
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Thread title regenerated"));
    expect(screen.queryByRole("status", { name: "Generating title" })).toBeNull();
    expect(regenerateTitle).toHaveBeenCalledTimes(1);
  });

  it("shows regeneration errors and keeps the existing title", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads: [thread({ title: "Original title" })], projects: [] },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        regenerateTitle: () => { throw new Error("Title service unavailable"); },
      },
    });
    fireEvent.contextMenu(await screen.findByText("Original title"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate title" }));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("Could not regenerate title", {
      description: "Title service unavailable",
    }));
    expect(screen.getByText("Original title")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Generating title" })).toBeNull();
  });

  it("renames from the menu and saves with Enter", async () => {
    const rendered = render([
      thread({ id: "thr_rename", title: "Original title" }),
    ]);
    const row = await screen.findByRole("link", { name: "Original title" });
    act(() => row.focus());
    fireEvent.contextMenu(row);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Rename"));

    const input = await screen.findByRole("textbox", {
      name: "Rename Original title",
    });
    // Let the menu's deferred focus restoration finish before typing.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(document.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);
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
          workspaceDisplayKind: "managed-worktree", path: null, isWorktree: null, providerId: null
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

    copyMenu = await openCopyMenu();
    fireEvent.click(within(copyMenu).getByText("Copy thread link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/projects/proj_1/threads/thr_copy`,
    ));
  });

  it("copies personal thread links and reports clipboard failures", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render([thread({ id: "thr_personal", title: "Personal thread" })], [
      { id: "proj_1", name: "Personal", isPersonal: true, href: "", settingsHref: "" },
    ]);
    const copyLink = async () => {
      fireEvent.contextMenu(await screen.findByText("Personal thread"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
      fireEvent.click(await screen.findByText("Copy thread link"));
    };
    await copyLink();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/threads/thr_personal`,
    ));
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    await copyLink();
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith(
      "Failed to copy thread link",
    ));
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
    expect(rendered.sidebarActionCalls).not.toContainEqual(
      expect.objectContaining({ method: "requestDelete" }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete thread" }));
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "deleteThread",
        input: { threadId: "thr_del", childThreadsConfirmed: true },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete thread?" })).toBeNull(),
    );
  });

  it("cancelling the delete confirmation deletes nothing", async () => {
    const rendered = render([thread({ id: "thr_keep", title: "Keep me" })]);
    fireEvent.contextMenu(await screen.findByText("Keep me"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Delete"));
    const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete thread?" })).toBeNull(),
    );
    expect(rendered.rpcCalls.filter((call) => call.method === "deleteThread")).toEqual([]);
  });

  it("uses custom snooze times from plugin settings", async () => {
    let snoozed: { threadId: string; snoozedUntil: number } | null = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_snooze", title: "Snooze me" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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
      expect(within(menu).getAllByRole(role).slice(0, 5).map(item => item.textContent)).toEqual([
        "1 hour", "Wait refresh (5 hours)", "This evening", "Tomorrow morning", "Next week",
      ]);
      const evening = within(menu).getByRole(role, { name: "This evening" });
      expect(evening.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(evening);
      expect(snooze).not.toHaveBeenCalled();
      // An open menu must resolve against the date when the user selects it.
      vi.setSystemTime(new Date(2026, 0, 6, 0, 1));
      fireEvent.click(within(menu).getByRole(role, { name: "Tomorrow morning" }));
      await waitFor(() => expect(snooze).toHaveBeenCalledWith({
        threadId: "thr_calendar", snoozedUntil: new Date(2026, 0, 7, 9).getTime(),
      }));
    } finally {
      cleanup();
      vi.useRealTimers();
    }
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
          workspaceDisplayKind: "managed-worktree", path: null, isWorktree: null, providerId: null
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
          workspaceDisplayKind: "other", path: null, isWorktree: null, providerId: null
        },
      }),
    ]);
    expect(await screen.findByLabelText("Branch")).toBeDefined();
    expect(screen.queryByLabelText("Worktree branch")).toBeNull();
  });

  it.each([
    ["managed-worktree", "FolderGit", "Worktree branch"],
    ["unmanaged-worktree", "FolderGit", "Worktree branch"],
    ["other", "GitBranch", "Branch"],
  ] as const)("shows one branch line with matching icons for %s", async (workspaceDisplayKind, icon, branchLabel) => {
    render([
      thread({
        title: "Unnamed worktree thread",
        environment: {
          id: "env_worktree",
          name: null,
          branchName: "bb/feature",
          path: null,
          isWorktree: null,
          providerId: null,
          workspaceDisplayKind,
        },
      }),
    ]);

    expect(screen.getByLabelText(branchLabel).getAttribute("data-icon")).toBe(icon);
    act(() => screen.getByRole("link", { name: "Unnamed worktree thread" }).focus());
    const details = await screen.findByRole("dialog", { name: "Thread details" });
    const label = within(details).getByText(`${branchLabel}:`);
    expect(label.className).toContain("sr-only");
    expect(label.parentElement?.previousElementSibling?.getAttribute("data-icon")).toBe(icon);
    expect(within(details).getAllByText("bb/feature")).toHaveLength(1);
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

  it("shows the shared details card on the main thread without an icon tooltip", async () => {
    render([
      thread({
        id: "thr_details",
        title: "Thread metadata",
        providerId: "claude-code",
        host: { id: "host_1", name: "Build Mac" },
        environment: {
          id: "env_1",
          name: "Feature worktree",
          branchName: "bb/details",
          workspaceDisplayKind: "unmanaged-worktree", path: null, isWorktree: null, providerId: null
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

    expect(screen.queryByLabelText("Thread details")).toBeNull();
    fireEvent.pointerMove(await screen.findByRole("link", { name: "Thread metadata" }), { pointerType: "mouse" });
    const details = await screen.findByRole("dialog", { name: "Thread details" });
    expect(details.textContent).toContain("Project: bb");
    expect(details.textContent).not.toContain("Feature worktree");
    expect(details.textContent).toContain("Worktree branch: bb/details");
    expect(details.textContent).toContain("Machine: Build Mac");
    expect(details.textContent).toContain("Provider: Claude Code");
    expect(details.textContent).toContain("Model:");
    expect(within(details).queryByRole("list", { name: "Subthreads" })).toBeNull();
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
    expect(screen.getByText("Working").className).toContain(
      "text-[color:var(--bb-sidebar-tone-working)]",
    );
    expect(screen.queryByText("3h")).toBeNull();
  });

  // The host says only that a thread is working, so the sidebar keeps its own
  // stamp per thread and shows how long the current stretch has run.
  it("shows how long a thread has been working", async () => {
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_run: Date.now() - 5 * 60_000 - 60_000 }),
    );
    render([thread({ id: "thr_run", indicator: "runtime" })]);
    expect(await screen.findByText("Working · 5m")).toBeDefined();
  });

  it("shows monitoring when BB identifies a monitoring runtime", async () => {
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_monitor: Date.now() - 5 * 60_000 - 60_000 }),
    );
    render([
      thread({
        id: "thr_monitor",
        indicator: "runtime",
        indicatorLabel: "Thread monitoring",
      }),
    ]);
    expect(await screen.findByText("Monitoring · 5m")).toBeDefined();
    expect(screen.getByLabelText("Thread monitoring")).toBeDefined();
  });

  it("stamps a thread that starts working and persists the stamp", async () => {
    render([thread({ id: "thr_run", indicator: "runtime" })]);
    expect(await screen.findByText("Working")).toBeDefined();
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("bb-sidebar:working-since:v1") ?? "{}",
      ) as Record<string, number>;
      expect(typeof stored.thr_run).toBe("number");
    });
  });

  // A request for input is a verdict, not a stretch of work, and reads oddly
  // with a duration behind it.
  it("leaves the duration off a status that is waiting on the user", async () => {
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_ask: Date.now() - 10 * 60_000 }),
    );
    render([
      thread({
        id: "thr_ask",
        indicator: "waiting-for-input",
        hasPendingInteraction: true,
      }),
    ]);
    expect(await screen.findByText("Needs you")).toBeDefined();
  });

  // bb paints no indicator for queued messages, so without these labels a
  // failed send reads as idle or merely busy.
  it("labels a failed send over everything but a question", async () => {
    render([
      thread({ id: "thr_failed", indicator: "runtime", queuedWork: "failed" }),
      thread({
        id: "thr_asking",
        hasPendingInteraction: true,
        queuedWork: "failed",
      }),
    ]);
    expect(await screen.findByText("Send failed")).toBeDefined();
    expect(screen.getByLabelText("A queued message failed to send")).toBeDefined();
    expect(screen.getByText("Needs you")).toBeDefined();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("labels a waiting message only on an otherwise quiet row", async () => {
    render([
      thread({ id: "thr_scheduled", title: "Scheduled", queuedWork: "waiting" }),
      thread({
        id: "thr_behind",
        title: "Behind a turn",
        indicator: "runtime",
        queuedWork: "waiting",
      }),
    ]);
    expect(await screen.findByText("Queued")).toBeDefined();
    expect(screen.getByLabelText("A message is waiting to send")).toBeDefined();
    expect(screen.getAllByText("Queued")).toHaveLength(1);
    expect(screen.getByText("Working")).toBeDefined();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.  // An indicator this plugin does not know must fall through to the age label
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

  // bb keeps unsent composer drafts out of `indicator`, so the row folds them
  // in itself, in bb's order: a draft never hides a result you have not read.
  it("marks threads holding an unsent draft", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_idle", title: "Idle draft" }),
          thread({ id: "thr_busy", title: "Busy draft", indicator: "runtime", indicatorLabel: "Thread working" }),
          thread({ id: "thr_unread", title: "Unread draft", indicator: "unread-success", indicatorLabel: "Unread thread succeeded" }),
          thread({ id: "thr_clean", title: "No draft", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: { status: "ready", providers: defaultProviders },
      rpc: { listLifecycle: () => ({ rows: [] }) },
      sidebarDraftThreadIds: ["thr_idle", "thr_busy", "thr_unread"],
    });
    expect(await screen.findByLabelText("Thread has unsubmitted draft")).toBeDefined();
    expect(screen.getByText("Draft").className).toContain("text-[color:var(--bb-sidebar-tone-draft)]");
    expect(screen.getByLabelText("Thread working with unsubmitted draft")).toBeDefined();
    expect(screen.getByText("Drafting")).toBeDefined();
    expect(screen.getByText("Unread")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
  });
});

// The three states that need attention take the slot from the age label.
describe("attention states", () => {
  const states = [
    [
      "waiting-for-input",
      "Thread needs user input",
      "Needs you",
      "text-[color:var(--bb-sidebar-tone-pending)]",
    ],
    [
      "unread-error",
      "Unread thread failed",
      "Failed",
      "text-[color:var(--bb-sidebar-tone-error)]",
    ],
    [
      "unread-success",
      "Unread thread succeeded",
      "Unread",
      "text-[color:var(--bb-sidebar-tone-success)]",
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
  it("mounts pull request lookups only while the row is visible", async () => {
    let notify!: (entries: Array<{ isIntersecting: boolean }>) => void;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof notify) { notify = callback; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      const view = withPr("none");
      await screen.findByText("A thread");
      expect(screen.queryByRole("link", { name: "#412" })).toBeNull();
      await act(async () => notify([{ isIntersecting: true }]));
      expect(await screen.findByRole("link", { name: "#412" })).toBeTruthy();
      await act(async () => notify([{ isIntersecting: false }]));
      expect(screen.queryByRole("link", { name: "#412" })).toBeNull();
      view.unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  const withPr = (attention: string, state = "open") =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
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

  // BB's richer attention state keeps failed open PRs red while other open
  // states use the emerald pull request color.
  it("colors the badge from the attention state", async () => {
    const failing = withPr("checks_failed");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-[color:var(--bb-sidebar-pr-alert)]");
    failing.unmount();

    withPr("ready_to_merge");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-[color:var(--bb-sidebar-pr-open)]");
  });

  it("covers pending, review, draft, closed, and merged states", async () => {
    const pending = withPr("checks_pending");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-[color:var(--bb-sidebar-pr-open)]");
    pending.unmount();

    const review = withPr("review_requested");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-[color:var(--bb-sidebar-pr-open)]");
    review.unmount();

    const draft = withPr("draft", "draft");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-muted-foreground/60");
    draft.unmount();

    const closed = withPr("closed", "closed");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-[color:var(--bb-sidebar-pr-alert)]");
    closed.unmount();

    withPr("merged", "merged");
    expect(
      (await screen.findByRole("link", { name: "#412" })).className,
    ).toContain("text-[color:var(--bb-sidebar-pr-merged)]");
  });
});


it("keeps parked threads parked when opened and offers Resume with Undo", async () => {
  const resume = vi.fn(() => ({ ok: true }));
  const park = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [thread({ id: "waiting", title: "Awaiting review", isPinned: true })],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      listLifecycle: () => ({ rows: [{ threadId: "waiting", parkedAt: Date.now() - 5 * 86400000, settledAt: null, snoozedUntil: null, snoozedAt: null }] }),
      resume,
      park,
    },
  });
  const shelf = await screen.findByRole("region", { name: "Parked" });
  fireEvent.click(within(shelf).getByRole("button"));
  expect(within(shelf).getByText("Waiting 5d")).toBeDefined();
  fireEvent.click(within(shelf).getByRole("link", { name: "bb · Awaiting review" }));
  expect(resume).not.toHaveBeenCalled();
  expect(rendered.sidebarActionCalls).toContainEqual({ method: "open", threadId: "waiting", options: { split: false } });
  fireEvent.click(within(shelf).getByRole("button", { name: "Resume thread" }));
  await waitFor(() => expect(resume).toHaveBeenCalled());
  const toast = toastMocks.success.mock.calls.find(([message]) => message === "Thread returned to the inbox");
  expect(toast).toBeDefined();
  act(() => toast![1].action.onClick());
  await waitFor(() => expect(park).toHaveBeenCalled());
});


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
          thread({ id: "nested-active", title: "Nested active work", parentThreadId: "active", updatedAt: now - 6_000 }),
          thread({ id: "nested-pinned", title: "Nested pinned work", parentThreadId: "settled", isPinned: true, updatedAt: now - 8_000 }),
          thread({ id: "orphan", title: "Orphan parent", parentThreadId: "missing", updatedAt: now - 10_000 }),
          thread({ id: "descendant", title: "Forbidden pinned child", parentThreadId: "child", isPinned: true }),
          thread({ id: "other", title: "Foreign pinned thread", projectId: "proj_other", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }, { id: "proj_other", name: "docs", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: true, inactiveAfterHours: 6 }),
        listLifecycle: () => ({ rows: [
          { threadId: "settled", settledAt: now, snoozedUntil: null, snoozedAt: null },
          { threadId: "snoozed", settledAt: null, snoozedUntil: now + 3_600_000, snoozedAt: now },
          { threadId: "parked", settledAt: null, snoozedUntil: null, snoozedAt: null, parkedAt: now },
        ] }),
      },
    });
    await screen.findByRole("region", { name: "Inactive" });
    await screen.findByRole("region", { name: "Settled" });
    fireEvent.contextMenu(await screen.findByText("Choose my parent"));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Parent" }), { key: "ArrowRight" });
    const search = await screen.findByRole("textbox", { name: "Search parent threads" });
    const menu = search.closest<HTMLElement>('[role="menu"]')!;
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual([
      "None", "Settled parent", "Nested work", "Snoozed parent", "Active parent",
      "Parked parent", "Nested active work", "Pinned second", "Nested pinned work",
      "Pinned parent", "Orphan parent", "Older parent", "docs · Foreign pinned thread",
    ]);
    expect(within(menu).queryByRole("separator")).toBeNull();
    expect(within(menu).getByRole("menuitemradio", { name: "Pinned parent" }).querySelector('[data-icon="Pin"]')).not.toBeNull();

    fireEvent.change(search, { target: { value: "pinned" } });
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["None", "Pinned second", "Nested pinned work", "Pinned parent", "docs · Foreign pinned thread"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
    fireEvent.change(search, { target: { value: "docs" } });
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["None", "docs · Foreign pinned thread"]);
    fireEvent.change(search, { target: { value: "older" } });
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["None", "Older parent"]);
    expect(within(menu).queryByRole("separator")).toBeNull();
    fireEvent.change(search, { target: { value: "settled" } });
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["None", "Settled parent"]);
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
    expect(within(menu).getByRole("menuitemradio", { name: "Current parent" }).getAttribute("aria-checked")).toBe("true");
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
    const { menu } = await openParentMenu(vi.fn(() => { throw new Error("Parent is no longer available"); }));
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Next parent" }));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("Could not update parent", { description: "Parent is no longer available" }));
  });
});


describe("structural child pin policy UI", () => {
  it.each(["pinned", "unpinned", "archived", "missing", "other-project"])("omits new Pin for a child with %s parent", async (parentState) => {
    const child = thread({ id: "child", title: "Policy child", parentThreadId: "parent" });
    const parent = thread({ id: "parent", isPinned: parentState === "pinned", isArchived: parentState === "archived", projectId: parentState === "other-project" ? "other" : "proj_1" });
    const rendered = renderSlot({ component: PolicyMenu }, { selected: child }, {
      sidebarThreads: { status: "ready", threads: parentState === "missing" ? [child] : [child, parent], projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }] },
    });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Unpin" })).toBeNull();
    expect(rendered.rpcCalls).toHaveLength(0);
  });

  it.each([null, "fork"] as const)("allows new Pin for a structural root with originKind=%s", async (originKind) => {
    const selected = thread({ id: "root", originKind });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, {
      sidebarThreads: { threads: [selected] }, rpc: { pin: () => ({ ok: true }) },
    });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "pin", input: { threadId: "root" } }));
  });

  it("keeps Unpin for an existing pinned child", async () => {
    const selected = thread({ id: "child", parentThreadId: "missing", isPinned: true });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, { sidebarThreads: { threads: [selected] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(rendered.sidebarActionCalls).toContainEqual({ method: "setPinned", threadId: "child", pinned: false }));
    expect(rendered.rpcCalls).toHaveLength(0);
  });

  it.each([false, true])("uses the same child menu policy in %s header/sidebar surface", async (header) => {
    const children = [thread({ id: "child", title: "Nested policy child", parentThreadId: "parent", isPinned: true })];
    const threads = [thread({ id: "parent", title: "Policy parent" }), ...children];
    const options = { sidebarThreads: { status: "ready" as const, threads, projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }] }, rpc: { listLifecycle: () => ({ rows: [] }) } };
    const rendered = header
      ? renderSlot(app.threadHeaderActions.find(action => action.id === "children")!, { threadId: "parent", projectId: "proj_1", isCompactViewport: false }, options)
      : renderSlot(inbox, listProps, options);
    fireEvent.click(await screen.findByRole("button", { name: /1 child thread/ }));
    fireEvent.contextMenu(await screen.findByText("Nested policy child"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(rendered.sidebarActionCalls).toContainEqual({ method: "setPinned", threadId: "child", pinned: false }));
  });

  it.each([null, "old"])("offers enabled parent choices/hint and keyboard for pinned thread with parent=%s", async (currentParent) => {
    const selected = thread({ id: "thread", parentThreadId: currentParent, isPinned: true });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, {
      sidebarThreads: { threads: [selected, thread({ id: "parent", title: "Next parent" }), thread({ id: "old", title: "Old parent" })] },
      rpc: { setThreadParent: () => ({ ok: true }) },
    });
    const row = screen.getByRole("button", { name: "Policy row" });
    fireEvent.contextMenu(row);
    fireEvent.keyDown(within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }), { key: "ArrowRight" });
    const input = await screen.findByRole("textbox", { name: "Search parent threads" });
    const menu = input.closest<HTMLElement>('[role="menu"]')!;
    expect(within(menu).getByText("Choosing a different parent will unpin this thread. Choosing None keeps it pinned.")).toBeDefined();
    const choice = within(menu).getByRole("menuitemradio", { name: "Next parent" });
    expect(choice.getAttribute("aria-disabled")).not.toBe("true");
    expect(within(menu).getByRole("menuitemradio", { name: "None" }).getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.change(input, { target: { value: "Next" } });
    rendered.rerender(<PolicyMenu selected={{ ...selected, isPinned: false }} />);
    expect(screen.getByRole("button", { name: "Policy row", hidden: true })).toBe(row);
    expect(within(menu).queryByText("Choosing a different parent will unpin this thread. Choosing None keeps it pinned.")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(document.activeElement).toBe(choice);
    fireEvent.keyDown(choice, { key: "Enter" });
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "setThreadParent", input: { threadId: "thread", parentThreadId: "parent" } }));
  });

  it.each(["old", "next", null])("keeps parent choice %s available for an existing pinned child", async (parentThreadId) => {
    const selected = thread({ id: "child", parentThreadId: "old", isPinned: true });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, {
      sidebarThreads: { threads: [selected, thread({ id: "old", title: "Old parent" }), thread({ id: "next", title: "Next parent" })] },
      rpc: { setThreadParent: () => ({ ok: true }) },
    });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.keyDown(within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }), { key: "ArrowRight" });
    const input = await screen.findByRole("textbox", { name: "Search parent threads" });
    const menu = input.closest<HTMLElement>('[role="menu"]')!;
    expect(within(menu).getByText("Choosing a different parent will unpin this thread. Choosing None keeps it pinned.")).toBeDefined();
    const choice = within(menu).getByRole("menuitemradio", { name: parentThreadId === "old" ? "Old parent" : parentThreadId === "next" ? "Next parent" : "None" });
    expect(choice.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(choice);
    if (parentThreadId === "old") expect(rendered.rpcCalls).toHaveLength(0);
    else await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "setThreadParent", input: { threadId: "child", parentThreadId } }));
  });
});


describe("parent auto-unpin menu UX", () => {
  const noop = () => {};
  it.each([
    { name: "no actions", actions: {}, item: null },
    { name: "park", actions: { onPark: noop }, item: "Park thread" },
  ])("keeps real group boundaries without adjacent separators: $name", async ({ actions, item }) => {
    const selected = thread({ parentThreadId: "missing" });
    renderSlot({ component: PolicyMenu }, { selected, actions }, { sidebarThreads: { threads: [selected] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    const separators = within(menu).getAllByRole("separator");
    for (const separator of separators) expect(separator.nextElementSibling?.getAttribute("role")).not.toBe("separator");
    if (item) expect(within(menu).getByRole("menuitem", { name: item })).toBeDefined();
  });

  it("shows exactly one honest partial-success toast and suppresses duplicate selection while saving", async () => {
    const selected = thread({ id: "thread", isPinned: true });
    const pending = deferred<{ ok: boolean; unpinFailed: true }>();
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, {
      sidebarThreads: { threads: [selected, thread({ id: "parent", title: "Next parent" })] },
      rpc: { setThreadParent: () => pending.promise },
    });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.keyDown(within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }), { key: "ArrowRight" });
    const input = await screen.findByRole("textbox", { name: "Search parent threads" });
    const choice = within(input.closest<HTMLElement>('[role="menu"]')!).getByRole("menuitemradio", { name: "Next parent" });
    fireEvent.click(choice); fireEvent.click(choice);
    await waitFor(() => expect(rendered.rpcCalls).toHaveLength(1));
    await act(async () => pending.resolve({ ok: true, unpinFailed: true }));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledExactlyOnceWith("Parent updated, but unpinning could not be confirmed", {
      description: "If the thread is still pinned, choose Unpin manually.",
    }));
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("keeps None at a pinned root a no-op", async () => {
    const selected = thread({ id: "thread", isPinned: true });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, { sidebarThreads: { threads: [selected] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.keyDown(within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }), { key: "ArrowRight" });
    const input = await screen.findByRole("textbox", { name: "Search parent threads" });
    fireEvent.click(within(input.closest<HTMLElement>('[role="menu"]')!).getByRole("menuitemradio", { name: "None" }));
    expect(rendered.rpcCalls).toHaveLength(0);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});


describe("scoped active representative regressions", () => {
  it.each([
    ["A", "parent"], ["B", "child"], [null, "parent"],
  ] as const)("retains closest flat row in collapsed scope %s", async (scope, expected) => {
    const rendered = renderSlot(inbox, { ...listProps, activeThreadId: "child" }, {
      sidebarThreads: { status: "ready", threads: [
        thread({ id: "parent", title: "Parent A", projectId: "A" }),
        thread({ id: "child", title: "Child B", projectId: "B", parentThreadId: "parent" }),
      ], projects: [{ id: "A", name: "A", isPersonal: false, href: "", settingsHref: "" }, { id: "B", name: "B", isPersonal: false, href: "", settingsHref: "" }] },
      rpc: { listLifecycle: () => ({ rows: ["parent", "child"].map(threadId => ({ threadId, settledAt: 200, snoozedUntil: null, snoozedAt: null })) }) },
    });
    if (scope) {
      fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
      fireEvent.click(screen.getByRole("option", { name: scope }));
    }
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByRole("button", { expanded: false })).toBeDefined();
    expect(within(shelf).getByText(expected === "parent" ? "Parent A" : "Child B")).toBeDefined();
    expect(within(shelf).getAllByRole("link")).toHaveLength(1);
    expect(rendered.rpcCalls.filter(call => /Parent|reorder|Pinned/.test(call.method))).toEqual([]);
  });

  it.each([["A", "Grandchild A"], ["B", "Deep B"]])("chooses the nearest alternating-project flat ancestor in %s", async (scope, title) => {
    window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
    renderSlot(inbox, { ...listProps, activeThreadId: "deep" }, {
      sidebarThreads: { status: "ready", projects: [{ id: "A", name: "A", isPersonal: false, href: "", settingsHref: "" }, { id: "B", name: "B", isPersonal: false, href: "", settingsHref: "" }], threads: [
        thread({ id: "root", title: "Root A", projectId: "A", updatedAt: Date.now() }),
        thread({ id: "child", title: "Child B", projectId: "B", parentThreadId: "root", updatedAt: Date.now() }),
        thread({ id: "grandchild", title: "Grandchild A", projectId: "A", parentThreadId: "child", updatedAt: Date.now() }),
        thread({ id: "deep", title: "Deep B", projectId: "B", parentThreadId: "grandchild", updatedAt: Date.now() }),
      ] }, rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    fireEvent.keyDown(screen.getByLabelText(/Project scope/), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: scope }));
    expect(await screen.findByRole("link", { name: title })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Root A" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Child B" })).toBeNull();
  });

  it.each(["missing", "archived", "same-project", "unknown"])("handles %s active ancestry after settled limit", async (mode) => {
    window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ settled: true }));
    const parent = thread({ id: "parent", title: "Representative", isArchived: mode === "archived" });
    const child = thread({ id: "child", title: "Orphan", parentThreadId: mode === "missing" ? "missing" : "parent" });
    const rows = [...Array.from({ length: 12 }, (_, i) => thread({ id: `filler-${i}`, title: `Filler ${i}` })), ...(mode === "missing" ? [] : [parent]), child];
    renderSlot(inbox, { ...listProps, activeThreadId: mode === "unknown" ? "unknown" : "child" }, {
      sidebarThreads: { status: "ready", threads: rows, projects: [] },
      rpc: { listLifecycle: () => ({ rows: rows.map((row, i) => ({ threadId: row.id, settledAt: 1000 - i, snoozedUntil: null, snoozedAt: null })) }) },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    const expected = mode === "same-project" ? "Representative" : "Orphan";
    if (mode === "unknown") {
      expect(within(shelf).queryByText("Representative")).toBeNull();
      expect(within(shelf).getAllByRole("link")).toHaveLength(10);
    } else {
      expect(within(shelf).getByText(expected)).toBeDefined();
      expect(within(shelf).getAllByRole("link")).toHaveLength(11);
      fireEvent.click(within(shelf).getByRole("button", { expanded: true }));
      expect(within(shelf).getByText(expected)).toBeDefined();
      expect(within(shelf).getAllByRole("link")).toHaveLength(1);
    }
  });
});

describe("four-level sidebar hierarchy", () => {
  it.each([
    ["none", null], ["waiting-for-input", "needs-you"], ["unread-error", "failed"],
    ["unread-success", "done"], ["runtime", "working"],
  ] as const)("retains full active/attention path for %s", (indicator, status) => {
    const active = status === null;
    const rendered = renderSlot(inbox, { ...listProps, activeThreadId: active ? "deep" : null }, {
      sidebarThreads: { status: "ready", projects: [], threads: [
        thread({ id: "root", title: "Root", updatedAt: Date.now() }),
        thread({ id: "child", title: "Child", parentThreadId: "root" }),
        thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
        thread({ id: "deep", title: "Deep", parentThreadId: "grandchild", indicator }),
        thread({ id: "idle", title: "Idle sibling", parentThreadId: "grandchild" }),
      ] }, rpc: { listLifecycle: () => ({ rows: [] }), getSidebarSettings: () => defaultSidebarSettings },
    });
    const badge = screen.getByRole("button", { name: /^1 child thread/ });
    expect(badge.getAttribute("data-child-status")).toBe(status);
    const deep = screen.getByRole("button", { name: /^Open great-grandchild thread: Deep/ });
    expect(deep.getAttribute("aria-current")).toBe(active ? "page" : null);
    expect(screen.queryByText("Idle sibling")).toBeNull();
    const disclosure = screen.getByRole("button", { name: "Show 2 great-grandchild threads for Grandchild" });
    fireEvent.pointerDown(disclosure, { button: 0 });
    fireEvent.click(disclosure);
    expect(screen.getByText("Idle sibling")).toBeDefined();
    expect(rendered.sidebarActionCalls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Hide 2 great-grandchild threads for Grandchild" }));
    expect(screen.queryByText("Idle sibling")).toBeNull();
    fireEvent.pointerDown(deep, { button: 0 });
    expect(rendered.sidebarActionCalls).toEqual([{ method: "open", threadId: "deep" }]);
    expect(rendered.rpcCalls.filter(call => /Parent|reorder|Pinned/.test(call.method))).toEqual([]);
    {
      fireEvent.click(screen.getByRole("button", { name: "Active" }));
      expect(screen.getByRole("link", { name: "Root" })).toBeDefined();
      expect(screen.getByRole("button", { name: /^Open great-grandchild thread: Deep/ })).toBeDefined();
    }
  });

  it("stops archived branches in sidebar rollup and disclosure", () => {
    window.localStorage.setItem("bb-sidebar:child-expansion:v1", JSON.stringify(["root"]));
    renderSlot(inbox, { ...listProps, activeThreadId: "deep" }, {
      sidebarThreads: { status: "ready", projects: [], threads: [
        thread({ id: "root", title: "Root", parentThreadId: "missing", updatedAt: Date.now() }),
        thread({ id: "child", title: "Child", parentThreadId: "root" }),
        thread({ id: "grandchild", title: "Archived", parentThreadId: "child", isArchived: true }),
        thread({ id: "deep", title: "Hidden deep", parentThreadId: "grandchild", indicator: "unread-error" }),
      ] }, rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    expect(screen.getByRole("button", { name: "1 child thread" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Open great-grandchild/ })).toBeNull();
  });
});


it("guards cyclic child DTOs while expanding and retains deep sibling sort", async () => {
  const { ChildThreadList, childThreadsByParent } = await import("./ChildThreadList");
  const rows = [
    thread({ id: "child", title: "Child", parentThreadId: "grandchild", createdAt: 1 }),
    thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child", createdAt: 2 }),
    thread({ id: "later", title: "Later", parentThreadId: "grandchild", createdAt: 4 }),
    thread({ id: "earlier", title: "Earlier", parentThreadId: "grandchild", createdAt: 3 }),
  ];
  const map = childThreadsByParent(rows);
  function Fixture() {
    return <ChildThreadList threads={[rows[0]!]} childrenByParent={map} variant="sidebar" activeThreadId="earlier" onOpenThread={() => {}} />;
  }
  renderSlot({ component: Fixture }, {}, { sidebarThreads: { status: "ready", threads: rows, projects: [] } });
  expect(screen.getByRole("button", { name: "Open great-grandchild thread: Earlier" })).toBeDefined();
  const disclosure = screen.getByRole("button", { name: "Show 2 great-grandchild threads for Grandchild" });
  fireEvent.click(disclosure);
  const names = screen.getAllByRole("button", { name: /^Open / }).map(row => row.getAttribute("aria-label"));
  expect(names).toEqual(["Open child thread: Child", "Open grandchild thread: Grandchild", "Open great-grandchild thread: Earlier", "Open great-grandchild thread: Later"]);
  expect(screen.queryByRole("button", { name: /^Open descendant/ })).toBeNull();
});


it("honors disabled attention retention for fourth-level descendants", async () => {
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", projects: [], threads: [
      thread({ id: "root", title: "Root", updatedAt: Date.now() }),
      thread({ id: "child", title: "Child", parentThreadId: "root" }),
      thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
      thread({ id: "deep", title: "Deep", parentThreadId: "grandchild", indicator: "waiting-for-input" }),
    ] }, rpc: {
      listLifecycle: () => ({ rows: [] }),
      getSidebarSettings: () => ({ ...defaultSidebarSettings, showRunningChildrenWhenCollapsed: false }),
    },
  });
  const badge = await screen.findByRole("button", { name: "1 child thread, 1 need you" });
  await waitFor(() => expect(rendered.rpcCalls.some(call => call.method === "getSidebarSettings")).toBe(true));
  expect(screen.queryByRole("button", { name: /^Open great-grandchild/ })).toBeNull();
  fireEvent.click(badge);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Child" }));
  fireEvent.click(screen.getByRole("button", { name: "Show 1 great-grandchild thread for Grandchild" }));
  expect(screen.getByRole("button", { name: "Open great-grandchild thread: Deep, Needs you" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Active" }));
  expect(screen.queryByRole("link", { name: "Root" })).toBeNull();
});
