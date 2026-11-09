// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const projects = [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }];
const sandbox = { icon: "SquareUnlock02", label: "Runs without an OS sandbox", tone: "error" } as const;
const row = (title: string) => screen.getByRole("link", { name: new RegExp(title) }).closest("li") as HTMLElement;
const glyph = (title: string) => row(title).querySelector(`[data-row-status="${sandbox.label}"]`);

function renderWithStatus(
  threads: PluginSidebarThread[],
  marked: string[],
  { rows = [], threadDisplay = "full" }: { rows?: unknown[]; threadDisplay?: string } = {},
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    sidebarRowStatuses: Object.fromEntries(marked.map((id) => [id, sandbox])),
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false, threadDisplay }),
      listLifecycle: () => ({ rows }),
    },
  });
}

describe("row statuses from other plugins", () => {
  it.each(["full", "compact-all"])(
    "draws bb's glyph with its tone in place of a quiet status (%s)",
    async (display) => {
      renderWithStatus(
        [
          thread({ id: "unread", title: "Unread work", indicator: "unread-success", isUnread: true }),
          thread({ id: "plain", title: "Plain work" }),
          thread({ id: "settled", title: "Settled work" }),
        ],
        ["unread", "settled"],
        {
          threadDisplay: display,
          rows: [{ threadId: "settled", settledAt: 200, snoozedUntil: null, snoozedAt: null }],
        },
      );
      await screen.findByRole("link", { name: /Unread work/ });
      await waitFor(() => expect(glyph("Unread work")).not.toBeNull());
      expect(glyph("Unread work")!.getAttribute("data-row-status-tone")).toBe("error");
      // The status replaces "Unread"; the age stays beside it.
      expect(within(row("Unread work")).queryByText("Unread")).toBeNull();
      expect(glyph("Plain work")).toBeNull();

      const settled = screen.getByRole("region", { name: "Settled" });
      fireEvent.click(within(settled).getByRole("button", { name: /^Settled/ }));
      expect(glyph("Settled work")).not.toBeNull();
    },
  );

  it("gives way to live work, a failure, a raised hand, and a failed send", async () => {
    renderWithStatus(
      [
        thread({ id: "busy", title: "Busy work", indicator: "runtime", indicatorLabel: "Working" }),
        thread({ id: "failed", title: "Failed work", indicator: "unread-error" }),
        thread({ id: "asking", title: "Asking work", indicator: "waiting-for-input", hasPendingInteraction: true }),
        thread({ id: "unsent", title: "Unsent work", queuedWork: "failed" }),
      ],
      ["busy", "failed", "asking", "unsent"],
    );
    await screen.findByRole("link", { name: /Busy work/ });
    for (const [title, label] of [
      ["Busy work", /^Working/],
      ["Failed work", /^Failed$/],
      ["Asking work", /^Needs you$/],
      ["Unsent work", /^Send failed$/],
    ] as const) {
      expect(glyph(title)).toBeNull();
      expect(within(row(title)).getByText(label)).toBeDefined();
    }
  });

  it("spells out the status in the thread's hover card", async () => {
    renderWithStatus([thread({ id: "marked", title: "Marked work" })], ["marked"]);
    fireEvent.pointerMove(await screen.findByRole("link", { name: /Marked work/ }), { pointerType: "mouse" });
    const details = await screen.findByRole("dialog", { name: "Thread details" });
    expect(within(details).getByText(sandbox.label)).toBeDefined();
  });
});

describe("a running row status from another plugin", () => {
  const ci = { icon: "Loading", label: "Waiting for CI", tone: "running" } as const;
  const threads = [
    thread({ id: "waiting", title: "Waiting work", indicator: "unread-success", isUnread: true }),
    thread({ id: "sandboxed", title: "Sandboxed work" }),
    thread({ id: "failed", title: "Failed work", indicator: "unread-error" }),
    thread({ id: "tree", title: "Tree work" }),
    thread({ id: "child", title: "Child work", parentThreadId: "tree" }),
  ];
  const statuses = { waiting: ci, sandboxed: sandbox, failed: ci, child: ci };

  function renderWithStatuses(settings: Record<string, unknown>) {
    renderSlot(inbox, listProps, {
      sidebarThreads: { status: "ready", threads, projects },
      sidebarRowStatuses: statuses,
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false, ...settings }),
        listLifecycle: () => ({ rows: [] }),
      },
    });
  }

  it("moves the thread, or its parent, to Working", async () => {
    renderWithStatuses({ workingShelf: true });
    const working = await screen.findByRole("region", { name: "Working" });
    await waitFor(() => expect(within(working).getByText("Waiting work")).toBeDefined());
    expect(within(working).getByText("Tree work")).toBeDefined();
    // Another tone is not work, and a failure still needs the user.
    const active = screen.getByRole("region", { name: "Active" });
    expect(within(active).getByText("Sandboxed work")).toBeDefined();
    expect(within(active).getByText("Failed work")).toBeDefined();
  });

  it("keeps the thread compact with Compact working threads", async () => {
    renderWithStatuses({ threadDisplay: "compact-working" });
    const isCompact = (title: string) => row(title).querySelector("[data-parent-card]")!.classList.contains("h-8");
    await screen.findByRole("link", { name: /Waiting work/ });
    await waitFor(() => expect(isCompact("Waiting work")).toBe(true));
    expect(isCompact("Tree work")).toBe(true);
    expect(isCompact("Sandboxed work")).toBe(false);
    expect(isCompact("Failed work")).toBe(false);
  });
});
