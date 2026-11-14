// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  defaultSidebarSettings,
  thread,
  listProps,
  deferred,
  loadInboxApp,
  rowLinks,
  pinnedOrderResponse,
  pinnedReorders,
  startDrag,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("retains attention root across reorder", async () => {
    window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ pinned: true }));
    const pending = deferred<ReturnType<typeof pinnedOrderResponse>>();
    let reorderInput: unknown = null;
    const rendered = renderSlot(
      inbox,
      { ...listProps, activeThreadId: null },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "attention-root", title: "Attention root", isPinned: true }),
            thread({ id: "idle-root", title: "Idle root", isPinned: true }),
            thread({
              id: "attention-child",
              title: "Attention child",
              parentThreadId: "attention-root",
              indicator: "waiting-for-input",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
        },
        sdk: {
          threads: {
            reorderPinned: (input) => {
              reorderInput = input;
              return pending.promise;
            },
          },
        },
      },
    );
    await waitFor(() => {
      expect(rendered.rpcCalls.some((call) => call.method === "getSidebarSettings")).toBe(true);
      expect(rendered.rpcCalls.some((call) => call.method === "listLifecycle")).toBe(true);
    });
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(rowLinks(pinned).map((row) => row.getAttribute("aria-label"))).toEqual(["Attention root", "Idle root"]);
    expect(within(pinned).getByRole("button", { name: /^1 child thread/, expanded: false })).toBeDefined();
    const card = within(pinned).getByRole("link", { name: "Attention root" });
    const target = within(pinned).getByRole("link", { name: "Idle root" }).closest("li")!;
    const drag = startDrag(card, target);
    expect(card.closest("ul")!.hasAttribute("data-drag-preview")).toBe(true);
    expect(rowLinks(pinned).map((row) => row.getAttribute("aria-label"))).toEqual(["Idle root", "Attention root"]);
    expect(within(pinned).getByRole("link", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
    drag.drop();
    await waitFor(() =>
      expect(reorderInput).toEqual({
        threadId: "attention-root",
        previousThreadId: "idle-root",
        nextThreadId: null,
      }),
    );
    fireEvent.click(within(pinned).getByRole("button", { name: /^Pinned/, expanded: true }));
    expect(rowLinks(pinned).map((row) => row.getAttribute("aria-label"))).toEqual(["Attention root"]);
    expect(within(pinned).queryByRole("link", { name: "Idle root" })).toBeNull();
    expect(within(pinned).getByRole("link", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
    await act(async () => {
      pending.resolve(pinnedOrderResponse(["idle-root", "attention-root"]));
      await pending.promise;
    });
    expect(rowLinks(pinned).map((row) => row.getAttribute("aria-label"))).toEqual(["Attention root"]);
    expect(within(pinned).getByRole("link", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
    fireEvent.click(within(pinned).getByRole("button", { name: /^Pinned/, expanded: false }));
    expect(rowLinks(pinned).map((row) => row.getAttribute("aria-label"))).toEqual(["Idle root", "Attention root"]);
    expect(within(pinned).getByRole("link", { name: "Open child thread: Attention child, Needs you" })).toBeDefined();
  });

  it.each(
    [true, false].flatMap((pinned) =>
      ["down", "up"].flatMap((direction) =>
        [60, 120].map((neighbourHeight) => ({ pinned, direction, neighbourHeight })),
      ),
    ),
  )(
    "crosses the row boundary without oscillation: $pinned/$direction/$neighbourHeight",
    async ({ pinned, direction, neighbourHeight }) => {
      const movingId = direction === "down" ? "a" : "b";
      const neighbourId = movingId === "a" ? "b" : "a";
      const finalOrder = ["b", "a"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Row A", isPinned: pinned }),
            thread({ id: "b", title: "Row B", isPinned: pinned }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: ["a", "b"] }),
          reorderInbox: () => ({ inboxThreadIds: finalOrder }),
        },
        sdk: { threads: { reorderPinned: async () => pinnedOrderResponse(finalOrder) } },
      });
      const card = await screen.findByRole("link", { name: movingId === "a" ? "Row A" : "Row B" });
      const list = card.closest("ul")!;
      const rows = Array.from(list.children) as HTMLElement[];
      const scroll = list.parentElement!;
      let frame: FrameRequestCallback | undefined;
      const checkScroll = direction === "down" && neighbourHeight === 120;
      if (checkScroll) {
        scroll.style.overflowY = "auto";
        Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 500 });
        Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
        vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
          top: 0,
          bottom: 100,
          left: 0,
          right: 200,
        } as DOMRect);
        const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
          frame = callback;
          return 1;
        });
        onTestFinished(() => animationFrame.mockRestore());
      }
      const id = (row: Element) => row.querySelector<HTMLElement>("[data-sidebar-thread-id]")!.dataset.sidebarThreadId!;
      const height = (row: Element) => (id(row) === movingId ? 60 : neighbourHeight);
      const rect = (row: Element) => {
        const ordered = Array.from(list.children);
        const top = ordered.slice(0, ordered.indexOf(row)).reduce((sum, r) => sum + height(r), 0) - scroll.scrollTop;
        return {
          top,
          bottom: top + height(row),
          height: height(row),
          left: 0,
          right: 200,
          width: 200,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      };
      for (const row of rows) vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => rect(row));
      vi.mocked(document.elementFromPoint).mockImplementation(
        (_x, y) => rows.find((row) => y >= rect(row).top && y < rect(row).bottom) ?? null,
      );
      const neighbour = rows.find((row) => id(row) === neighbourId)!;
      const start = rect(card.closest("li")!).top + 30;
      const boundary = direction === "down" ? rect(neighbour).top + 1 : rect(neighbour).bottom - 1;
      const move = (y: number) => fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: y, pointerId: 1 });
      const order = () => Array.from(list.children).map(id);
      fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: start, pointerId: 1 });
      move(boundary);
      expect(order()).toEqual(finalOrder); // Just 1px inside the neighbour, before its midpoint.
      for (let i = 0; i < 3; i += 1) move(boundary);
      expect(order()).toEqual(finalOrder);
      const forward = boundary + (direction === "down" ? 1 : -1);
      move(forward);
      expect(order()).toEqual(finalOrder); // Tall neighbour still under cursor after the swap.
      expect(rendered.rpcCalls.filter((call) => call.method.startsWith("reorder"))).toHaveLength(0);
      move(boundary); // Immediate 1px reversal, with no timer or extra distance threshold.
      expect(order()).toEqual(neighbourHeight > 60 ? ["a", "b"] : finalOrder);
      if (neighbourHeight > 60) move(forward);
      expect(order()).toEqual(finalOrder);
      if (checkScroll) {
        for (let i = 0; i < 3; i += 1) {
          act(() => frame!(i * 16));
          expect(order()).toEqual(finalOrder);
        }
        expect(scroll.scrollTop).toBeGreaterThan(0);
      }
      fireEvent.pointerUp(window, { clientX: 20, clientY: forward, pointerId: 1 });
      const saves = () =>
        pinned
          ? pinnedReorders(rendered)
          : rendered.rpcCalls.filter((call) => call.method === "reorderInbox").map((call) => call.input);
      await waitFor(() => expect(saves()).toHaveLength(1));
      expect(saves()[0]).toEqual(
        pinned
          ? {
              threadId: movingId,
              previousThreadId: direction === "down" ? neighbourId : null,
              nextThreadId: direction === "up" ? neighbourId : null,
            }
          : { inboxThreadIds: finalOrder },
      );
    },
  );

  it.each(["Escape", "blur", "pointercancel", "unmount"])(
    "cleans up the drag preview on %s without saving",
    async (reason) => {
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "a", title: "Pin A", isPinned: true }),
            thread({ id: "b", title: "Pin B", isPinned: true }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      });
      const card = await screen.findByRole("link", { name: "Pin A" });
      const list = card.closest("ul")!;
      const target = screen.getByText("Pin B").closest("li")!;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      const drag = startDrag(card, target);
      expect(list.hasAttribute("data-drag-preview")).toBe(true);
      if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (reason === "blur") fireEvent.blur(window);
      else if (reason === "pointercancel") fireEvent.pointerCancel(window, { pointerId: 1 });
      else rendered.unmount();
      expect(list.hasAttribute("data-drag-preview")).toBe(false);
      expect(document.body.style.cursor).toBe(previousCursor);
      expect(document.body.style.userSelect).toBe(previousSelect);
      drag.drop();
      expect(pinnedReorders(rendered)).toHaveLength(0);
    },
  );

  it("cancels shelf reordering when bb takes over a split drag", async () => {
    const rendered = renderSlot(inbox, listProps, {
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
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
    const drag = startDrag(card, target);
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Pinned" })).getAllByRole("listitem")[0]!.textContent).toContain(
        "Pin B",
      ),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    drag.drop();

    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Pinned" })).getAllByRole("listitem")[0]!.textContent).toContain(
        "Pin A",
      ),
    );
    expect(pinnedReorders(rendered)).toHaveLength(0);
  });

  it("stops suppressing clicks once the drag's own click is swallowed", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
    startDrag(card, target).drop();

    const openCalls = () => rendered.linkCalls.length;
    const settled = openCalls();

    // The gesture's own click.
    fireEvent.click(card);
    expect(openCalls()).toBe(settled);

    // Enter on the same row raises a click with no pointer press in front of
    // it. Staying armed would swallow that one too, indefinitely.
    fireEvent.click(card);
    expect(openCalls()).toBe(settled + 1);
  });

  it("leaves a touch gesture to the scroller instead of reordering", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    fireEvent.pointerDown(card, {
      button: 0,
      clientX: 20,
      clientY: 0,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 20,
      clientY: 30,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 30,
      pointerId: 1,
      pointerType: "touch",
    });

    expect(pinnedReorders(rendered)).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "Pinned" })).getAllByRole("listitem")[0]!.textContent).toContain(
      "Pin A",
    );
  });

  it("does not open the thread when a drag is cancelled with Escape", async () => {
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "a", title: "Pin A", isPinned: true }),
          thread({ id: "b", title: "Pin B", isPinned: true }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });

    const card = await screen.findByRole("link", { name: "Pin A" });
    const target = screen.getByText("Pin B").closest("li")!;
    const drag = startDrag(card, target);
    fireEvent.keyDown(window, { key: "Escape" });
    drag.drop();
    const openedBeforeClick = rendered.linkCalls.length;
    // The browser raises this once the gesture ends. Cancelling a drag must not
    // navigate into the row the drag started from.
    fireEvent.click(card);

    expect(rendered.linkCalls).toHaveLength(openedBeforeClick);
  });
});
