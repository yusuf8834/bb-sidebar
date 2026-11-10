// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { PluginCommandContext, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, toastMocks, loadInboxApp } from "./test-inbox";
import { registerSnoozeCommands } from "./lib/snooze-commands";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const HOUR_MS = 60 * 60_000;

function paletteCommands() {
  const commands = new Map<string, PluginCommandRegistration>();
  registerSnoozeCommands({ register: (command) => commands.set(command.id, command) });
  const context = (threadId: string | null) => ({ threadId, projectId: null }) as PluginCommandContext;
  return {
    titles: () => [...commands.values()].map((command) => command.title),
    isAvailable: (id: string, threadId: string | null) => commands.get(id)!.isAvailable!(context(threadId)),
    run: (id: string, threadId: string) => commands.get(id)!.run(context(threadId)),
  };
}

function renderInbox(threads: ReturnType<typeof thread>[], rpc: Record<string, (input: unknown) => unknown>) {
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads,
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: { listLifecycle: () => ({ rows: [] }), ...rpc },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("palette snooze commands", () => {
  it("lists one self-identifying command per default preset and an unsnooze", () => {
    expect(paletteCommands().titles()).toEqual([
      "BB Sidebar: Snooze this thread for 1 hour",
      "BB Sidebar: Snooze this thread for 5 hours",
      "BB Sidebar: Snooze this thread until this evening",
      "BB Sidebar: Snooze this thread until tomorrow morning",
      "BB Sidebar: Snooze this thread until next week",
      "BB Sidebar: Unsnooze this thread",
    ]);
  });

  it("hides the commands without a thread in view, and this evening once it has passed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 17, 0));
    const commands = paletteCommands();
    expect(commands.isAvailable("snooze-1h", null)).toBe(false);
    expect(commands.isAvailable("unsnooze", null)).toBe(false);
    expect(commands.isAvailable("snooze-evening", "thr_1")).toBe(true);

    vi.setSystemTime(new Date(2026, 10, 9, 19, 0));
    expect(commands.isAvailable("snooze-evening", "thr_1")).toBe(false);
    expect(commands.isAvailable("snooze-tomorrow", "thr_1")).toBe(true);
  });

  it("snoozes the thread in view through the inbox", async () => {
    let wakeAt = 0;
    renderInbox([thread({ id: "quiet", title: "Quiet thread" })], {
      snooze: (input) => {
        wakeAt = (input as { snoozedUntil: number }).snoozedUntil;
        return { ok: true, reclaim: { closedTerminals: 0, keptTerminals: 0, stoppedRuntime: false } };
      },
    });

    const before = Date.now();
    paletteCommands().run("snooze-1h", "quiet");

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Thread snoozed", expect.anything()));
    expect(wakeAt).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(wakeAt).toBeLessThanOrEqual(Date.now() + HOUR_MS);
  });

  it("refuses to snooze a working thread, as the row menu does", async () => {
    const snooze = vi.fn();
    renderInbox([thread({ id: "busy", title: "Busy thread", status: "active", indicator: "runtime" })], { snooze });

    paletteCommands().run("snooze-1h", "busy");

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Wait until this thread stops working to snooze it",
        expect.anything(),
      ),
    );
    expect(snooze).not.toHaveBeenCalled();
  });

  it("unsnoozes only a snoozed thread", async () => {
    const unsnooze = vi.fn(() => ({ ok: true }));
    renderInbox([thread({ id: "napping", title: "Napping" }), thread({ id: "awake", title: "Awake" })], {
      listLifecycle: () => ({
        rows: [{ threadId: "napping", settledAt: null, snoozedUntil: Date.now() + HOUR_MS, snoozedAt: Date.now() }],
      }),
      unsnooze,
    });
    await screen.findByRole("region", { name: "Snoozed" });
    const commands = paletteCommands();

    commands.run("unsnooze", "awake");
    expect(toastMocks.message).toHaveBeenCalledWith("This thread is not snoozed", expect.anything());
    commands.run("unsnooze", "napping");
    await waitFor(() => expect(unsnooze).toHaveBeenCalledTimes(1));
    expect(unsnooze.mock.calls[0]).toEqual([{ threadId: "napping" }]);
  });

  it("tells the user to open the sidebar when no inbox is mounted", () => {
    paletteCommands().run("snooze-1h", "thr_1");
    expect(toastMocks.error).toHaveBeenCalledWith("Open the BB Sidebar to snooze threads", expect.anything());
  });
});
