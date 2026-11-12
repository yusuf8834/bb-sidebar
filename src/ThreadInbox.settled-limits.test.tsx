// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadLimitState } from "./contract";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { renderSlot } from "./test-slot";
import { defaultSidebarSettings, inbox, listProps, loadInboxApp, thread } from "./test-inbox";
import { deferred } from "./test-fixtures";
import { LIFECYCLE_CHANNEL, RATE_LIMITS_CHANNEL } from "./realtime-channels";

await loadInboxApp();
let clock = Date.parse("2026-10-26T19:49:00Z");
beforeEach(() => {
  clock = Date.parse("2026-10-26T19:49:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

const warning: ThreadLimitState = {
  message: "You've hit your session limit · resets 5pm (America/Chicago)",
  resetsAt: Date.parse("2026-10-27T22:00:00Z"),
  timeZone: "America/Chicago",
  scheduled: null,
};
const settledRow = { threadId: "limited", settledAt: 200, snoozedUntil: null, snoozedAt: null };
const limited = (overrides: Partial<PluginSidebarThread> = {}) =>
  thread({
    id: "limited",
    title: "Limited work",
    displayTitle: "Limited work",
    status: "error",
    runtimeStatus: "error",
    ...overrides,
  });

function mount({
  threads = [limited()],
  lifecycle = () => ({ rows: [settledRow] }),
  activeThreadId = null,
}: {
  threads?: PluginSidebarThread[];
  lifecycle?: () => unknown;
  activeThreadId?: string | null;
} = {}) {
  const slot = renderSlot(
    inbox,
    { ...listProps, activeThreadId },
    {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false }),
        listLifecycle: lifecycle,
        getThreadLimits: (input: unknown) =>
          Object.fromEntries((input as { keys: string[] }).keys.map((key) => [key, warning])),
        getThreadExecutionDetails: () => null,
      },
    },
  );
  const lookups = () =>
    slot.inspection.rpcCalls.filter((call) => call.method === "getThreadLimits").map((call) => call.input);
  return { slot, lookups };
}

async function openSettled() {
  const settled = await screen.findByRole("region", { name: "Settled" });
  fireEvent.click(within(settled).getByRole("button", { name: /^Settled/ }));
  return { settled, row: await within(settled).findByRole("link", { name: /Limited work/ }) };
}

async function hover(row: HTMLElement) {
  fireEvent.pointerMove(row, { pointerType: "mouse" });
  return screen.findByRole("dialog", { name: "Thread details" });
}

describe("provider limits of settled threads", () => {
  it("skips a settled errored thread on the poll, pings and reconnects", async () => {
    const { slot, lookups } = mount();
    const { settled } = await openSettled();
    await slot.behavior.emitRealtime(RATE_LIMITS_CHANNEL, {});
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await act(async () => {});
    expect(lookups()).toEqual([]);
    expect(within(settled).queryByText("Limit reached")).toBeNull();
  });

  it("skips a child that rides in a settled parent's row", async () => {
    const { lookups } = mount({
      threads: [thread({ id: "parent", title: "Parent work" }), limited({ parentThreadId: "parent" })],
      lifecycle: () => ({ rows: [{ ...settledRow, threadId: "parent" }] }),
    });
    await screen.findByRole("region", { name: "Settled" });
    await act(async () => {});
    expect(lookups()).toEqual([]);
  });

  it("looks a settled thread up exactly once per card open, then shows its warning on the row", async () => {
    const { slot, lookups } = mount();
    const { settled, row } = await openSettled();
    await hover(row);
    await waitFor(() => expect(lookups()).toEqual([{ keys: ["limited"] }]));
    expect(await within(settled).findByText("Limit reached")).toBeDefined();
    await slot.behavior.emitRealtime(RATE_LIMITS_CHANNEL, {});
    fireEvent.keyDown(row, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
    // Reopened within 30s: the last answer is reused.
    clock += 29_000;
    await hover(row);
    await act(async () => {});
    expect(lookups()).toHaveLength(1);
    fireEvent.keyDown(row, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
    clock += 2_000;
    await hover(row);
    await waitFor(() => expect(lookups()).toHaveLength(2));
  });

  it("looks up the open settled thread once without a hover, since touch screens never open the card", async () => {
    const { lookups } = mount({ activeThreadId: "limited" });
    const settled = await screen.findByRole("region", { name: "Settled" });
    await waitFor(() => expect(lookups()).toEqual([{ keys: ["limited"] }]));
    expect(await within(settled).findByText("Limit reached")).toBeDefined();
    await act(async () => {});
    expect(lookups()).toHaveLength(1);
    // Hovering the open thread later still asks again once the answer is older than 30s.
    clock += 31_000;
    await hover(await within(settled).findByRole("link", { name: /Limited work/ }));
    await waitFor(() => expect(lookups()).toHaveLength(2));
  });

  it("makes an un-settled thread a recurring key with no extra lookup path", async () => {
    let rows = [settledRow];
    const { slot, lookups } = mount({ lifecycle: () => ({ rows }) });
    await openSettled();
    expect(lookups()).toEqual([]);
    rows = [];
    await slot.behavior.emitRealtime(LIFECYCLE_CHANNEL, {});
    await waitFor(() => expect(lookups()).toEqual([{ keys: ["limited"] }]));
    const active = await screen.findByRole("region", { name: "Active" });
    expect(await within(active).findByText("Limit reached")).toBeDefined();
    await slot.behavior.emitRealtime(RATE_LIMITS_CHANNEL, {});
    await waitFor(() => expect(lookups()).toHaveLength(2));
  });

  it("drops a looked-up warning once the thread leaves the Settled shelf", async () => {
    let rows = [settledRow];
    const { slot, lookups } = mount({ lifecycle: () => ({ rows }) });
    const { settled, row } = await openSettled();
    await hover(row);
    expect(await within(settled).findByText("Limit reached")).toBeDefined();
    fireEvent.keyDown(row, { key: "Escape" });
    rows = [];
    await slot.behavior.emitRealtime(LIFECYCLE_CHANNEL, {});
    await waitFor(() => expect(lookups()).toHaveLength(2));
    // Settled again: neither the looked-up nor the recurring answer stays behind.
    rows = [settledRow];
    await slot.behavior.emitRealtime(LIFECYCLE_CHANNEL, {});
    // The shelf stays expanded from before.
    await within(await screen.findByRole("region", { name: "Settled" })).findByRole("link", { name: /Limited work/ });
    await act(async () => {});
    expect(screen.queryByText("Limit reached")).toBeNull();
    expect(lookups()).toHaveLength(2);
  });

  it("waits for the lifecycle rows before the first recurring lookup", async () => {
    const gate = deferred<{ rows: unknown[] }>();
    const { slot, lookups } = mount({ lifecycle: () => gate.promise });
    await act(async () => {});
    await slot.behavior.emitRealtime(RATE_LIMITS_CHANNEL, {});
    expect(lookups()).toEqual([]);
    await act(async () => gate.resolve({ rows: [settledRow] }));
    await openSettled();
    expect(lookups()).toEqual([]);
  });

  it("retries a failed first lifecycle read, then starts the recurring lookups", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let fail = true;
    const { lookups } = mount({
      lifecycle: () => {
        if (fail) throw new Error("Plugin reloading");
        return { rows: [] };
      },
    });
    await screen.findByRole("region", { name: "Active" });
    await act(async () => {});
    expect(lookups()).toEqual([]);
    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() => expect(lookups()).toEqual([{ keys: ["limited"] }]));
  });
});
