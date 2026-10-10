// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ProjectColorsProvider, useProjectColor } from "./ProjectColors";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function Name() { return <span data-testid="name" style={useProjectColor("p1")}>Alpha</span>; }
function Probe() { return <ProjectColorsProvider enabled display="all" projectIds={["p1"]}><Name /></ProjectColorsProvider>; }
afterEach(() => { cleanup(); localStorage.clear(); });

it("reloads colors after a missed signal and reconnection", async () => {
  let colors = { p1: "#123456" };
  const slot = renderSlot({ component: Probe }, {}, { rpc: { getProjectColors: () => ({ colors }) }, realtimeConnectionState: "connected" });
  const style = () => screen.getByTestId("name").style.getPropertyValue("--bb-sidebar-project");
  await waitFor(() => expect(style()).toBe("#123456"));
  const loads = () => slot.inspection.rpcCalls.filter(c => c.method === "getProjectColors").length;
  expect(loads()).toBe(1);
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  colors = { p1: "#abcdef" };
  await slot.behavior.setRealtimeConnectionState("connected");
  await act(async () => { await Promise.resolve(); });
  expect(loads()).toBe(2);
  expect(style()).toBe("#abcdef");
  await slot.behavior.emitRealtime("project-colors", {});
  await waitFor(() => expect(style()).toBe("#abcdef"));
});

it("older color replies cannot overwrite the newest refresh", async () => {
  const older = deferred<{ colors: Record<string, string> }>();
  let loads = 0;
  const slot = renderSlot({ component: Probe }, {}, { rpc: { getProjectColors: () => ++loads === 1 ? older.promise : { colors: { p1: "#abcdef" } } } });
  await slot.behavior.emitRealtime("project-colors", {});
  await waitFor(() => expect(screen.getByTestId("name").style.getPropertyValue("--bb-sidebar-project")).toBe("#abcdef"));
  await act(async () => { older.resolve({ colors: { p1: "#123456" } }); });
  expect(screen.getByTestId("name").style.getPropertyValue("--bb-sidebar-project")).toBe("#abcdef");
});
