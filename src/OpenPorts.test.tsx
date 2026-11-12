// @vitest-environment jsdom
import { Profiler, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
const mocks = vi.hoisted(() => ({ rpc: { call: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => mocks.rpc, UrlLink: "a" }));
import { OpenPortsProvider, OpenPortsIndicator, type PortScanScope } from "./OpenPorts";
const thread = { id: "thr_a", environment: { id: "env_a" } } as PluginSidebarThread;
const snapshot = (ownerThreadId = "thr_a") => ({
  groups: [{ environmentId: "env_a", ports: [{ port: 3000, ownerThreadId }] }],
});
let visibility: DocumentVisibilityState;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  mocks.rpc.call.mockReset().mockImplementation(async () => snapshot());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const live = (...environmentIds: string[]): PortScanScope => ({ live: environmentIds, settledOnly: new Set() });
async function show(scope: PortScanScope = live("env_a")) {
  const commits = vi.fn();
  const tree = (current: PortScanScope): ReactNode => (
    <OpenPortsProvider scope={current}>
      <Profiler id="indicator" onRender={commits}>
        <OpenPortsIndicator thread={thread} />
      </Profiler>
    </OpenPortsProvider>
  );
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(tree(scope));
  });
  return Object.assign(commits, {
    rescope: async (next: PortScanScope) => {
      await act(async () => view.rerender(tree(next)));
    },
  });
}
async function tick(ms = 30_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function changeVisibility(next: DocumentVisibilityState) {
  await act(async () => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
describe("port polling", () => {
  it("does not rerender consumers for equal results, but publishes ownership changes and failures", async () => {
    const commits = await show();
    expect(screen.getByRole("img", { name: "Open ports started by this thread" })).toBeTruthy();
    const initial = commits.mock.calls.length;
    await tick();
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    expect(commits).toHaveBeenCalledTimes(initial);
    mocks.rpc.call.mockResolvedValue(snapshot("thr_b"));
    await tick();
    expect(screen.queryByRole("img")).toBeNull();
    mocks.rpc.call.mockResolvedValue(snapshot());
    await tick();
    expect(screen.getByRole("img")).toBeTruthy();
    mocks.rpc.call.mockRejectedValue(new Error("offline"));
    await tick();
    expect(screen.queryByRole("img")).toBeNull();
    const failed = commits.mock.calls.length;
    await tick();
    expect(commits).toHaveBeenCalledTimes(failed);
  });

  it("polls every 30 seconds, matching the server's port cache", async () => {
    await show();
    expect(mocks.rpc.call).toHaveBeenCalledTimes(1);
    await tick(29_999);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    await tick(29_999);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(3);
  });

  it("skips hidden startup and polling, then refreshes immediately on return", async () => {
    visibility = "hidden";
    await show();
    await tick(60_000);
    expect(mocks.rpc.call).not.toHaveBeenCalled();
    await changeVisibility("visible");
    expect(mocks.rpc.call).toHaveBeenCalledTimes(1);
    await changeVisibility("hidden");
    await tick(60_000);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(1);
    await changeVisibility("visible");
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    await tick();
    expect(mocks.rpc.call).toHaveBeenCalledTimes(3);
  });

  it("does not overlap requests across visibility changes or restart after unmount", async () => {
    let resolve!: (value: ReturnType<typeof snapshot>) => void;
    mocks.rpc.call.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await show();
    await changeVisibility("hidden");
    await changeVisibility("visible");
    await tick(60_000);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(snapshot());
    });
    await tick();
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    cleanup();
    await act(async () => {
      resolve(snapshot());
    });
    await changeVisibility("visible");
    await tick(60_000);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
  });

  it("scans nothing until the shelves are known, then only the live workspaces", async () => {
    const view = await show(null);
    await tick(60_000);
    expect(mocks.rpc.call).not.toHaveBeenCalled();
    await view.rescope(live("env_a", "env_b"));
    expect(mocks.rpc.call).toHaveBeenCalledWith("getOpenPorts", { environmentIds: ["env_a", "env_b"] });
    // A workspace joining the live set (a thread returned to Active) is scanned at once.
    await view.rescope(live("env_a", "env_b", "env_c"));
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.call).toHaveBeenLastCalledWith("getOpenPorts", { environmentIds: ["env_a", "env_b", "env_c"] });
    await view.rescope(live());
    await tick(60_000);
    expect(mocks.rpc.call).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("splits a long workspace list into calls of 500", async () => {
    await show(live(...Array.from({ length: 1001 }, (_, i) => `env_${i}`)));
    expect(mocks.rpc.call.mock.calls.map(([, input]) => input.environmentIds.length)).toEqual([500, 500, 1]);
  });

  it("marks no thread for a port it owns in another thread's workspace", async () => {
    mocks.rpc.call.mockImplementation(async () => ({
      groups: [{ environmentId: "env_other", ports: [{ port: 3000, ownerThreadId: "thr_a" }] }],
    }));
    await show(live("env_a", "env_other"));
    expect(screen.queryByRole("img")).toBeNull();
  });
});
