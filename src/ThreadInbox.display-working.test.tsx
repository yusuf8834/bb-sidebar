// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import {
  defaultSidebarSettings,
  inbox,
  listProps,
  loadInboxApp,
  rowLinks,
  SETTLED_NOTHING,
  thread,
  toastMocks,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const projects = [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }];
const ci = { icon: "Loading", label: "Waiting for CI", tone: "running" } as const;
const note = { icon: "Bell", label: "Has a note" } as const;
// bb sets `indicator` from these: neither one is working by bb's rule.
const offline = { status: "active", runtimeStatus: "waiting-for-host", indicator: "none" } as const;
const unstarted = { status: "pending", runtimeStatus: "pending", indicator: "none" } as const;

function renderInbox(
  threads: PluginSidebarThread[],
  {
    rowStatuses = {},
    rows = [],
    settings = {},
    rpc = {},
  }: {
    rowStatuses?: Record<string, typeof ci | typeof note>;
    rows?: unknown[];
    settings?: Record<string, unknown>;
    rpc?: Record<string, (input: never) => unknown>;
  } = {},
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    sidebarRowStatuses: rowStatuses,
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false, ...settings }),
      listLifecycle: () => ({ rows }),
      ...rpc,
    },
  });
}

const titlesIn = (name: string) =>
  rowLinks(screen.getByRole("region", { name })).map((link) => link.getAttribute("aria-label"));
const isCompact = (title: string) =>
  screen.getByRole("link", { name: title }).closest("[data-parent-card]")!.classList.contains("h-8");
const card = (title: string) => screen.getByRole("link", { name: title }).closest("li")!;

async function menuFor(element: HTMLElement) {
  fireEvent.contextMenu(element);
  return screen.findByRole("menu", { name: "Thread actions" });
}

describe("working, for display", () => {
  it("puts a plugin's running thread on the Working shelf, and an offline or unstarted one in Active", async () => {
    renderInbox(
      [
        thread({ id: "busy", title: "Busy work", indicator: "runtime" }),
        thread({ id: "ci", title: "CI work" }),
        thread({ id: "offline", title: "Offline work", ...offline }),
        thread({ id: "unstarted", title: "Unstarted work", ...unstarted }),
        thread({ id: "noted", title: "Noted work" }),
      ],
      { rowStatuses: { ci, noted: note }, settings: { workingShelf: true } },
    );
    await screen.findByRole("link", { name: "Busy work" });
    await waitFor(() => expect(titlesIn("Working")).toEqual(["Busy work", "CI work"]));
    expect(titlesIn("Active").sort()).toEqual(["Noted work", "Offline work", "Unstarted work"]);
  });

  it("draws a plugin's running thread on one line, and not an offline or unstarted one", async () => {
    renderInbox(
      [
        thread({ id: "ci", title: "CI work" }),
        thread({ id: "offline", title: "Offline work", ...offline }),
        thread({ id: "unstarted", title: "Unstarted work", ...unstarted }),
      ],
      { rowStatuses: { ci }, settings: { threadDisplay: "compact-working", compactWorkingThreads: true } },
    );
    await screen.findByRole("link", { name: "CI work" });
    await waitFor(() => expect(isCompact("CI work")).toBe(true));
    expect(isCompact("Offline work")).toBe(false);
    expect(isCompact("Unstarted work")).toBe(false);
  });

  it("counts a child another plugin marks running in the parent's badge and keeps it in view", async () => {
    renderInbox(
      [
        thread({ id: "parent", title: "Idle parent" }),
        thread({ id: "child", title: "CI child", parentThreadId: "parent" }),
        thread({ id: "quiet", title: "Quiet parent" }),
        thread({ id: "offline-child", title: "Offline child", parentThreadId: "quiet", ...offline }),
      ],
      { rowStatuses: { child: ci } },
    );
    await screen.findByRole("link", { name: "Idle parent" });
    const badge = within(card("Idle parent")).getByRole("button", { name: /child thread/ });
    expect(badge.getAttribute("aria-label")).toBe("1 child thread, 1 working");
    expect(badge.getAttribute("data-child-status")).toBe("working");
    // Collapsed lists keep children with something to report in view.
    expect(within(card("Idle parent")).getByText("CI child")).toBeDefined();

    const quiet = within(card("Quiet parent")).getByRole("button", { name: /child thread/ });
    expect(quiet.getAttribute("aria-label")).toBe("1 child thread");
    expect(quiet.getAttribute("data-child-status")).toBeNull();
    expect(screen.queryByText("Offline child")).toBeNull();
  });

  it("treats an idle parent of a plugin's running child as a working tree", async () => {
    renderInbox(
      [
        thread({ id: "parent", title: "Idle parent" }),
        thread({ id: "child", title: "CI child", parentThreadId: "parent" }),
        thread({ id: "quiet", title: "Quiet parent" }),
        thread({ id: "offline-child", title: "Offline child", parentThreadId: "quiet", ...offline }),
      ],
      { rowStatuses: { child: ci }, settings: { workingShelf: true } },
    );
    await screen.findByRole("link", { name: "Idle parent" });
    await waitFor(() => expect(titlesIn("Working")).toEqual(["Idle parent"]));
    expect(titlesIn("Active")).toEqual(["Quiet parent"]);
  });

  // Display only: the guards keep the lifecycle signals the server shares.
  it("still offers no park action for an offline thread", async () => {
    renderInbox([thread({ id: "offline", title: "Offline work", ...offline })]);
    await screen.findByRole("link", { name: "Offline work" });
    expect(within(card("Offline work")).queryByRole("button", { name: "Settle thread" })).toBeNull();
    expect(within(card("Offline work")).queryByRole("combobox", { name: "Snooze thread" })).toBeNull();
  });
});

describe("another plugin's running status blocks shelving from the sidebar", () => {
  it("hides the card's Snooze and Settle and the menu's Snooze, Park and Settle, but keeps Archive", async () => {
    renderInbox([thread({ id: "ci", title: "CI work" }), thread({ id: "noted", title: "Noted work" })], {
      rowStatuses: { ci, noted: note },
    });
    await screen.findByRole("link", { name: "CI work" });
    expect(within(card("CI work")).queryByRole("combobox", { name: "Snooze thread" })).toBeNull();
    expect(within(card("CI work")).queryByRole("button", { name: "Settle thread" })).toBeNull();
    // A status in any other tone leaves the actions alone.
    expect(within(card("Noted work")).getByRole("combobox", { name: "Snooze thread" })).toBeDefined();
    expect(within(card("Noted work")).getByRole("button", { name: "Settle thread" })).toBeDefined();

    const menu = await menuFor(screen.getByText("CI work"));
    for (const item of ["Snooze", "Park thread", "Settle"]) expect(within(menu).queryByText(item)).toBeNull();
    expect(within(menu).getByText("Archive").getAttribute("data-disabled")).toBeNull();
  });

  it.each([
    ["parked", { parkedAt: 100 }, ["Settle", "Snooze"], "Resume"],
    ["settled", { settledAt: 100 }, ["Park thread", "Snooze"], "Un-settle"],
    ["snoozed", { snoozedUntil: Date.now() + 3_600_000, snoozedAt: 100 }, ["Park thread", "Settle"], "Wake now"],
  ] as const)("offers only the way back on a %s row", async (shelf, row, hidden, restore) => {
    renderInbox([thread({ id: "ci", title: "CI work" })], {
      rowStatuses: { ci },
      rows: [{ threadId: "ci", settledAt: null, snoozedUntil: null, snoozedAt: null, ...row }],
    });
    const region = await screen.findByRole("region", { name: shelf[0]!.toUpperCase() + shelf.slice(1) });
    fireEvent.click(within(region).getAllByRole("button")[0]!);
    const menu = await menuFor(await within(region).findByText("CI work"));
    for (const item of hidden) expect(within(menu).queryByText(item)).toBeNull();
    expect(within(menu).getByText(restore)).toBeDefined();
  });

  it.each([
    ["resume", "park", { parkedAt: 100 }, "Parked", "Resume", "Thread returned to the inbox"],
    ["unsettle", "settle", { settledAt: 100 }, "Settled", "Un-settle", "Thread returned to the inbox"],
    [
      "unsnooze",
      "snooze",
      { snoozedUntil: Date.now() + 3_600_000, snoozedAt: 100 },
      "Snoozed",
      "Wake now",
      "Thread woke up",
    ],
  ] as const)("refuses Undo after %s, which would %s it again", async (restore, redo, row, shelf, item, message) => {
    const again = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING, undoToken: "undo" }));
    renderInbox([thread({ id: "ci", title: "CI work" })], {
      rowStatuses: { ci },
      rows: [{ threadId: "ci", settledAt: null, snoozedUntil: null, snoozedAt: null, ...row }],
      rpc: { [restore]: () => ({ ok: true }), [redo]: again },
    });
    const region = await screen.findByRole("region", { name: shelf });
    fireEvent.click(within(region).getAllByRole("button")[0]!);
    fireEvent.click(within(await menuFor(await within(region).findByText("CI work"))).getByText(item));
    await waitFor(() => expect(toastMocks.success.mock.calls.some(([text]) => text === message)).toBe(true));
    const undo = toastMocks.success.mock.calls.find(([text]) => text === message)![1].action;
    act(() => undo.onClick());
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        expect.stringMatching(/^Could not/),
        expect.objectContaining({ description: "CI work is still running: Waiting for CI" }),
      ),
    );
    expect(again).not.toHaveBeenCalled();
  });

  it("refuses to settle a tree with a running child, as the server does for a working one", async () => {
    const settle = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING, undoToken: "undo" }));
    const park = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
    renderInbox(
      [
        thread({ id: "parent", title: "Parent work" }),
        thread({ id: "child", title: "CI child", parentThreadId: "parent" }),
      ],
      { rowStatuses: { child: ci }, rpc: { settle, park } },
    );
    await screen.findByRole("link", { name: "Parent work" });
    fireEvent.click(within(card("Parent work")).getByRole("button", { name: "Settle thread" }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Could not settle thread",
        expect.objectContaining({ description: "CI child is still running: Waiting for CI" }),
      ),
    );
    expect(settle).not.toHaveBeenCalled();
    // Parking files the parent's own row only, so the child does not stop it.
    fireEvent.click(within(await menuFor(screen.getByText("Parent work"))).getByText("Park thread"));
    await waitFor(() => expect(park).toHaveBeenCalledWith({ threadId: "parent" }));
  });
});
