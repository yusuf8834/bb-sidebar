// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { ProjectColorsProvider, useProjectColor } from "./ProjectColors";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function Name() {
  return (
    <span data-testid="name" style={useProjectColor("p1")}>
      Alpha
    </span>
  );
}
function Probe() {
  return (
    <ProjectColorsProvider enabled display="all" projectIds={["p1"]}>
      <Name />
    </ProjectColorsProvider>
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("reloads colors after a missed signal and reconnection", async () => {
  let colors = { p1: "#123456" };
  const slot = renderSlot(
    { component: Probe },
    {},
    { rpc: { getProjectColors: () => ({ colors }) }, realtimeConnectionState: "connected" },
  );
  const style = () => screen.getByTestId("name").style.getPropertyValue("--bb-sidebar-project");
  await waitFor(() => expect(style()).toBe("#123456"));
  const loads = () => slot.inspection.rpcCalls.filter((c) => c.method === "getProjectColors").length;
  expect(loads()).toBe(1);
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  colors = { p1: "#abcdef" };
  await slot.behavior.setRealtimeConnectionState("connected");
  await act(async () => {
    await Promise.resolve();
  });
  expect(loads()).toBe(2);
  await waitFor(() => expect(style()).toBe("#abcdef"));
  colors = { p1: "#fedcba" };
  await slot.behavior.experimental_invalidateRpc(["project-colors"]);
  await waitFor(() => expect(style()).toBe("#fedcba"));
});

it("a change invalidated while a color read is in flight rereads instead of keeping the older reply", async () => {
  const older = deferred<{ colors: Record<string, string> }>();
  let loads = 0;
  const slot = renderSlot(
    { component: Probe },
    {},
    { rpc: { getProjectColors: () => (++loads === 1 ? older.promise : { colors: { p1: "#abcdef" } }) } },
  );
  const style = () => screen.getByTestId("name").style.getPropertyValue("--bb-sidebar-project");
  // bb keeps one read in flight per query: the change waits for it, then rereads.
  const invalidated = slot.behavior.experimental_invalidateRpc(["project-colors"]);
  older.resolve({ colors: { p1: "#123456" } });
  await invalidated;
  await waitFor(() => expect(style()).toBe("#abcdef"));
  expect(loads).toBe(2);
});
