// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, deferred, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

type Rows = { rows: Array<{ threadId: string; settledAt: number | null; snoozedUntil: null; snoozedAt: null }> };

const sidebarThreads = {
  status: "ready" as const,
  threads: [thread({ id: "a", title: "Work a" }), thread({ id: "b", title: "Work b" })],
  projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
};
const settledRow = (threadId: string) => ({
  threadId,
  settledAt: Date.now(),
  settledOverride: "settled" as const,
  snoozedUntil: null,
  snoozedAt: null,
});
const activeTitles = () =>
  within(screen.getByRole("region", { name: "Active" }))
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"));

describe("lifecycle rows through bb's query cache", () => {
  it("classifies threads from the saved lifecycle rows while the server is slow", async () => {
    localStorage.setItem("bb-sidebar:lifecycle-cache:v1", JSON.stringify([settledRow("a")]));
    const slow = deferred<Rows>();
    renderSlot(inbox, listProps, {
      sidebarThreads,
      rpc: { evaluateAutoSettle: () => ({ changedThreadIds: [] }), listLifecycle: () => slow.promise },
    });
    // The first paint, before any answer: the settled thread is already off Active.
    expect(activeTitles()).toEqual(["Work b"]);
    expect(screen.getByRole("region", { name: "Settled" })).toBeDefined();
    await act(async () => slow.resolve({ rows: [settledRow("a")] }));
    expect(activeTitles()).toEqual(["Work b"]);
  });

  it("rereads when a change lands while an older lifecycle read is in flight", async () => {
    const policyPass = deferred<{ changedThreadIds: string[] }>();
    const beforeChange = deferred<Rows>();
    let reads = 0;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads,
      rpc: {
        evaluateAutoSettle: () => policyPass.promise,
        listLifecycle: () => {
          reads += 1;
          if (reads === 1) return { rows: [] };
          if (reads === 2) return beforeChange.promise;
          return { rows: [settledRow("a")] };
        },
      },
    });
    await waitFor(() => expect(activeTitles()).toEqual(["Work a", "Work b"]));
    // The mount's policy pass reports a change, so the sidebar rereads.
    policyPass.resolve({ changedThreadIds: ["b"] });
    await vi.waitFor(() => expect(reads).toBe(2));
    // A settle lands while the server is answering that read from before it.
    const settle = rendered.experimental_invalidateRpc(["lifecycle"]);
    beforeChange.resolve({ rows: [] });
    await settle;
    await waitFor(() => expect(activeTitles()).toEqual(["Work b"]));
    expect(reads).toBe(3);
  });

  it("retries a first lifecycle read the server refused until one lands", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      renderSlot(inbox, listProps, {
        sidebarThreads,
        rpc: {
          evaluateAutoSettle: () => ({ changedThreadIds: [] }),
          listLifecycle: () => {
            reads += 1;
            // A backend still reloading answers with an error, which bb's cache does not retry.
            if (reads === 1) throw new Error("plugin backend is reloading");
            return { rows: [settledRow("a")] };
          },
        },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(reads).toBe(1);
      expect(activeTitles()).toEqual(["Work a", "Work b"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      // Let the reread's answer reach React; far short of another 30-second beat.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(reads).toBe(2);
      expect(activeTitles()).toEqual(["Work b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rereads lifecycle rows after the realtime connection comes back", async () => {
    let rows: Rows["rows"] = [];
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads,
      realtimeConnectionState: "connected",
      rpc: { evaluateAutoSettle: () => ({ changedThreadIds: [] }), listLifecycle: () => ({ rows }) },
    });
    await waitFor(() => expect(activeTitles()).toEqual(["Work a", "Work b"]));
    await rendered.behavior.setRealtimeConnectionState("reconnecting");
    // Settled while the connection was down: no change signal reaches this client.
    rows = [settledRow("a")];
    await rendered.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(activeTitles()).toEqual(["Work b"]));
  });
});
