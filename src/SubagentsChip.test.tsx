// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { archivedListThread, idleSidebarThreadFields } from "./test-fixtures";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { SidebarProvider } from "./ProviderGlyph";

const app = await loadPluginApp(() => import("../app"));
const childrenChip = app.threadHeaderActions.find(
  (slot) => slot.id === "children",
)!;

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
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

function provider(id: string, displayName: string): SidebarProvider {
  return {
    id,
    pluginId: `provider-${id}`,
    displayName,
    available: true,
    completedTurnDisplay: "collapse",
    maintenance: { health: true, usage: false, installation: true },
    logoUrl: `/api/v1/system/providers/${id}/logo`,
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

const providers = [
  provider("codex", "Codex"),
  provider("claude-code", "Claude Code"),
  provider("acp-opencode", "opencode"),
  provider("acp-cursor", "Cursor"),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
};

const orderedChildren = [
  thread({ id: "parent", title: "Parent" }),
  thread({ id: "old", title: "Old", parentThreadId: "parent", createdAt: 101 }),
  thread({ id: "new", title: "New", parentThreadId: "parent", createdAt: 102 }),
];

function childRowNames(): string[] {
  return within(screen.getByRole("list", { name: "Child threads" }))
    .getAllByRole("button", { name: /^Open child thread:/ })
    .map((row) => row.getAttribute("aria-label") ?? "");
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("SubagentsChip", () => {
  it("opens archived descendants outside the sidebar pages without restoring them", async () => {
    const records = [
      archivedListThread({ id: "child", title: "Child", parentThreadId: "parent" }),
      archivedListThread({ id: "grandchild", title: "Grandchild", parentThreadId: "child", projectId: "proj_2" }),
      archivedListThread({ id: "deep", title: "Deep", parentThreadId: "grandchild", projectId: "proj_2" }),
    ];
    const rendered = renderSlot(childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false }, {
        sidebarThreads: { status: "ready", threads: [], projects: [
          { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
          { id: "proj_2", name: "Other", isPersonal: false, href: "", settingsHref: "" },
        ] },
        sdk: { threads: {
          get: async () => makeThreadResponse({ id: "parent", projectId: "proj_1", archivedAt: 500 }),
          list: async (args) => records.filter((record) => record.parentThreadId === args?.parentThreadId),
        } },
      });
    fireEvent.click(await screen.findByRole("button", { name: "1 child thread" }));
    expect(await screen.findByRole("button", { name: "Open child thread: Child, Archived" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Child" }));
    expect(screen.getByRole("button", { name: "Open grandchild thread: Grandchild, in project Other, Archived" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 great-grandchild thread for Grandchild" }));
    fireEvent.click(screen.getByRole("button", { name: "Open great-grandchild thread: Deep, Archived" }));
    expect(rendered.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "deep" }]);
    expect(rendered.inspection.sidebarActionCalls).toEqual([]);
    expect(rendered.inspection.rpcCalls.some((call) => ["unarchiveThread", "unsettle", "archiveThreads"].includes(call.method))).toBe(false);
    expect(rendered.inspection.sdkCalls.every((call) => ["threads.get", "threads.list"].includes(call.method))).toBe(true);
  });

  it("loads later pages of one archived family and offers restore for only the selected child", async () => {
    const records = Array.from({ length: 101 }, (_, i) => archivedListThread({
      id: `child-${i}`, title: `Child ${i}`, parentThreadId: "parent", createdAt: i,
    }));
    const rendered = renderSlot(childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false }, {
        sidebarThreads: { status: "ready", threads: [thread({ id: "parent", isArchived: true })] },
        sdk: { threads: { list: async (args) => {
          expect(args).toMatchObject({ archived: true, includeHidden: true, limit: 100 });
          const children = records.filter((record) => record.parentThreadId === args?.parentThreadId);
          return children.slice(args?.offset ?? 0, (args?.offset ?? 0) + 100);
        } } },
        rpc: { unarchiveThread: () => ({ ok: true }) },
      });
    fireEvent.click(await screen.findByRole("button", { name: "101 child threads" }));
    const row = await screen.findByRole("button", { name: "Open child thread: Child 100, Archived" });
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByText("Archive")).toBeNull();
    fireEvent.click(within(menu).getByText("Restore from archive"));
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({ method: "unarchiveThread", input: { threadId: "child-100" } }));
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "unarchiveThread")).toHaveLength(1);
  });

  it("retries a failed archive lookup without showing an empty family as complete", async () => {
    let failed = true;
    renderSlot(childrenChip, { threadId: "parent", projectId: "proj_1", isCompactViewport: false }, {
      sidebarThreads: { status: "ready", threads: [thread({ id: "parent", isArchived: true })] },
      sdk: { threads: { list: async (args) => {
        if (failed) throw new Error("Offline");
        return args?.parentThreadId === "parent" ? [archivedListThread({ id: "child", parentThreadId: "parent" })] : [];
      } } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Child threads" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not load archived child threads.");
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Open child thread: Archived thread, Archived" })).toBeDefined();
  });

  it("keeps archived children out of a live parent's child menu", () => {
    const rendered = renderSlot(childrenChip, { threadId: "parent", projectId: "proj_1", isCompactViewport: false }, {
      sidebarThreads: { status: "ready", threads: [
        thread({ id: "parent" }),
        thread({ id: "live", title: "Live child", parentThreadId: "parent" }),
        thread({ id: "archived", title: "Archived child", parentThreadId: "parent", isArchived: true }),
      ] },
    });
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(screen.queryByText("Archived child")).toBeNull();
    expect(rendered.inspection.sdkCalls).toEqual([]);
  });

  it.each([false, true])("loads execution details only on hover and handles failure=%s", async (fail) => {
    let requests = 0;
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "parent" }), thread({ id: "child", title: "Child", parentThreadId: "parent" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getThreadExecutionDetails: (input) => {
            expect(input).toEqual({ threadId: "child" });
            requests++;
            if (fail) throw new Error("Offline");
            return { model: "gpt-6", reasoningLevel: "high" };
          },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(requests).toBe(0);
    const row = screen.getByRole("button", { name: "Open child thread: Child" });
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    await waitFor(() => {
      const tooltip = screen.getByRole("dialog", { name: "Thread details" });
      expect(tooltip.textContent).toContain("Provider: codex");
      expect(tooltip.textContent).toContain(fail ? "Model: Unavailable" : "Model: gpt-6");
      if (!fail) expect(tooltip.textContent).toContain("Reasoning: high");
    });
    expect(requests).toBe(1);
  });

  it("marks children from another project than their parent", () => {
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "here", title: "Here", parentThreadId: "parent" }),
            thread({ id: "away", title: "Away", projectId: "proj_2", parentThreadId: "parent" }),
            thread({ id: "back", title: "Back", parentThreadId: "away" }),
          ],
          projects: [
            { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
            { id: "proj_2", name: "xPlan", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "2 child threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Away" }));

    expect(screen.getByRole("button", { name: "Open child thread: Here" })
      .querySelector("[data-foreign-project]")).toBeNull();
    const away = screen.getByRole("button", { name: "Open child thread: Away, in project xPlan" });
    expect(away.textContent).toContain("thread · xPlan");
    expect(away.querySelector("[data-foreign-project]")?.getAttribute("data-foreign-project")).toBe("proj_2");
    // Compared with its own parent, not the root: back in bb under an xPlan child.
    expect(screen.getByRole("button", { name: "Open grandchild thread: Back, in project bb" })
      .querySelector("[data-foreign-project]")?.getAttribute("data-foreign-project")).toBe("proj_1");
  });

  it.each(["child", "grandchild", "great-grandchild"])("renames a %s without opening it and keeps the popup on cancel", async (targetId) => {
    const rendered = renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
            thread({ id: "great-grandchild", title: "Great-grandchild", parentThreadId: "grandchild" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    if (targetId !== "child") {
      fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Child" }));
    }
    if (targetId === "great-grandchild") {
      fireEvent.click(screen.getByRole("button", { name: "Show 1 great-grandchild thread for Grandchild" }));
    }
    const title = targetId === "child" ? "Child" : targetId === "grandchild" ? "Grandchild" : "Great-grandchild";
    const startRename = async () => {
      fireEvent.contextMenu(screen.getByRole("button", { name: `Open ${targetId} thread: ${title}` }));
      fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Rename"));
      return screen.findByRole("textbox", { name: `Rename ${title}` });
    };
    let input = await startRename();
    expect(input.closest("button")).toBeNull();
    fireEvent.pointerDown(input, { button: 0 });
    expect(rendered.sidebarActionCalls).toEqual([]);
    fireEvent.change(input, { target: { value: "Canceled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Child threads" })).toBeTruthy();
    expect(rendered.sidebarActionCalls).toEqual([]);

    input = await startRename();
    fireEvent.change(input, { target: { value: "Renamed child" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(rendered.sidebarActionCalls).toEqual([
      { method: "rename", threadId: targetId, title: "Renamed child" },
    ]));
  });

  // The SDK test runtime logs open on pointerdown. These assertions verify
  // source binding/ID only, not actual host drop timing or mention insertion.
  it("binds header child, grandchild and fourth-level sources without binding disclosure", () => {
    const rendered = renderSlot(childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      { sidebarThreads: { status: "ready", projects: [], threads: [
        thread({ id: "parent", title: "Parent" }),
        thread({ id: "child", title: "Child", parentThreadId: "parent" }),
        thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
        thread({ id: "great-grandchild", title: "Great-grandchild", parentThreadId: "grandchild" }),
      ] } },
    );
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    const disclosure = screen.getByRole("button", { name: "Show 1 grandchild thread for Child" });
    fireEvent.pointerDown(disclosure, { button: 0 });
    expect(rendered.sidebarActionCalls).toEqual([]);
    fireEvent.click(disclosure);
    const deepDisclosure = screen.getByRole("button", { name: "Show 1 great-grandchild thread for Grandchild" });
    fireEvent.pointerDown(deepDisclosure, { button: 0 });
    fireEvent.click(deepDisclosure);
    expect(rendered.sidebarActionCalls).toEqual([]);
    for (const [relation, title, id] of [["child", "Child", "child"], ["grandchild", "Grandchild", "grandchild"], ["great-grandchild", "Great-grandchild", "great-grandchild"]]) {
      const source = screen.getByRole("button", { name: `Open ${relation} thread: ${title}` });
      expect(source.draggable).toBe(false);
      fireEvent.pointerDown(source, { button: 0 });
      expect(rendered.sidebarActionCalls.at(-1)).toEqual({ method: "open", threadId: id });
    }
    expect(rendered.sidebarActionCalls).toHaveLength(3);
  });

  it("mounts the shared child list in the header menu", () => {
    const rendered = renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "child-a",
              title: "Child A",
              parentThreadId: "parent",
              createdAt: 101,
            }),
            thread({
              id: "child-b",
              title: "Child B",
              parentThreadId: "parent",
              createdAt: 102,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
      },
    );

    const trigger = screen.getByRole("button", { name: "2 child threads" });
    fireEvent.click(trigger);
    const popup = screen.getByRole("region", { name: "Child threads" });
    expect(trigger.getAttribute("aria-controls")).toBe(popup.id);
    const list = screen.getByRole("list", { name: "Child threads" });
    expect(list.getAttribute("data-child-thread-list")).toBe("header");
    fireEvent.click(
      screen.getByRole("button", { name: "Open child thread: Child B" }),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "child-b",
      options: undefined,
    });
  });

  // The header variant draws a glyph rather than the sidebar's text slot, so
  // the accessible name is the only place its status is spelled out. It uses
  // the same vocabulary as a parent card, including a raised hand outranking
  // a reported runtime and an unknown kind saying nothing at all.
  it("labels header child rows with the shared status vocabulary", () => {
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "monitor",
              title: "Monitor child",
              parentThreadId: "parent",
              indicator: "runtime",
              indicatorLabel: "Thread monitoring",
              createdAt: 101,
            }),
            thread({
              id: "asking",
              title: "Asking child",
              parentThreadId: "parent",
              hasPendingInteraction: true,
              indicator: "runtime",
              indicatorLabel: "Agent is working",
              createdAt: 102,
            }),
            thread({
              id: "future",
              title: "Future child",
              parentThreadId: "parent",
              indicator: "something-bb-ships-later" as never,
              indicatorLabel: "Brand new",
              createdAt: 103,
            }),
            thread({
              id: "idle",
              title: "Idle child",
              parentThreadId: "parent",
              createdAt: 104,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "4 child threads" }));
    const list = screen.getByRole("list", { name: "Child threads" });
    expect(list.getAttribute("data-child-thread-list")).toBe("header");
    for (const name of [
      "Open child thread: Monitor child, Monitoring",
      "Open child thread: Asking child, Needs you",
      "Open child thread: Future child",
      "Open child thread: Idle child",
    ]) {
      expect(within(list).getByRole("button", { name })).toBeDefined();
    }
    // No text status slot in this variant, and no leftover raw host labels.
    expect(within(list).queryByText("Monitoring")).toBeNull();
    expect(within(list).queryByText("Needs you")).toBeNull();
    expect(within(list).queryByText("Brand new")).toBeNull();
  });

  it("keeps grandchildren collapsed until their child disclosure opens", () => {
    const rendered = renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "child",
              title: "Child",
              parentThreadId: "parent",
              createdAt: 101,
            }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              parentThreadId: "child",
              createdAt: 102,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(screen.queryByText("Grandchild")).toBeNull();

    const disclosure = screen.getByRole("button", {
      name: "Show 1 grandchild thread for Child",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);

    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Child",
    });
    expect(grandchildList.getAttribute("data-grandchild-thread-list")).toBe(
      "header",
    );
    fireEvent.click(
      within(grandchildList).getByRole("button", {
        name: "Open grandchild thread: Grandchild",
      }),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "grandchild",
      options: undefined,
    });
  });

  it("archives the selected child or grandchild from the header list", async () => {
    const rendered = renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
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
      },
    );

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

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 grandchild thread for Child",
      }),
    );
    fireEvent.contextMenu(
      screen.getByRole("button", {
        name: "Open grandchild thread: Grandchild",
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Thread actions" })).getByText(
        "Archive",
      ),
    );
    expect(rendered.sidebarActionCalls).toContainEqual({
      method: "archive",
      threadId: "grandchild",
    });
    expect(rendered.sidebarActionCalls).not.toContainEqual({
      method: "archive",
      threadId: "parent",
    });
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "child",
              title: "Child",
              parentThreadId: "parent",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
      },
    );

    const trigger = screen.getByRole("button", { name: "1 child thread" });
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Child threads" })).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("region", { name: "Child threads" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes when clicking outside the popup", async () => {
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    const popup = screen.getByRole("region", { name: "Child threads" });
    fireEvent.pointerDown(popup);
    expect(screen.getByRole("region", { name: "Child threads" })).toBeDefined();

    const outside = document.body.appendChild(document.createElement("div"));
    await waitFor(() => {
      fireEvent.pointerDown(outside, { pointerType: "mouse" });
      fireEvent.click(outside);
      expect(screen.queryByRole("region", { name: "Child threads" })).toBeNull();
    });
  });

  it("ignores a settings load that answers after a newer one", async () => {
    const stale = deferred<typeof defaultSidebarSettings>();
    let loads = 0;
    const rendered = renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: orderedChildren,
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => {
            loads += 1;
            return loads === 1
              ? stale.promise
              : { ...defaultSidebarSettings, childSortDirection: "descending" };
          },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "2 child threads" }));

    await rendered.emitRealtime("sidebar-settings", {});
    await waitFor(() =>
      expect(childRowNames()).toEqual([
        "Open child thread: New",
        "Open child thread: Old",
      ]),
    );

    stale.resolve(defaultSidebarSettings);
    await stale.promise;
    await waitFor(() => expect(loads).toBe(2));
    expect(childRowNames()).toEqual([
      "Open child thread: New",
      "Open child thread: Old",
    ]);
    expect(
      JSON.parse(
        window.localStorage.getItem("bb-sidebar:settings-cache:v1") ?? "{}",
      ).childSortDirection,
    ).toBe("descending");
  });

  it("orders the popover by the saved child sort and follows changes", async () => {
    let remoteSettings = {
      ...defaultSidebarSettings,
      childSortDirection: "descending",
    };
    const rendered = renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: orderedChildren,
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { getSidebarSettings: () => remoteSettings },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "2 child threads" }));
    await waitFor(() =>
      expect(childRowNames()).toEqual([
        "Open child thread: New",
        "Open child thread: Old",
      ]),
    );

    remoteSettings = { ...defaultSidebarSettings, childSortDirection: "ascending" };
    await rendered.emitRealtime("sidebar-settings", {});
    await waitFor(() =>
      expect(childRowNames()).toEqual([
        "Open child thread: Old",
        "Open child thread: New",
      ]),
    );
  });

  it("shows provider icons in popover rows when chosen", async () => {
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "codex-child",
              title: "Codex child",
              parentThreadId: "parent",
              providerId: "codex",
            }),
            thread({
              id: "claude-child",
              title: "Claude child",
              parentThreadId: "parent",
              providerId: "claude-code",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        providers: { status: "ready", providers },
        rpc: {
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            childIconStyle: "provider",
          }),
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "2 child threads" }));
    await waitFor(() => {
      const list = screen.getByRole("list", { name: "Child threads" });
      expect(within(list).getByRole("img", { name: "Codex" })).toBeDefined();
      expect(
        within(list).getByRole("img", { name: "Claude Code" }),
      ).toBeDefined();
    });
  });

  it("shows each provider once, at most three, on the chip", async () => {
    renderSlot(
      childrenChip,
      { threadId: "parent", projectId: "proj_1", isCompactViewport: false },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            ...["codex", "codex", "claude-code", "acp-opencode", "acp-cursor"].map(
              (providerId, index) =>
                thread({
                  id: `child-${index}`,
                  title: `Child ${index}`,
                  parentThreadId: "parent",
                  providerId,
                  createdAt: 101 + index,
                }),
            ),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        providers: { status: "ready", providers },
        rpc: {
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            childIconStyle: "provider",
          }),
        },
      },
    );
    const trigger = screen.getByRole("button", { name: "5 child threads" });
    await waitFor(() => {
      const dots = trigger.querySelectorAll("[data-child-thread-dot]");
      expect(
        [...dots].map((dot) =>
          dot.querySelector("[role=img]")?.getAttribute("aria-label"),
        ),
      ).toEqual(["Codex", "Claude Code", "opencode"]);
    });
  });
});


it("renders header hierarchy relative to the current child thread", () => {
  renderSlot(childrenChip, { threadId: "child", projectId: "proj_1", isCompactViewport: false }, {
    sidebarThreads: { status: "ready", projects: [], threads: [
      thread({ id: "root", title: "Root" }),
      thread({ id: "child", title: "Current child", parentThreadId: "root" }),
      thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
      thread({ id: "deep", title: "Deep", parentThreadId: "grandchild", indicator: "waiting-for-input" }),
    ] },
  });
  fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
  expect(screen.getByRole("button", { name: "Open child thread: Grandchild" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Grandchild" }));
  expect(screen.getByRole("button", { name: "Open grandchild thread: Deep, Needs you" })).toBeDefined();
  expect(screen.queryByRole("button", { name: /^Open child thread: Current child/ })).toBeNull();
});
