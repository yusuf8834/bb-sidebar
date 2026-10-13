// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { PolicyMenu, thread, deferred, toastMocks, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("parent auto-unpin menu UX", () => {
  const noop = () => {};
  it.each([
    { name: "no actions", actions: {}, item: null },
    { name: "park", actions: { onPark: noop }, item: "Park thread" },
  ])("keeps real group boundaries without adjacent separators: $name", async ({ actions, item }) => {
    const selected = thread({ parentThreadId: "missing" });
    renderSlot({ component: PolicyMenu }, { selected, actions }, { sidebarThreads: { threads: [selected] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    const separators = within(menu).getAllByRole("separator");
    for (const separator of separators)
      expect(separator.nextElementSibling?.getAttribute("role")).not.toBe("separator");
    if (item) expect(within(menu).getByRole("menuitem", { name: item })).toBeDefined();
  });

  it("shows exactly one honest partial-success toast and suppresses duplicate selection while saving", async () => {
    const selected = thread({ id: "thread", isPinned: true });
    const pending = deferred<{ ok: boolean; unpinFailed: true }>();
    const rendered = renderSlot(
      { component: PolicyMenu },
      { selected },
      {
        sidebarThreads: { threads: [selected, thread({ id: "parent", title: "Next parent" })] },
        rpc: { setThreadParent: () => pending.promise },
      },
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.keyDown(
      within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }),
      { key: "ArrowRight" },
    );
    const input = await screen.findByRole("textbox", { name: "Search parent threads" });
    const choice = within(input.closest<HTMLElement>('[role="menu"]')!).getByRole("menuitemradio", {
      name: "Next parent",
    });
    fireEvent.click(choice);
    fireEvent.click(choice);
    await waitFor(() => expect(rendered.rpcCalls).toHaveLength(1));
    await act(async () => pending.resolve({ ok: true, unpinFailed: true }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledExactlyOnceWith("Parent updated, but unpinning could not be confirmed", {
        className: "bb-sidebar-toast",
        description: "If the thread is still pinned, choose Unpin manually.",
      }),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("keeps None at a pinned root a no-op", async () => {
    const selected = thread({ id: "thread", isPinned: true });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, { sidebarThreads: { threads: [selected] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.keyDown(
      within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }),
      { key: "ArrowRight" },
    );
    const input = await screen.findByRole("textbox", { name: "Search parent threads" });
    fireEvent.click(within(input.closest<HTMLElement>('[role="menu"]')!).getByRole("menuitemradio", { name: "None" }));
    expect(rendered.rpcCalls).toHaveLength(0);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
