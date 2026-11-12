// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { renderSlot } from "./test-slot";
import { defaultSidebarSettings, inbox, listProps, loadInboxApp, thread } from "./test-inbox";
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

function mount() {
  let rows = [settledRow];
  let open = true;
  const getOpenPorts = vi.fn((input: unknown) => ({
    groups: (input as { environmentIds: string[] }).environmentIds
      .filter((id) => id === "env_settled" && open)
      .map((environmentId) => ({
        environmentId,
        ports: [{ port: 3000, processName: "node", pid: 1234, source: "process" as const, ownerThreadId: "settled" }],
      })),
  }));
  const stopWorkspacePort = vi.fn(() => {
    open = false;
    return { signalled: [3000], skipped: [], failed: [] };
  });
  const slot = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "live", title: "Live work", environment: environment("env_live") }),
        thread({ id: "settled", title: "Settled work", environment: environment("env_settled") }),
      ],
      projects: [],
    },
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false }),
      listLifecycle: () => ({ rows }),
      getThreadExecutionDetails: () => null,
      getOpenPorts,
      stopWorkspacePort,
    },
  });
  const scans = () => getOpenPorts.mock.calls.map(([input]) => (input as { environmentIds: string[] }).environmentIds);
  return {
    slot,
    scans,
    stopWorkspacePort,
    unsettle: () => {
      rows = [];
    },
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
});
