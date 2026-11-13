// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, PolicyMenu, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("structural child pin policy UI", () => {
  it.each(["pinned", "unpinned", "archived", "missing", "other-project"])(
    "omits new Pin for a child with %s parent",
    async (parentState) => {
      const child = thread({ id: "child", title: "Policy child", parentThreadId: "parent" });
      const parent = thread({
        id: "parent",
        isPinned: parentState === "pinned",
        isArchived: parentState === "archived",
        projectId: parentState === "other-project" ? "other" : "proj_1",
      });
      const rendered = renderSlot(
        { component: PolicyMenu },
        { selected: child },
        {
          sidebarThreads: {
            status: "ready",
            threads: parentState === "missing" ? [child] : [child, parent],
            projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
          },
        },
      );
      fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
      const menu = await screen.findByRole("menu", { name: "Thread actions" });
      expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
      expect(within(menu).queryByRole("menuitem", { name: "Unpin" })).toBeNull();
      expect(rendered.rpcCalls).toHaveLength(0);
    },
  );

  it.each([null, "fork"] as const)("allows new Pin for a structural root with originKind=%s", async (originKind) => {
    const selected = thread({ id: "root", originKind });
    const rendered = renderSlot(
      { component: PolicyMenu },
      { selected },
      {
        sidebarThreads: { threads: [selected] },
        rpc: { pin: () => ({ ok: true }) },
      },
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Pin" }),
    );
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "pin", input: { threadId: "root" } }));
  });

  it("keeps Unpin for an existing pinned child", async () => {
    const selected = thread({ id: "child", parentThreadId: "missing", isPinned: true });
    const rendered = renderSlot({ component: PolicyMenu }, { selected }, { sidebarThreads: { threads: [selected] } });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() =>
      expect(rendered.sdkCalls).toContainEqual({ method: "threads.unpin", args: [{ threadId: "child" }] }),
    );
    expect(rendered.rpcCalls).toHaveLength(0);
  });

  it("uses the same menu policy for a pinned child row in the sidebar", async () => {
    const children = [thread({ id: "child", title: "Nested policy child", parentThreadId: "parent", isPinned: true })];
    const threads = [thread({ id: "parent", title: "Policy parent" }), ...children];
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 child thread/ }));
    fireEvent.contextMenu(await screen.findByText("Nested policy child"));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() =>
      expect(rendered.sdkCalls).toContainEqual({ method: "threads.unpin", args: [{ threadId: "child" }] }),
    );
  });

  it.each([null, "old"])(
    "offers enabled parent choices/hint and keyboard for pinned thread with parent=%s",
    async (currentParent) => {
      const selected = thread({ id: "thread", parentThreadId: currentParent, isPinned: true });
      const rendered = renderSlot(
        { component: PolicyMenu },
        { selected },
        {
          sidebarThreads: {
            threads: [
              selected,
              thread({ id: "parent", title: "Next parent" }),
              thread({ id: "old", title: "Old parent" }),
            ],
          },
          rpc: { setThreadParent: () => ({ ok: true }) },
        },
      );
      const row = screen.getByRole("button", { name: "Policy row" });
      fireEvent.contextMenu(row);
      fireEvent.keyDown(
        within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }),
        { key: "ArrowRight" },
      );
      const input = await screen.findByRole("textbox", { name: "Search parent threads" });
      const menu = input.closest<HTMLElement>('[role="menu"]')!;
      expect(
        within(menu).getByText("Choosing a different parent will unpin this thread. Choosing None keeps it pinned."),
      ).toBeDefined();
      const choice = within(menu).getByRole("menuitemradio", { name: "Next parent" });
      expect(choice.getAttribute("aria-disabled")).not.toBe("true");
      expect(within(menu).getByRole("menuitemradio", { name: "None" }).getAttribute("aria-disabled")).not.toBe("true");
      fireEvent.change(input, { target: { value: "Next" } });
      rendered.rerender(<PolicyMenu selected={{ ...selected, isPinned: false }} />);
      expect(screen.getByRole("button", { name: "Policy row", hidden: true })).toBe(row);
      expect(
        within(menu).queryByText("Choosing a different parent will unpin this thread. Choosing None keeps it pinned."),
      ).toBeNull();
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(document.activeElement).toBe(choice);
      fireEvent.keyDown(choice, { key: "Enter" });
      await waitFor(() =>
        expect(rendered.rpcCalls).toContainEqual({
          method: "setThreadParent",
          input: { threadId: "thread", parentThreadId: "parent" },
        }),
      );
    },
  );

  it.each(["old", "next", null])(
    "keeps parent choice %s available for an existing pinned child",
    async (parentThreadId) => {
      const selected = thread({ id: "child", parentThreadId: "old", isPinned: true });
      const rendered = renderSlot(
        { component: PolicyMenu },
        { selected },
        {
          sidebarThreads: {
            threads: [
              selected,
              thread({ id: "old", title: "Old parent" }),
              thread({ id: "next", title: "Next parent" }),
            ],
          },
          rpc: { setThreadParent: () => ({ ok: true }) },
        },
      );
      fireEvent.contextMenu(screen.getByRole("button", { name: "Policy row" }));
      fireEvent.keyDown(
        within(await screen.findByRole("menu", { name: "Thread actions" })).getByRole("menuitem", { name: "Parent" }),
        { key: "ArrowRight" },
      );
      const input = await screen.findByRole("textbox", { name: "Search parent threads" });
      const menu = input.closest<HTMLElement>('[role="menu"]')!;
      expect(
        within(menu).getByText("Choosing a different parent will unpin this thread. Choosing None keeps it pinned."),
      ).toBeDefined();
      const choice = within(menu).getByRole("menuitemradio", {
        name: parentThreadId === "old" ? "Old parent" : parentThreadId === "next" ? "Next parent" : "None",
      });
      expect(choice.getAttribute("aria-disabled")).not.toBe("true");
      fireEvent.click(choice);
      if (parentThreadId === "old") expect(rendered.rpcCalls).toHaveLength(0);
      else
        await waitFor(() =>
          expect(rendered.rpcCalls).toContainEqual({
            method: "setThreadParent",
            input: { threadId: "child", parentThreadId },
          }),
        );
    },
  );
});
