// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { usePinnedReorder } from "./usePinnedReorder";
import { renderSlot } from "./test-slot";
import {
  inbox,
  thread,
  listProps,
  render,
  loadInboxApp,
  rowLinks,
  pinnedOrderResponse,
  pinnedReorders,
  toastMocks,
  startDrag,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("keeps a separate collapsible Pinned shelf above Active", () => {
    render([thread({ id: "a", title: "Plain" }), thread({ id: "b", title: "Stuck", isPinned: true })]);

    const active = screen.getByRole("region", { name: "Active" });
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(pinned.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(active).queryByText("Inbox")).toBeNull();
    expect(within(active).getByText("Plain")).toBeDefined();
    expect(within(active).queryByText("Stuck")).toBeNull();
    expect(within(pinned).getByText("Stuck")).toBeDefined();
    fireEvent.click(within(pinned).getByRole("button", { expanded: true }));
    expect(within(pinned).getByText("Pinned (1)")).toBeDefined();
    expect(within(pinned).queryByText("Stuck")).toBeNull();
    expect(within(active).getByText("Plain")).toBeDefined();
  });

  it("keeps pinned threads in the host's persisted order", () => {
    render([
      thread({ id: "first", title: "First pin", isPinned: true, createdAt: 1 }),
      thread({ id: "second", title: "Second pin", isPinned: true, createdAt: 999 }),
    ]);
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("First pin"), expect.stringContaining("Second pin")]);
  });

  it("reorders pinned threads with the keyboard and persists the neighbors", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
      sdk: {
        threads: {
          reorderPinned: async (input) => {
            reorderInput = input;
            return pinnedOrderResponse(["b", "a", "c"]);
          },
        },
      },
    });

    const pinB = await screen.findByRole("link", { name: "Pin B" });
    fireEvent.keyDown(pinB, { key: "ArrowUp" });
    expect(reorderInput).toBeNull();
    fireEvent.keyDown(pinB, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "b",
        previousThreadId: null,
        nextThreadId: "a",
      }),
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Pin B"), expect.stringContaining("Pin A"), expect.stringContaining("Pin C")]);
  });

  it.each([false, true])(
    "skips provisional null pin keys and retains eligible child roots: child=%s",
    async (withChild) => {
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Confirmed A", isPinned: true, pinnedAt: 1, pinSortKey: "A" }),
            thread({ id: "b", title: "Confirmed B", isPinned: true, pinnedAt: 2, pinSortKey: "C" }),
            thread({ id: "pending", title: "Provisional pin", isPinned: true, pinnedAt: 3, pinSortKey: null }),
            ...(withChild
              ? [
                  thread({
                    id: "child",
                    title: "Keyed child",
                    parentThreadId: "pending",
                    isPinned: true,
                    pinnedAt: 4,
                    pinSortKey: "D",
                  }),
                ]
              : []),
          ],
          projects: [],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
        },
        sdk: {
          threads: {
            reorderPinned: async ({ threadId, previousThreadId, nextThreadId }) => {
              // Canonical BB excludes null-key rows from both moving roots and neighbours.
              if ([threadId, previousThreadId, nextThreadId].includes("pending")) throw new Error("stale_neighbor");
              return pinnedOrderResponse(["b", "a", ...(withChild ? ["child"] : []), "pending"]);
            },
          },
        },
      });
      const card = await screen.findByRole("link", { name: "Confirmed A" });
      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
      await waitFor(() =>
        expect(pinnedReorders(rendered)[0]).toEqual({
          threadId: "a",
          previousThreadId: "b",
          nextThreadId: withChild ? "child" : null,
        }),
      );
      await waitFor(() =>
        expect(rowLinks(screen.getByRole("region", { name: "Pinned" }))[0]!.getAttribute("aria-label")).toBe(
          "Confirmed B",
        ),
      );
      const pending = screen.getByRole("link", { name: "Provisional pin" });
      expect(pending.getAttribute("aria-keyshortcuts")).toBeNull();
      fireEvent.keyDown(pending, { key: "ArrowUp", altKey: true });
      expect(pinnedReorders(rendered)).toHaveLength(1);
    },
  );

  it("sorts pins across projects before choosing reorder neighbors", async () => {
    let reorderInput: unknown = null;
    const pin = (id: string, key: string, projectId: string) => ({
      ...thread({ id, title: `Pin ${id.toUpperCase()}`, isPinned: true, projectId }),
      pinSortKey: key,
    });
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        // The SDK flattens project groups, not the global pinned order.
        threads: [pin("c", "c", "proj_1"), pin("a", "a", "proj_2"), pin("b", "b", "proj_2")],
        projects: [
          { id: "proj_1", name: "One", isPersonal: false, href: "", settingsHref: "" },
          { id: "proj_2", name: "Two", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
      sdk: {
        threads: {
          reorderPinned: async (input) => {
            reorderInput = input;
            return pinnedOrderResponse(["a", "c", "b"]);
          },
        },
      },
    });
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    expect(
      within(pinned)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Pin A"), expect.stringContaining("Pin B"), expect.stringContaining("Pin C")]);
    fireEvent.keyDown(screen.getByRole("link", { name: "Pin C" }), { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "c",
        previousThreadId: "a",
        nextThreadId: "b",
      }),
    );
    await waitFor(() =>
      expect(
        within(pinned)
          .getAllByRole("listitem")
          .map((row) => row.textContent),
      ).toEqual([expect.stringContaining("Pin A"), expect.stringContaining("Pin C"), expect.stringContaining("Pin B")]),
    );
  });

  it("allows a pinned child of an unpinned parent to anchor a reorder", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "child", title: "Pinned child", parentThreadId: "unpinned-parent", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
      sdk: {
        threads: {
          reorderPinned: async (input) => {
            reorderInput = input;
            return pinnedOrderResponse(["a", "child", "c", "b"]);
          },
        },
      },
    });
    fireEvent.keyDown(await screen.findByRole("link", { name: "Pin C" }), { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "c",
        previousThreadId: "child",
        nextThreadId: "b",
      }),
    );
  });

  it("never sends a pinned child thread as a reorder neighbor", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          // Listed inside A's row, but still in bb's pinned order.
          thread({
            id: "child",
            title: "Pinned child",
            parentThreadId: "a",
            isPinned: true,
          }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
      sdk: {
        threads: {
          reorderPinned: async (input) => {
            reorderInput = input;
            return pinnedOrderResponse(["a", "c", "child", "b"]);
          },
        },
      },
    });

    const pinC = await screen.findByRole("link", { name: "Pin C" });
    fireEvent.keyDown(pinC, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "c",
        previousThreadId: "a",
        nextThreadId: "b",
      }),
    );
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Pin A"), expect.stringContaining("Pin C"), expect.stringContaining("Pin B")]);
  });

  it("reorders by dragging the card and exposes no grip control", async () => {
    let reorderInput: unknown = null;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
          thread({ id: "c", title: "Pin C", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
      sdk: {
        threads: {
          reorderPinned: async (input) => {
            reorderInput = input;
            return pinnedOrderResponse(["b", "a", "c"]);
          },
        },
      },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
    expect(card.draggable).toBe(false);
    expect(screen.queryByRole("button", { name: /Reorder Pin A/ })).toBeNull();
    expect(card.dataset.sidebarThreadId).toBe("a");
    const drag = startDrag(card, target);
    const list = card.closest("ul")!;
    expect(list.hasAttribute("data-drag-preview")).toBe(true);
    expect(card.closest("[data-drag-visual]")).not.toBeNull();
    drag.drop();
    expect(list.hasAttribute("data-drag-preview")).toBe(false);
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "a",
        previousThreadId: "b",
        nextThreadId: "c",
      }),
    );
  });

  it("announces the new position after a keyboard reorder", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
      },
      sdk: { threads: { reorderPinned: async () => pinnedOrderResponse(["b", "a"]) } },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    expect(screen.getByText("Pin A moved to 2 of 2 in Pinned")).toBeDefined();

    // The row is last now, so the same key is a no-op — and silence would leave
    // a keyboard user unsure whether the press registered at all.
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Pinned" })).getAllByRole("listitem")[0]!.textContent).toContain(
        "Pin B",
      ),
    );
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(screen.getByText("Pin A is already last in Pinned")).toBeDefined());
  });
});

describe("usePinnedReorder", () => {
  const pin = (id: string, pinSortKey: string) => thread({ id, title: `Pin ${id}`, isPinned: true, pinSortKey });
  const base = [pin("a", "a"), pin("b", "b"), pin("c", "c")];
  function PinnedOrder({ pinned }: { pinned: PluginSidebarThread[] }) {
    const { ids, reorder } = usePinnedReorder(pinned);
    return (
      <>
        <ol aria-label="Pinned order">
          {ids.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ol>
        <button
          type="button"
          onClick={() => void reorder(["b", "a", ...ids.filter((id) => id !== "a" && id !== "b")], "b")}
        >
          Move b up
        </button>
      </>
    );
  }
  const order = () =>
    within(screen.getByRole("list", { name: "Pinned order" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);

  it("saves through bb's threads.reorderPinned and keeps only the rows bb still has pinned", async () => {
    const pinned = [...base, pin("x", "x")];
    const rendered = renderSlot(
      { component: PinnedOrder },
      { pinned },
      {
        sdk: {
          threads: {
            // bb unpinned x elsewhere; its stale row must not take bb's place for it.
            reorderPinned: async () => {
              const rows = pinnedOrderResponse(["x", "b", "a", "c"]);
              rows[0]!.pinnedAt = null;
              return rows;
            },
          },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Move b up" }));
    await waitFor(() =>
      expect(pinnedReorders(rendered)).toEqual([{ threadId: "b", previousThreadId: null, nextThreadId: "a" }]),
    );
    await waitFor(() => expect(order()).toEqual(["b", "a", "c", "x"]));
    expect(rendered.rpcCalls).toEqual([]);
  });

  it("rolls back and reports a reorder bb rejects", async () => {
    renderSlot(
      { component: PinnedOrder },
      { pinned: base },
      {
        sdk: {
          threads: {
            reorderPinned: async () => {
              throw new Error("HTTP 404: Thread not found");
            },
          },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Move b up" }));
    expect(order()).toEqual(["b", "a", "c"]);
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not reorder pinned thread", {
        className: "bb-sidebar-toast",
        description: "Thread not found",
      }),
    );
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("keeps the saved order until bb reports a newer one, then follows bb", async () => {
    const rendered = renderSlot(
      { component: PinnedOrder },
      { pinned: base },
      { sdk: { threads: { reorderPinned: async () => pinnedOrderResponse(["b", "a", "c"]) } } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Move b up" }));
    await waitFor(() => expect(pinnedReorders(rendered)).toHaveLength(1));
    // The live rows still hold the old keys; the saved order stays.
    await waitFor(() => expect(order()).toEqual(["b", "a", "c"]));

    // Another client moves c to the top: bb's order wins over the saved one.
    rendered.rerender(<PinnedOrder pinned={[pin("a", "m"), pin("b", "n"), pin("c", "a")]} />);
    await waitFor(() => expect(order()).toEqual(["c", "a", "b"]));
  });
});
