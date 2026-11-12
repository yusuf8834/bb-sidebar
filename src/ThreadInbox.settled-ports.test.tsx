// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { renderSlot } from "./test-slot";
import {
  defaultSidebarSettings,
  inbox,
  listProps,
  loadInboxApp,
  SETTLED_NOTHING,
  thread,
  toastMocks,
} from "./test-inbox";
import { LIFECYCLE_CHANNEL } from "./realtime-channels";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const environment = (id: string): PluginSidebarThread["environment"] => ({
  id,
  name: null,
  branchName: "main",
  workspaceDisplayKind: "other",
  path: null,
  isWorktree: null,
  providerId: null,
});
const settledRow = { threadId: "settled", settledAt: 200, snoozedUntil: null, snoozedAt: null };
const PLUG = "Open ports started by this thread";

type Row = typeof settledRow;

function mount({
  open: openIds = ["env_settled"],
  rows: initialRows = [settledRow],
  extra = [],
  owner,
}: {
  open?: string[];
  rows?: Row[];
  extra?: PluginSidebarThread[];
  owner?: string;
} = {}) {
  let rows = initialRows;
  const open = new Set(openIds);
  // A workspace's port belongs to `owner`, or to the thread named after it: env_settled's to "settled".
  const getOpenPorts = vi.fn((input: unknown) => ({
    groups: (input as { environmentIds: string[] }).environmentIds
      .filter((id) => open.has(id))
      .map((environmentId) => ({
        environmentId,
        ports: [
          {
            port: 3000,
            processName: "node",
            pid: 1234,
            source: "process" as const,
            ownerThreadId: owner ?? environmentId.slice("env_".length),
          },
        ],
      })),
  }));
  const stopWorkspacePort = vi.fn(() => {
    open.delete("env_settled");
    return { signalled: [3000], skipped: [], failed: [] };
  });
  const closeThreadPorts = vi.fn(() => {
    open.clear();
    return { signalled: [3000], skipped: [], failed: [] };
  });
  const slot = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "live", title: "Live work", environment: environment("env_live") }),
        thread({ id: "settled", title: "Settled work", environment: environment("env_settled") }),
        ...extra,
      ],
      projects: [],
    },
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false }),
      listLifecycle: () => ({ rows }),
      getThreadExecutionDetails: () => null,
      getOpenPorts,
      stopWorkspacePort,
      settle: (input: unknown) => {
        rows = [...rows, { ...settledRow, threadId: (input as { threadId: string }).threadId }];
        return { ok: true, reclaim: SETTLED_NOTHING };
      },
      getThreadPorts: () => ({ ports: [{ port: 3000, pid: 1234 }] }),
      closeThreadPorts,
      previewSettledCleanup: () => ({
        token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
        threads: [{ threadId: "settled", title: "Settled work", terminalCount: 0, ports: [3000] }],
        skipped: [],
      }),
      cleanSettled: () => {
        open.delete("env_settled");
        return {
          closedTerminals: 0,
          signalledPorts: [{ threadId: "settled", port: 3000 }],
          remainingPorts: [],
          skipped: [],
          failed: [],
        };
      },
    },
  });
  const scans = () => getOpenPorts.mock.calls.map(([input]) => (input as { environmentIds: string[] }).environmentIds);
  return {
    slot,
    scans,
    scansOf: (environmentId: string) => scans().filter((ids) => ids.includes(environmentId)).length,
    stopWorkspacePort,
    closeThreadPorts,
    unsettle: () => {
      rows = [];
    },
  };
}

// The Clean dialog is modal, so the rows behind it are aria-hidden while it is open.
const plugOf = (shelf: HTMLElement, title: string) =>
  within(within(shelf).getByRole("link", { name: title, hidden: true }).closest("li")!).queryByRole("img", {
    name: PLUG,
    hidden: true,
  });
const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Settles a row from its menu and answers "Close ports" on the prompt that follows. */
async function settleAndClosePorts(slot: ReturnType<typeof mount>["slot"], title: string) {
  const active = await screen.findByRole("region", { name: "Active" });
  const row = within(active).getByRole("link", { name: title }).closest("li")!;
  fireEvent.click(within(row).getByLabelText("Settle thread"));
  await waitFor(() => expect(toastMocks.message).toHaveBeenCalledWith("Close this thread's ports?", expect.anything()));
  await slot.behavior.emitRealtime(LIFECYCLE_CHANNEL, {});
  return async () => {
    const options = toastMocks.message.mock.calls
      .filter(([message]) => message === "Close this thread's ports?")
      .at(-1)![1];
    await act(async () => options.action.onClick());
  };
}

async function settledRowLink() {
  const settled = await screen.findByRole("region", { name: "Settled" });
  fireEvent.click(within(settled).getByRole("button", { name: /^Settled/ }));
  return { settled, row: await within(settled).findByRole("link", { name: "Settled work" }) };
}

describe("open ports of settled threads", () => {
  it("polls only live workspaces and scans a settled one once per card open", async () => {
    const { scans } = mount();
    const { settled, row } = await settledRowLink();
    await waitFor(() => expect(scans()).toEqual([["env_live"]]));
    expect(within(settled).queryByRole("img", { name: PLUG })).toBeNull();
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const details = await screen.findByRole("dialog", { name: "Thread details" });
    expect(await within(details).findByRole("button", { name: /Workspace ports \(1\)/ })).toBeDefined();
    expect(scans()).toEqual([["env_live"], ["env_settled"]]);
    expect(within(settled).getByRole("img", { name: PLUG })).toBeDefined();
    await act(async () => {});
    expect(scans()).toHaveLength(2);
  });

  it("looks a settled workspace up again after stopping one of its ports", async () => {
    const { scans, stopWorkspacePort } = mount();
    const { settled, row } = await settledRowLink();
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const details = await screen.findByRole("dialog", { name: "Thread details" });
    fireEvent.click(await within(details).findByRole("button", { name: /Workspace ports \(1\)/ }));
    fireEvent.click(within(details).getByRole("button", { name: "Stop process on port 3000" }));
    fireEvent.click(within(details).getByRole("button", { name: "Confirm stopping PID 1234 on port 3000" }));
    await waitFor(() =>
      expect(stopWorkspacePort).toHaveBeenCalledWith({ threadId: "settled", port: { port: 3000, pid: 1234 } }),
    );
    await waitFor(() => expect(scans().filter((ids) => ids[0] === "env_settled")).toHaveLength(2));
    await waitFor(() => expect(details.textContent).not.toContain("Workspace ports"));
    expect(within(settled).queryByRole("img", { name: PLUG })).toBeNull();
    expect(scans().every((ids) => !ids.includes("env_live") || !ids.includes("env_settled"))).toBe(true);
  });

  it("adds a workspace to the poll when its thread returns to Active", async () => {
    const { slot, scans, unsettle } = mount();
    await settledRowLink();
    unsettle();
    await slot.behavior.emitRealtime(LIFECYCLE_CHANNEL, {});
    await waitFor(() => expect(scans().at(-1)).toEqual(["env_live", "env_settled"]));
    const active = await screen.findByRole("region", { name: "Active" });
    expect(await within(active).findByRole("img", { name: PLUG })).toBeDefined();
  });
  it("drops the plug Clean closed without a hover, and checks only that workspace once more", async () => {
    const { scansOf } = mount({
      open: ["env_settled", "env_idle"],
      rows: [settledRow, { ...settledRow, threadId: "idle" }],
      extra: [thread({ id: "idle", title: "Idle work", environment: environment("env_idle") })],
    });
    const { settled, row } = await settledRowLink();
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    await waitFor(() => expect(plugOf(settled, "Settled work")).not.toBeNull());
    fireEvent.pointerMove(within(settled).getByRole("link", { name: "Idle work" }), { pointerType: "mouse" });
    await waitFor(() => expect(plugOf(settled, "Idle work")).not.toBeNull());
    fireEvent.click(within(settled).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Clean resources" }));
    await waitFor(() => expect(plugOf(settled, "Settled work")).toBeNull());
    expect(scansOf("env_settled")).toBe(1);
    await waitFor(() => expect(scansOf("env_settled")).toBe(2));
    await pause(1_500);
    expect(scansOf("env_settled")).toBe(2);
    expect(scansOf("env_idle")).toBe(1);
    expect(plugOf(settled, "Settled work")).toBeNull();
    expect(plugOf(settled, "Idle work")).not.toBeNull();
  });

  it("drops a settled row's plug after the settle prompt closes its ports, and checks once more", async () => {
    const { slot, scansOf, closeThreadPorts } = mount({
      open: ["env_fresh"],
      rows: [],
      extra: [thread({ id: "fresh", title: "Fresh work", environment: environment("env_fresh") })],
    });
    const active = await screen.findByRole("region", { name: "Active" });
    await waitFor(() => expect(plugOf(active, "Fresh work")).not.toBeNull());
    const closePorts = await settleAndClosePorts(slot, "Fresh work");
    const settled = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(settled).getByRole("button", { name: /^Settled/ }));
    fireEvent.pointerMove(await within(settled).findByRole("link", { name: "Fresh work" }), { pointerType: "mouse" });
    await waitFor(() => expect(plugOf(settled, "Fresh work")).not.toBeNull());
    const before = scansOf("env_fresh");
    await closePorts();
    expect(closeThreadPorts).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(plugOf(settled, "Fresh work")).toBeNull());
    expect(scansOf("env_fresh")).toBe(before);
    await waitFor(() => expect(scansOf("env_fresh")).toBe(before + 1));
    await pause(1_500);
    expect(scansOf("env_fresh")).toBe(before + 1);
    expect(plugOf(settled, "Fresh work")).toBeNull();
  });

  it("rescans a workspace shared with a live thread soon after the settle prompt closes its ports", async () => {
    const { slot, scansOf } = mount({
      open: ["env_live"],
      rows: [],
      owner: "shared",
      extra: [thread({ id: "shared", title: "Shared work", environment: environment("env_live") })],
    });
    const active = await screen.findByRole("region", { name: "Active" });
    await waitFor(() => expect(plugOf(active, "Shared work")).not.toBeNull());
    const closePorts = await settleAndClosePorts(slot, "Shared work");
    const settled = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(settled).getByRole("button", { name: /^Settled/ }));
    await waitFor(() => expect(plugOf(settled, "Shared work")).not.toBeNull());
    const before = scansOf("env_live");
    await closePorts();
    await waitFor(() => expect(plugOf(settled, "Shared work")).toBeNull());
    expect(scansOf("env_live")).toBe(before + 1);
    await pause(1_500);
    expect(scansOf("env_live")).toBe(before + 1);
  });
});
