// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { formatSnoozeWakeTime } from "./lifecycle";
import {
  inbox,
  SETTLED_NOTHING,
  thread,
  listProps,
  render,
  deferred,
  toastMocks,
  parkingActions,
  parkFromCard,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
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
    const pendingSnooze = deferred<{ ok: true; reclaim: typeof SETTLED_NOTHING }>();
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
    fireEvent.click(await screen.findByRole("option", { name: "1 hour" }));
    fireEvent.keyDown(snooze, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Wait refresh (5 hours)" }));
    await waitFor(() => expect(rendered.rpcCalls.filter((call) => call.method === "snooze")).toHaveLength(1));

    pendingSnooze.resolve({ ok: true, reclaim: SETTLED_NOTHING });
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Thread snoozed",
        expect.objectContaining({
          description: `Wakes ${formatSnoozeWakeTime(wakeAt)}`,
        }),
      ),
    );
    const toastOptions = toastMocks.success.mock.calls.find(([message]) => message === "Thread snoozed")![1] as {
      action: { label: string; onClick: () => void };
    };
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
    await waitFor(() =>
      expect(toastMocks.message).toHaveBeenCalledWith("Close this thread's ports?", expect.anything()),
    );
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
    const settleToast = toastMocks.success.mock.calls.find(([message]) => message === "Thread settled")![1] as {
      action: { onClick: () => void };
    };
    settleToast.action.onClick();

    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "unsettle",
        input: { threadId: "round-trip", undoToken },
      }),
    );
    const unsettleToast = toastMocks.success.mock.calls.find(([message]) => message === "Settling undone")![1] as {
      action: { label: string; onClick: () => void };
    };
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
    const wakeToast = toastMocks.success.mock.calls.find(([message]) => message === "Thread woke up")![1] as {
      action: { onClick: () => void };
    };
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
      expect(toastMocks.error).toHaveBeenCalledWith(`Could not ${action} thread`, {
        className: "bb-sidebar-toast",
        description: "database offline",
      }),
    );
    expect(rendered.navigateCalls.some((call) => call.method === "toThread" || call.method === "toCompose")).toBe(
      false,
    );
  });

  it("offers Un-settle on settled rows and Wake now on snoozed rows", async () => {
    const calls: string[] = [];
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "settled", title: "Settled row" }), thread({ id: "snoozed", title: "Snoozed row" })],
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
      expect(rendered.inspection.rpcCalls.some((call) => call.method === "listLifecycle")).toBe(true),
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
      const archive = within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive");
      expect(archive.getAttribute("data-disabled")).not.toBeNull();
      fireEvent.click(archive);
      expect(rendered.threadActionCalls).not.toContainEqual({
        key: "bb--core/archive",
        threadId: busyThread.id,
      });
    });
  }
});
