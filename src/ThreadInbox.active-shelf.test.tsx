// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { inbox, thread, listProps, render, loadInboxApp, rowLinks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("shows active threads in a collapsible Active shelf", () => {
    render([thread({ id: "a", title: "First active" }), thread({ id: "b", title: "Second active" })]);

    const activeShelf = screen.getByRole("region", { name: "Active" });
    expect(within(activeShelf).getByRole("button", { expanded: true })).toBeDefined();
    fireEvent.click(within(activeShelf).getByRole("button", { expanded: true }));
    expect(within(activeShelf).getByText("Active (2)")).toBeDefined();
    expect(within(activeShelf).queryByText("First active")).toBeNull();
    expect(within(activeShelf).queryByText("Second active")).toBeNull();
  });

  it("keeps the currently open active row visible while collapsed", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "open" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "open", title: "Open active" }), thread({ id: "other", title: "Other active" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const activeShelf = screen.getByRole("region", { name: "Active" });
    fireEvent.click(within(activeShelf).getByRole("button", { expanded: true }));
    expect(within(activeShelf).getByText("Open active")).toBeDefined();
    expect(within(activeShelf).queryByText("Other active")).toBeNull();
  });

  it("moves stale unpinned threads to a collapsed Inactive shelf", () => {
    const storedSettings = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...{
        inactiveThreadsEnabled: true,
        inactiveAfterHours: 6,
      },
    };
    localStorage.setItem("bb-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

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
      rpc: { getSidebarSettings: () => storedSettings, listLifecycle: () => ({ rows: [] }) },
    });

    const active = screen.getByRole("region", { name: "Active" });
    const inactive = screen.getByRole("region", { name: "Inactive" });
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(active).getByText("Recent work")).toBeDefined();
    expect(within(active).queryByText("Stale work")).toBeNull();
    expect(within(inactive).getByText("Inactive (1)")).toBeDefined();
    expect(within(inactive).queryByText("Stale work")).toBeNull();
    expect(within(pinned).getByText("Pinned old work")).toBeDefined();

    fireEvent.click(within(inactive).getByRole("button", { expanded: false }));
    expect(within(inactive).getByText("Stale work")).toBeDefined();
  });

  it("keeps stale threads Active when the feature is disabled", () => {
    const storedSettings = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...{
        inactiveThreadsEnabled: false,
        inactiveAfterHours: 6,
      },
    };
    localStorage.setItem("bb-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

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
      rpc: { getSidebarSettings: () => storedSettings, listLifecycle: () => ({ rows: [] }) },
    });

    expect(within(screen.getByRole("region", { name: "Active" })).getByText("Still active")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Inactive" })).toBeNull();
  });

  it("uses the configured inactivity threshold", () => {
    const storedSettings = {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...{
        inactiveThreadsEnabled: true,
        inactiveAfterHours: 8,
      },
    };
    localStorage.setItem("bb-sidebar:settings-cache:v1", JSON.stringify(storedSettings));

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
      rpc: { getSidebarSettings: () => storedSettings, listLifecycle: () => ({ rows: [] }) },
    });

    expect(within(screen.getByRole("region", { name: "Active" })).getByText("Seven hours old")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Inactive" })).getByText("Inactive (1)")).toBeDefined();
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
    const sortMenu = within(activeShelf).getByRole("button", {
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
    expect(screen.getByRole("radio", { name: "Manual order" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Recent activity" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Date created" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Project" })).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: "Recent activity" }), { detail: 1 });

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
    expect(rowLinks(activeShelf).every((link) => link.getAttribute("aria-keyshortcuts") === null)).toBe(true);

    fireEvent.keyDown(
      within(activeShelf).getByRole("button", {
        name: "Sort active threads: Recent activity",
      }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("radio", { name: "Date created" }), { detail: 1 });
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
      within(activeShelf).getByRole("button", {
        name: "Sort active threads: Date created",
      }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("radio", { name: "Project" }), { detail: 1 });
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
    expect(within(activeShelf).getByRole("button", { name: "Alpha (2)", expanded: true })).toBeDefined();
    expect(
      rowLinks(activeShelf).every((link) => link.getAttribute("aria-keyshortcuts") === "Alt+ArrowUp Alt+ArrowDown"),
    ).toBe(true);
    await waitFor(() => expect(window.localStorage.getItem("bb-sidebar:active-sort:v1")).toBe("project"));
  });

  it("migrates the previous project grouping preference", async () => {
    window.localStorage.setItem("bb-sidebar:active-grouping:v1", "true");
    render([thread({ id: "saved", title: "Saved grouping" })]);

    expect(
      screen.getByRole("button", {
        name: "Sort active threads: Project",
      }),
    ).toBeDefined();
    await waitFor(() => expect(window.localStorage.getItem("bb-sidebar:active-sort:v1")).toBe("project"));
  });

  it("names a project once in a header when it has two or more threads", () => {
    window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    window.localStorage.setItem("bb-sidebar:single-thread-project-grouping:v1", "false");
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
    expect(headers.map((header) => header.getAttribute("aria-label"))).toEqual(["Web (2)"]);
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
    fireEvent.click(within(active).getByRole("button", { name: "Active", expanded: true }));
    expect(within(active).queryByRole("button", { name: "Web (2)" })).toBeNull();
    expect(
      within(active)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringMatching(/^Web.*Second/)]);
  });

  it("gives one-thread projects a collapsible header until the option is turned off", async () => {
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

    const headers = () =>
      screen.queryAllByRole("button", { name: /\(\d+\)$/ }).map((header) => header.getAttribute("aria-label"));
    expect(headers()).toEqual(["Zed (1)", "Api (1)"]);
    fireEvent.click(screen.getByRole("button", { name: "Zed (1)", expanded: true }));
    expect(screen.queryByText("Zed thread")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sort active threads: Project" }));
    const option = screen.getByRole("checkbox", { name: "Group single-thread projects" });
    expect((option as HTMLInputElement).checked).toBe(true);
    fireEvent.click(option);
    expect(headers()).toEqual([]);
    await waitFor(() =>
      expect(window.localStorage.getItem("bb-sidebar:single-thread-project-grouping:v1")).toBe("false"),
    );
  });

  it("looks like manual order when no project has a second thread", () => {
    window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
    window.localStorage.setItem("bb-sidebar:single-thread-project-grouping:v1", "false");
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
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
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
    expect(screen.getByRole("button", { name: "Web (2)" }).getAttribute("aria-expanded")).toBe("false");
    const web = screen.getByRole("list", { name: "Web active threads" });
    expect(
      within(web)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Second")]);
    expect(screen.getByText("Third")).toBeDefined();
    await waitFor(() =>
      expect(window.localStorage.getItem("bb-sidebar:project-collapse:v1")).toBe(JSON.stringify(["web"])),
    );
  });

  it("lists threads newest first", () => {
    render([thread({ id: "a", title: "Older", createdAt: 1 }), thread({ id: "b", title: "Newer", createdAt: 2 })]);
    // The anchor is a full-bleed overlay, so read the row containers.
    const titles = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(titles[0]).toContain("Newer");
    expect(titles[1]).toContain("Older");
  });
});
