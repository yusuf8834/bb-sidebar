// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { PluginCommandContext, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, toastMocks, loadInboxApp } from "./test-inbox";
import { registerSnoozeCommands, type SnoozeCommandRequest } from "./lib/snooze-commands";
import { BROWSER_EVENTS } from "./lib/browser-events";
import { DEFAULT_SNOOZE_PRESET_CONFIG, parseConfiguredSnoozePresets, resolveConfiguredSnoozePreset } from "./lifecycle";

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

  it("takes each wake time from the default snooze presets", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 12, 0));
    const requests: SnoozeCommandRequest[] = [];
    const capture = (event: Event) => {
      event.preventDefault();
      requests.push((event as CustomEvent<SnoozeCommandRequest>).detail);
    };
    window.addEventListener(BROWSER_EVENTS.snoozeCommand, capture);
    const commands = paletteCommands();
    for (const id of ["snooze-1h", "snooze-5h", "snooze-evening", "snooze-tomorrow", "snooze-next-week"]) {
      commands.run(id, "thr_1");
    }
    window.removeEventListener(BROWSER_EVENTS.snoozeCommand, capture);

    const defaults = parseConfiguredSnoozePresets(DEFAULT_SNOOZE_PRESET_CONFIG);
    expect(requests).toEqual(
      defaults.map((preset) => ({
        kind: "snooze",
        threadId: "thr_1",
        snoozedUntil: resolveConfiguredSnoozePreset(preset),
      })),
    );
    expect(requests[1]).toMatchObject({ snoozedUntil: Date.now() + 5 * HOUR_MS });
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

  it("refuses to snooze a thread another plugin marks as running, as the shelve guard does", async () => {
    const snooze = vi.fn((_input: unknown) => ({
      ok: true,
      reclaim: { closedTerminals: 0, keptTerminals: 0, stoppedRuntime: false },
    }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "ci", title: "CI work" }), thread({ id: "free", title: "Free work" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      sidebarRowStatuses: { ci: { icon: "Loading", label: "Waiting for CI", tone: "running" } },
      rpc: { listLifecycle: () => ({ rows: [] }), snooze },
    });
    await screen.findByRole("link", { name: "CI work" });
    const commands = paletteCommands();

    commands.run("snooze-1h", "ci");
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Could not snooze thread",
        expect.objectContaining({ description: "CI work is still running: Waiting for CI" }),
      ),
    );
    expect(snooze).not.toHaveBeenCalled();

    // The same command on a thread without that status goes through.
    commands.run("snooze-1h", "free");
    await waitFor(() => expect(snooze).toHaveBeenCalledTimes(1));
    expect(snooze.mock.calls[0]![0]).toMatchObject({ threadId: "free" });
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
