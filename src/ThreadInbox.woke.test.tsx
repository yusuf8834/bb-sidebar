// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  SETTLED_NOTHING,
  thread,
  listProps,
  nestedInteractiveControls,
  toastMocks,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("parking threads", () => {
  it("keeps Woke beside the current card status and preserves its controls", async () => {
    const acknowledged: string[] = [];
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem("bb-sidebar:working-since:v1", JSON.stringify({ runtime: now - 5 * 60_000 }));
    const threads = [
      thread({
        id: "pending",
        title: "Pending wake",
        indicator: "waiting-for-input",
        hasPendingInteraction: true,
      }),
      thread({
        id: "failed",
        title: "Failed wake",
        indicator: "unread-error",
        isPinned: true,
      }),
      thread({ id: "runtime", title: "Runtime wake", indicator: "runtime" }),
      thread({
        id: "idle",
        title: "Idle wake",
        updatedAt: now - 31 * 60_000,
      }),
    ];
    let lifecycleRows = threads.map((candidate) => ({
      threadId: candidate.id,
      settledAt: null,
      snoozedUntil: candidate.id === "pending" ? now + 60_000 : now - 1,
      snoozedAt: now - 60_000,
    }));
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "A very long project name", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: lifecycleRows }),
        acknowledgeWake: (input) => {
          const threadId = (input as { threadId: string }).threadId;
          acknowledged.push(threadId);
          lifecycleRows = lifecycleRows.filter((row) => row.threadId !== threadId);
          return { ok: true };
        },
      },
    });

    const expected = [
      ["Pending wake", "Needs you"],
      ["Failed wake", "Failed"],
      ["Runtime wake", "Working · 5m"],
      ["Idle wake", "31m"],
    ] as const;
    for (const [title, status] of expected) {
      const row = (await screen.findByText(title)).closest("li")!;
      // The row shows before the lifecycle rows that mark it Woke arrive.
      expect(await within(row).findByRole("button", { name: "Dismiss Woke marker" })).toBeDefined();
      expect(within(row).getByText(status)).toBeDefined();
    }

    const pendingRow = screen.getByText("Pending wake").closest("li")!;
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Dismiss Woke marker" }));
    await waitFor(() => expect(acknowledged).toEqual(["pending"]));
    await rendered.experimental_invalidateRpc(["lifecycle"]);
    await waitFor(() =>
      expect(
        within(screen.getByText("Pending wake").closest("li")!).queryByRole("button", { name: "Dismiss Woke marker" }),
      ).toBeNull(),
    );
    expect(within(screen.getByText("Pending wake").closest("li")!).getByText("Needs you")).toBeDefined();
    expect(rendered.navigateCalls.some((call) => call.method === "toThread")).toBe(false);

    const failedRow = screen.getByText("Failed wake").closest("li")!;
    fireEvent.click(within(failedRow).getByRole("button", { name: "Unpin Failed wake" }));
    await waitFor(() =>
      expect(rendered.sdkCalls).toContainEqual({ method: "threads.unpin", args: [{ threadId: "failed" }] }),
    );
    expect(acknowledged).toEqual(["pending"]);
    expect(within(failedRow).getByText("Failed")).toBeDefined();

    fireEvent.click(within(failedRow).getByRole("link", { name: "Failed wake" }));
    await waitFor(() => expect(acknowledged).toEqual(["pending", "failed"]));
    expect(rendered.linkCalls).toContainEqual({ href: "/projects/proj_1/threads/failed", split: false });
  });

  // Dismissing the marker is a correction, not navigation: the row stays put
  // with its real status, and nothing opens.
  it("dismisses the Woke marker without opening or navigating", async () => {
    const acknowledged: string[] = [];
    let navigated = 0;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    let lifecycleRows = [
      {
        threadId: "woke",
        settledAt: null,
        snoozedUntil: now - 1,
        snoozedAt: now - 60_000,
      },
    ];
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({
              id: "woke",
              title: "Woke work",
              indicator: "unread-error",
              indicatorLabel: "Unread thread failed",
              updatedAt: now,
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: lifecycleRows }),
          acknowledgeWake: (input) => {
            acknowledged.push((input as { threadId: string }).threadId);
            lifecycleRows = [];
            return { ok: true };
          },
        },
      },
    );

    const row = (await screen.findByText("Woke work")).closest("li")!;
    const dismiss = await within(row).findByRole("button", {
      name: "Dismiss Woke marker",
    });
    expect(within(row).getByText("Failed")).toBeDefined();
    // The card's navigation anchor is a sibling of the controls, never their
    // ancestor, so no control ends up inside another control.
    expect(dismiss.closest("a")).toBeNull();
    expect(nestedInteractiveControls(row)).toEqual([]);

    fireEvent.click(dismiss);
    await waitFor(() => expect(acknowledged).toEqual(["woke"]));
    expect(navigated).toBe(0);
    expect([
      ...rendered.navigateCalls,
      ...rendered.linkCalls,
      ...rendered.sdkCalls,
      ...rendered.splitSourceCalls,
      ...rendered.threadActionCalls,
    ]).toEqual([]);

    await rendered.experimental_invalidateRpc(["lifecycle"]);
    const settled = () => screen.getByText("Woke work").closest("li")!;
    await waitFor(() =>
      expect(
        within(settled()).queryByRole("button", {
          name: "Dismiss Woke marker",
        }),
      ).toBeNull(),
    );
    expect(within(settled()).getByText("Failed")).toBeDefined();
    expect(navigated).toBe(0);
  });
});
it("keeps parked threads parked when opened and offers Resume with Undo", async () => {
  const resume = vi.fn(() => ({ ok: true }));
  const park = vi.fn(() => ({ ok: true, reclaim: SETTLED_NOTHING }));
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [thread({ id: "waiting", title: "Awaiting review", isPinned: true })],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      listLifecycle: () => ({
        rows: [
          {
            threadId: "waiting",
            parkedAt: Date.now() - 5 * 86400000,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
          },
        ],
      }),
      resume,
      park,
    },
  });
  const shelf = await screen.findByRole("region", { name: "Parked" });
  fireEvent.click(within(shelf).getByRole("button"));
  expect(within(shelf).getByText("Waiting 5d")).toBeDefined();
  fireEvent.click(within(shelf).getByRole("link", { name: "bb · Awaiting review" }));
  expect(resume).not.toHaveBeenCalled();
  expect(rendered.linkCalls).toContainEqual({ href: "/projects/proj_1/threads/waiting", split: false });
  fireEvent.click(within(shelf).getByRole("button", { name: "Resume thread" }));
  await waitFor(() => expect(resume).toHaveBeenCalled());
  const toast = toastMocks.success.mock.calls.find(([message]) => message === "Thread returned to the inbox");
  expect(toast).toBeDefined();
  act(() => toast![1].action.onClick());
  await waitFor(() => expect(park).toHaveBeenCalled());
});
