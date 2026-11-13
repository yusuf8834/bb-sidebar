// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { thread, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("archives the selected child instead of its parent", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));

    fireEvent.contextMenu(screen.getByRole("link", { name: "Open child thread: Child" }));

    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive"));
    expect(rendered.threadActionCalls).toContainEqual({
      key: "bb--core/archive",
      threadId: "child",
    });
    expect(rendered.threadActionCalls).not.toContainEqual({
      key: "bb--core/archive",
      threadId: "parent",
    });
  });

  it("releases the agent sessions archive leaves loaded", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "idle-child", title: "Idle child", parentThreadId: "parent" }),
      thread({
        id: "busy-child",
        title: "Busy child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({ id: "stranger", title: "Stranger" }),
    ]);

    fireEvent.contextMenu(screen.getByText("Parent"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive"));

    expect(rendered.threadActionCalls).toContainEqual({
      key: "bb--core/archive",
      threadId: "parent",
    });
    await waitFor(() =>
      expect(rendered.rpcCalls).toContainEqual({
        method: "releaseRuntimes",
        input: { threadIds: ["parent", "idle-child"] },
      }),
    );
  });

  for (const busyChild of [
    thread({ id: "running", title: "Running child", indicator: "runtime" }),
    thread({
      id: "needs-input",
      title: "Needs input child",
      hasPendingInteraction: true,
    }),
  ]) {
    it(`disables Archive for a busy child: ${busyChild.id}`, async () => {
      render([thread({ id: "parent", title: "Parent" }), { ...busyChild, parentThreadId: "parent" }]);
      fireEvent.click(screen.getByRole("button", { name: /^1 child thread/ }));
      fireEvent.contextMenu(
        screen.getByRole("link", {
          name: `Open child thread: ${busyChild.title}${busyChild.hasPendingInteraction ? ", Needs you" : ", Working"}`,
        }),
      );

      const archive = within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive");
      expect(archive.getAttribute("data-disabled")).not.toBeNull();
    });
  }

  it("shows one collapsed grandchild level without changing the parent count", () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Child",
        parentThreadId: "parent",
      }),
      thread({
        id: "grandchild",
        title: "Grandchild",
        parentThreadId: "child",
      }),
      thread({
        id: "great-grandchild",
        title: "Great-grandchild",
        parentThreadId: "grandchild",
      }),
    ]);

    const parentBadge = screen.getByRole("button", {
      name: "1 child thread",
    });
    fireEvent.click(parentBadge);

    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByText("Child")).toBeDefined();
    expect(screen.queryByText("Grandchild")).toBeNull();
    expect(screen.queryByText("Great-grandchild")).toBeNull();

    const disclosure = within(childList).getByRole("button", {
      name: "Show 1 grandchild thread for Child",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();

    fireEvent.click(disclosure);

    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Child",
    });
    expect(grandchildList.getAttribute("data-grandchild-thread-list")).toBe("sidebar");
    expect(within(grandchildList).getByText("Grandchild")).toBeDefined();
    expect(screen.queryByText("Great-grandchild")).toBeNull();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();

    fireEvent.click(
      within(grandchildList).getByRole("link", {
        name: "Open grandchild thread: Grandchild",
      }),
    );
    expect(rendered.linkCalls).toContainEqual({ href: "/projects/proj_1/threads/grandchild", split: false });
  });

  it("removes archived children from the sidebar badge and list", () => {
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "visible-child",
        title: "Visible child",
        parentThreadId: "parent",
      }),
      thread({
        id: "archived-child",
        title: "Archived child",
        parentThreadId: "parent",
        isArchived: true,
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(screen.getByText("Visible child")).toBeDefined();
    expect(screen.queryByText("Archived child")).toBeNull();
  });

  // Moved from the removed header chip's tests: the sidebar's archive test
  // covers only a direct child.
  it("archives the selected grandchild instead of its child or parent", async () => {
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({ id: "child", title: "Child", parentThreadId: "parent" }),
      thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Child" }));

    fireEvent.contextMenu(screen.getByRole("link", { name: "Open grandchild thread: Grandchild" }));

    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Archive"));
    expect(rendered.threadActionCalls).toContainEqual({ key: "bb--core/archive", threadId: "grandchild" });
    expect(rendered.threadActionCalls).not.toContainEqual({ key: "bb--core/archive", threadId: "child" });
    expect(rendered.threadActionCalls).not.toContainEqual({ key: "bb--core/archive", threadId: "parent" });
  });

  // Moved from the removed header chip's tests; nothing else renames a child row.
  it.each(["child", "grandchild", "great-grandchild"])(
    "renames a %s row without opening it and keeps the list on cancel",
    async (targetId) => {
      const rendered = render([
        thread({ id: "parent", title: "Parent" }),
        thread({ id: "child", title: "Child", parentThreadId: "parent" }),
        thread({ id: "grandchild", title: "Grandchild", parentThreadId: "child" }),
        thread({ id: "great-grandchild", title: "Great-grandchild", parentThreadId: "grandchild" }),
      ]);
      fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
      if (targetId !== "child") {
        fireEvent.click(screen.getByRole("button", { name: "Show 1 grandchild thread for Child" }));
      }
      if (targetId === "great-grandchild") {
        fireEvent.click(screen.getByRole("button", { name: "Show 1 great-grandchild thread for Grandchild" }));
      }
      const title = targetId === "child" ? "Child" : targetId === "grandchild" ? "Grandchild" : "Great-grandchild";
      const startRename = async () => {
        fireEvent.contextMenu(screen.getByRole("link", { name: `Open ${targetId} thread: ${title}` }));
        fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Rename"));
        return screen.findByRole("textbox", { name: `Rename ${title}` });
      };
      const sdkCallsBefore = rendered.sdkCalls.length;
      let input = await startRename();
      expect(input.closest("a, button")).toBeNull();
      fireEvent.pointerDown(input, { button: 0 });
      expect(rendered.navigateCalls).toEqual([]);
      expect(rendered.linkCalls).toEqual([]);
      expect(rendered.splitSourceCalls).toEqual([]);
      expect(rendered.sdkCalls.slice(sdkCallsBefore)).toEqual([]);
      expect(rendered.threadActionCalls).toEqual([{ key: "bb--core/rename", threadId: targetId }]);
      fireEvent.change(input, { target: { value: "Canceled" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.getByRole("list", { name: "Child threads" })).toBeDefined();
      expect(screen.getByRole("link", { name: `Open ${targetId} thread: ${title}` })).toBeDefined();
      expect(rendered.sdkCalls.slice(sdkCallsBefore)).toEqual([]);

      input = await startRename();
      fireEvent.change(input, { target: { value: "Renamed child" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(rendered.sdkCalls.slice(sdkCallsBefore)).toEqual([
          { method: "threads.update", args: [{ threadId: targetId, title: "Renamed child" }] },
        ]),
      );
      expect(rendered.navigateCalls).toEqual([]);
      expect(rendered.linkCalls).toEqual([]);
      expect(rendered.splitSourceCalls).toEqual([]);
      expect(rendered.threadActionCalls).toEqual([
        { key: "bb--core/rename", threadId: targetId },
        { key: "bb--core/rename", threadId: targetId },
      ]);
    },
  );
});
