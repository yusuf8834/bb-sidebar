// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { ThreadRecoveryState } from "./contract";
import { renderSlot } from "./test-slot";
import { defaultSidebarSettings, inbox, listProps, loadInboxApp, thread } from "./test-inbox";

await loadInboxApp();
const now = Date.parse("2026-10-26T19:49:00Z");
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

const retry = { id: "retry_1", sendAt: now + 5 * 60_000, failed: false };
// bb's phases around provider-retry, as a scratch bb 0.50.1 reports them.
const retryBooked = { status: "error", indicator: "unread-error", queuedWork: "waiting" } as const;
const retryRunning = { status: "active", indicator: "runtime", queuedWork: "none" } as const;
const gaveUp = { status: "error", indicator: "unread-error", queuedWork: "none" } as const;

async function mount(
  overrides: Partial<PluginSidebarThread>,
  recovery: ThreadRecoveryState | null,
  { child = false }: { child?: boolean } = {},
) {
  const failed = thread({
    id: "failed",
    title: "Flaky provider",
    displayTitle: "Flaky provider",
    isUnread: true,
    parentThreadId: child ? "parent" : null,
    ...overrides,
  });
  const slot = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: child ? [thread({ id: "parent", title: "Parent work" }), failed] : [failed],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      getSidebarSettings: () => ({
        ...defaultSidebarSettings,
        inactiveThreadsEnabled: false,
        showChildThreadsWhenCollapsed: true,
      }),
      listLifecycle: () => ({ rows: [] }),
      getThreadLimits: () => ({ failed: recovery }),
      getThreadExecutionDetails: () => null,
    },
  });
  // An active thread with nothing queued is not looked up at all.
  if (failed.status === "error" || failed.queuedWork !== "none") {
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "getThreadLimits")).toBe(true));
  }
  await act(async () => {});
  return screen.getByRole("link", { name: /Flaky provider/ }).closest(child ? "[data-child-thread-row]" : "li")!;
}

describe("bb's retry of a failed turn", () => {
  it("says Retrying, not Failed, while bb's retry waits in the queue", async () => {
    const row = await mount(retryBooked, { retry });
    const label = within(row as HTMLElement).getByText("Retrying");
    expect(label.getAttribute("aria-label")).toMatch(/^bb retries this turn at \d/);
    expect(label.className).toContain("--bb-sidebar-tone-pending");
    expect(within(row as HTMLElement).queryByText("Failed")).toBeNull();
    // A retry alone is not a provider limit: no Continue, no Cancel.
    expect(row.querySelector("[data-limit-control]")).toBeNull();
  });

  it("names the retry and its time in the hover card, with bb's queued glyph", async () => {
    await mount(retryBooked, { retry });
    fireEvent.pointerMove(screen.getByRole("link", { name: /Flaky provider/ }), { pointerType: "mouse" });
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(within(card).getByText(/^Status: Retrying at \d/)).toBeDefined();
    expect(within(card).getByText(/^bb retries this turn at \d/)).toBeDefined();
    expect(within(card).queryByText(/Provider limit/)).toBeNull();
  });

  it("says Retrying on a child row too", async () => {
    const row = await mount(retryBooked, { retry }, { child: true });
    expect(within(row as HTMLElement).getByText("Retrying")).toBeDefined();
    expect(within(row as HTMLElement).queryByText("Failed")).toBeNull();
  });

  it.each([
    ["the retry runs", retryRunning],
    // A lookup answered a moment before bb sent the retry, while bb still reports it queued.
    ["a stale lookup still holds the retry", { ...retryRunning, queuedWork: "waiting" }],
  ] as const)("says Working while %s", async (_case, overrides) => {
    const row = await mount(overrides, { retry });
    expect(within(row as HTMLElement).getByText(/^Working/)).toBeDefined();
    expect(within(row as HTMLElement).queryByText("Retrying")).toBeNull();
  });

  it("says Failed once bb gives up and no retry is queued", async () => {
    const row = await mount(gaveUp, null);
    expect(within(row as HTMLElement).getByText("Failed")).toBeDefined();
    expect(within(row as HTMLElement).queryByText("Retrying")).toBeNull();
  });

  it("says Failed when the only queued item is not bb's retry", async () => {
    const row = await mount(retryBooked, null);
    expect(within(row as HTMLElement).getByText("Failed")).toBeDefined();
    expect(within(row as HTMLElement).queryByText("Retrying")).toBeNull();
  });

  it("keeps the sidebar's own scheduled Continue as it is", async () => {
    const row = await mount(retryBooked, {
      message: "Provider limit reached",
      resetsAt: now + 60 * 60_000,
      timeZone: "America/Chicago",
      scheduled: { id: "continue_1", sendAt: now + 61 * 60_000, failed: false },
      retry: null,
    });
    expect(within(row as HTMLElement).getByText(/^Scheduled · /)).toBeDefined();
    expect(within(row as HTMLElement).queryByText("Retrying")).toBeNull();
  });

  it("keeps Send failed when bb's retry itself failed to send", async () => {
    const row = await mount({ ...retryBooked, queuedWork: "failed" }, { retry: { ...retry, failed: true } });
    expect(within(row as HTMLElement).getByText("Send failed")).toBeDefined();
  });
});
