// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { isWorkingTree } from "./working-tree";
import { defaultSidebarSettings, inbox, listProps, loadInboxApp, thread } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const projects = [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }];

describe("a child waiting on the user", () => {
  it("keeps its tree out of Working even while a sibling still works", async () => {
    const now = Date.now();
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [
          thread({ id: "asking-tree", title: "Asking tree", updatedAt: now }),
          thread({
            id: "worker",
            title: "Worker",
            parentThreadId: "asking-tree",
            indicator: "runtime",
            updatedAt: now,
          }),
          thread({
            id: "asker",
            title: "Asker",
            parentThreadId: "worker",
            hasPendingInteraction: true,
            indicator: "waiting-for-input",
            updatedAt: now,
          }),
          thread({ id: "busy-tree", title: "Busy tree", updatedAt: now }),
          thread({ id: "busy-child", parentThreadId: "busy-tree", indicator: "runtime", updatedAt: now }),
        ],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, workingShelf: true, inactiveThreadsEnabled: false }),
        listLifecycle: () => ({ rows: [] }),
      },
    });

    const working = await screen.findByRole("region", { name: "Working" });
    await waitFor(() => expect(within(working).getByText("Busy tree")).toBeDefined());
    expect(within(working).queryByText("Asking tree")).toBeNull();
    const active = screen.getByRole("region", { name: "Active" });
    expect(within(active).getByText("Asking tree")).toBeDefined();

    // The middle row's capsule rolls up the question it holds.
    const capsule = within(active).getByRole("button", { name: /^Show 1 grandchild thread for Worker, 1 need you$/ });
    expect(capsule.getAttribute("data-child-status")).toBe("needs-you");
  });

  it("keeps an idle parent in Active instead of Inactive", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [
          thread({ id: "old-tree", title: "Old tree" }),
          thread({ id: "old-asker", parentThreadId: "old-tree", hasPendingInteraction: true }),
          thread({ id: "old-quiet", title: "Old quiet" }),
        ],
      },
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listLifecycle: () => ({ rows: [] }),
      },
    });

    const inactive = await screen.findByRole("region", { name: "Inactive" });
    expect(within(inactive).getByText(/Inactive \(1\)/)).toBeDefined();
    const active = screen.getByRole("region", { name: "Active" });
    expect(within(active).getByText("Old tree")).toBeDefined();
    expect(within(active).queryByText("Old quiet")).toBeNull();
  });

  it("brings a shelved parent back, and a snoozed one wakes", async () => {
    const now = Date.now();
    const shelved = ["snoozed", "parked", "settled"] as const;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        projects,
        threads: [
          ...shelved.flatMap((shelf) => [
            thread({ id: shelf, title: `${shelf} parent`, updatedAt: now }),
            thread({ id: `${shelf}-asker`, parentThreadId: shelf, hasPendingInteraction: true, updatedAt: now }),
          ]),
          thread({ id: "quiet-snoozed", title: "Quiet snoozed", updatedAt: now }),
          thread({ id: "quiet-child", parentThreadId: "quiet-snoozed", updatedAt: now }),
        ],
      },
      rpc: {
        getSidebarSettings: () => ({ ...defaultSidebarSettings, inactiveThreadsEnabled: false }),
        listLifecycle: () => ({
          rows: [
            { threadId: "snoozed", snoozedAt: now - 1_000, snoozedUntil: now + 3_600_000, settledAt: null },
            { threadId: "parked", parkedAt: now - 1_000, snoozedAt: null, snoozedUntil: null, settledAt: null },
            { threadId: "settled", snoozedAt: null, snoozedUntil: null, settledAt: now - 1_000 },
            { threadId: "quiet-snoozed", snoozedAt: now - 1_000, snoozedUntil: now + 3_600_000, settledAt: null },
          ],
        }),
      },
    });

    const snoozedShelf = await screen.findByRole("region", { name: "Snoozed" });
    expect(within(snoozedShelf).getByText(/Snoozed \(1\)/)).toBeDefined();
    const active = screen.getByRole("region", { name: "Active" });
    for (const shelf of shelved) {
      expect(within(active).getByText(`${shelf} parent`)).toBeDefined();
    }
    const snoozedRow = within(active).getByText("snoozed parent").closest("li")!;
    expect(within(snoozedRow).getByRole("button", { name: "Dismiss Woke marker" })).toBeDefined();
  });

  it("treats a working tree with a question anywhere in it as not working", () => {
    const parent = thread({ id: "parent" });
    const worker = thread({ id: "worker", parentThreadId: "parent", indicator: "runtime" });
    const asker = thread({ id: "asker", parentThreadId: "worker", indicator: "waiting-for-input" });
    expect(isWorkingTree(parent, [worker], new Map(), new Map())).toBe(true);
    expect(isWorkingTree(parent, [worker], new Map([["worker", [asker]]]), new Map())).toBe(false);
    const busyParent = thread({ id: "busy", indicator: "runtime" });
    const busyAsker = thread({ id: "busy-asker", parentThreadId: "busy", hasPendingInteraction: true });
    expect(isWorkingTree(busyParent, [busyAsker], new Map(), new Map())).toBe(false);
  });
});
