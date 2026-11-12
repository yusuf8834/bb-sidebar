// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, render, deferred, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it("ignores a settings load that answers after a newer one", async () => {
    const stale = deferred<typeof defaultSidebarSettings>();
    let loads = 0;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({
            id: "working",
            title: "Working child",
            parentThreadId: "parent",
            indicator: "runtime",
          }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => {
          loads += 1;
          return loads === 1
            ? stale.promise
            : {
                ...defaultSidebarSettings,
                showRunningChildrenWhenCollapsed: false,
              };
        },
        listLifecycle: () => ({ rows: [] }),
      },
    });

    await rendered.emitRealtime("sidebar-settings", {});
    await waitFor(() => expect(screen.queryByRole("list", { name: "Child threads" })).toBeNull());

    stale.resolve(defaultSidebarSettings);
    await stale.promise;
    await waitFor(() => expect(loads).toBe(2));
    expect(screen.queryByRole("list", { name: "Child threads" })).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem("bb-sidebar:settings-cache:v1") ?? "{}").showRunningChildrenWhenCollapsed,
    ).toBe(false);
  });

  it("highlights the active grandchild row", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({ id: "child", title: "Child", parentThreadId: "parent" }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              parentThreadId: "child",
            }),
          ],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const childRow = screen.getByRole("link", {
      name: "Open child thread: Child",
    });
    expect(childRow.getAttribute("aria-current")).toBeNull();
    const grandchildRow = screen.getByRole("link", {
      name: "Open grandchild thread: Grandchild",
    });
    expect(grandchildRow.getAttribute("aria-current")).toBe("page");
    expect(grandchildRow.closest("[data-child-thread-row]")?.className).toContain("bg-sidebar-accent");
  });

  it("marks a child from another project than its parent", () => {
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "grandchild" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent" }),
            thread({
              id: "child",
              title: "Child",
              projectId: "proj_2",
              parentThreadId: "parent",
            }),
            thread({
              id: "grandchild",
              title: "Grandchild",
              projectId: "proj_2",
              parentThreadId: "child",
            }),
          ],
          projects: [
            { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
            { id: "proj_2", name: "xPlan", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );

    const childRow = screen.getByRole("link", {
      name: "Open child thread: Child, in project xPlan",
    });
    expect(childRow.querySelector("[data-foreign-project]")?.getAttribute("data-foreign-project")).toBe("proj_2");
    // Same project as its own parent, so no mark.
    const grandchildRow = screen.getByRole("link", {
      name: "Open grandchild thread: Grandchild",
    });
    expect(grandchildRow.querySelector("[data-foreign-project]")).toBeNull();
  });

  it("shows every child status or an idle age in expanded rows and accessible names", async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({
        monitoring: minute - 5 * 60_000,
        planning: minute - 5 * 60_000,
      }),
    );
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "failed",
        title: "Failed child",
        parentThreadId: "parent",
        indicator: "unread-error",
      }),
      thread({
        id: "unread",
        title: "Unread child",
        parentThreadId: "parent",
        indicator: "unread-success",
      }),
      thread({
        id: "waiting",
        title: "Waiting child",
        parentThreadId: "parent",
        indicator: "waiting-for-input",
      }),
      thread({
        id: "monitoring",
        title: "Monitoring child",
        parentThreadId: "parent",
        indicator: "runtime",
        indicatorLabel: "Thread monitoring",
      }),
      thread({
        id: "planning",
        title: "Planning child",
        parentThreadId: "parent",
        indicator: "plan-mode",
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 1,
        },
      }),
      thread({
        id: "pending-runtime",
        title: "Pending runtime child",
        parentThreadId: "parent",
        hasPendingInteraction: true,
        indicator: "runtime",
        indicatorLabel: "Agent is working",
      }),
      thread({
        id: "idle",
        title: "Idle child",
        parentThreadId: "parent",
        updatedAt: minute - 31 * 60_000,
      }),
    ]);

    const badge = screen.getByRole("button", {
      name: "7 child threads, 1 failed, 2 need you, 1 done, 2 working",
    });
    fireEvent.click(badge);

    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(badge.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();
    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(childList.getAttribute("data-child-thread-list")).toBe("sidebar");
    for (const label of ["Failed", "Unread", "Monitoring · 5m", "Planning · 5m"]) {
      expect(within(childList).getByText(label)).toBeDefined();
    }
    expect(within(childList).getAllByText("Needs you")).toHaveLength(2);
    expect(within(childList).getByText("31m")).toBeDefined();
    expect(within(childList).queryByText("Agent is working")).toBeNull();

    for (const name of [
      "Open child thread: Failed child, Failed",
      "Open child thread: Unread child, Unread",
      "Open child thread: Waiting child, Needs you",
      "Open child thread: Monitoring child, Monitoring · 5m",
      "Open child thread: Planning child, Planning · 5m",
      "Open child thread: Pending runtime child, Needs you",
      "Open child thread: Idle child",
    ]) {
      expect(within(childList).getByRole("link", { name })).toBeDefined();
    }
    // Tint plus a leading rule: in dark the amber fill is only a 1.07:1 step
    // off the sidebar, so the rule is what actually finds the row.
    const needsYouRow = within(childList).getByRole("link", {
      name: "Open child thread: Pending runtime child, Needs you",
    }).parentElement!;
    expect(needsYouRow.className).toContain("bg-[color:var(--bb-sidebar-needs-you-tint)]");
    expect(needsYouRow.className).toContain("shadow-[inset_2px_0_0_0_var(--bb-sidebar-needs-you-accent)]");
    // and only that row: the rule is the tint's partner, not a row border.
    expect(
      within(childList).getByRole("link", {
        name: "Open child thread: Failed child, Failed",
      }).parentElement?.className,
    ).not.toContain("--bb-sidebar-needs-you-accent");

    // The slot takes exactly the width its label needs, up to the 112px the
    // longest status wants, so a short status or age hands the rest back to a
    // child title that a narrow sidebar has little room for.
    const monitoringSlot = within(childList).getByText("Monitoring · 5m").parentElement!;
    expect(monitoringSlot.className).toContain("w-auto");
    expect(monitoringSlot.className).toContain("max-w-28");
    expect(monitoringSlot.className.split(" ")).not.toContain("w-28");
    expect(monitoringSlot.className.split(" ")).not.toContain("min-w-20");
    const idleSlot = within(childList).getByText("31m").parentElement!;
    expect(idleSlot.className).toContain("w-auto");
    expect(idleSlot.className.split(" ")).not.toContain("min-w-20");

    fireEvent.click(
      within(childList).getByRole("link", {
        name: "Open child thread: Monitoring child, Monitoring · 5m",
      }),
    );
    expect(rendered.linkCalls).toContainEqual({ href: "/projects/proj_1/threads/monitoring", split: false });
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("bb-sidebar:child-expansion:v1") ?? "[]")).toEqual(["parent"]),
    );
  });

  // bb adds indicator kinds over time. One this build has never seen has to
  // fall through to the age on a child row exactly as it does on a parent
  // card, and must not tint the rollup badge either.
  it("keeps the age on child and grandchild rows with an unrecognized indicator", () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Future child",
        parentThreadId: "parent",
        indicator: "something-bb-ships-later" as never,
        indicatorLabel: "Doing something new",
        updatedAt: minute - 4 * 60_000,
      }),
      thread({
        id: "grandchild",
        title: "Future grandchild",
        parentThreadId: "child",
        indicator: "another-thing-bb-ships-later" as never,
        indicatorLabel: "Also new",
        updatedAt: minute - 7 * 60_000,
      }),
    ]);

    const badge = screen.getByRole("button", { name: "1 child thread" });
    expect(badge.getAttribute("data-child-status")).toBeNull();
    expect(badge.className).toContain("bg-muted");
    fireEvent.click(badge);

    const childList = screen.getByRole("list", { name: "Child threads" });
    expect(within(childList).getByText("4m")).toBeDefined();
    expect(within(childList).queryByText("Doing something new")).toBeNull();
    expect(
      within(childList).getByRole("link", {
        name: "Open child thread: Future child",
      }),
    ).toBeDefined();

    fireEvent.click(
      within(childList).getByRole("button", {
        name: "Show 1 grandchild thread for Future child",
      }),
    );
    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Future child",
    });
    expect(within(grandchildList).getByText("7m")).toBeDefined();
    expect(within(grandchildList).queryByText("Also new")).toBeNull();
    expect(
      within(grandchildList).getByRole("link", {
        name: "Open grandchild thread: Future grandchild",
      }),
    ).toBeDefined();
  });

  // Grandchildren are rows like any other: they get the same vocabulary, and
  // the status sits beside the disclosure button rather than displacing it.
  it("shows the shared status on grandchild rows and beside a disclosure", () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    window.localStorage.setItem("bb-sidebar:working-since:v1", JSON.stringify({ child: minute - 5 * 60_000 }));
    const rendered = render([
      thread({ id: "parent", title: "Parent" }),
      thread({
        id: "child",
        title: "Busy child",
        parentThreadId: "parent",
        indicator: "runtime",
      }),
      thread({
        id: "failed-grandchild",
        title: "Failed grandchild",
        parentThreadId: "child",
        indicator: "unread-error",
        indicatorLabel: "Unread thread failed",
      }),
      thread({
        id: "asking-grandchild",
        title: "Asking grandchild",
        parentThreadId: "child",
        hasPendingInteraction: true,
        indicator: "runtime",
        indicatorLabel: "Agent is working",
      }),
    ]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "1 child thread, 1 failed, 1 need you, 1 working",
      }),
    );
    const childList = screen.getByRole("list", { name: "Child threads" });
    const childRow = within(childList)
      .getByRole("link", { name: "Open child thread: Busy child, Working · 5m" })
      .closest("[data-child-thread-row]") as HTMLElement;
    const disclosure = within(childRow).getByRole("button", {
      name: "Show 2 grandchild threads for Busy child, 1 failed, 1 need you",
    });
    expect(within(childRow).getByText("Working · 5m")).toBeDefined();
    fireEvent.click(disclosure);

    const grandchildList = screen.getByRole("list", {
      name: "Grandchildren of Busy child",
    });
    expect(within(grandchildList).getByText("Failed")).toBeDefined();
    expect(within(grandchildList).getByText("Needs you")).toBeDefined();
    // A raised hand outranks the runtime bb still reports for that thread.
    expect(within(grandchildList).queryByText(/^Working/)).toBeNull();
    for (const name of [
      "Open grandchild thread: Failed grandchild, Failed",
      "Open grandchild thread: Asking grandchild, Needs you",
    ]) {
      expect(within(grandchildList).getByRole("link", { name })).toBeDefined();
    }

    fireEvent.click(
      within(grandchildList).getByRole("link", {
        name: "Open grandchild thread: Failed grandchild, Failed",
      }),
    );
    expect(rendered.linkCalls).toContainEqual({ href: "/projects/proj_1/threads/failed-grandchild", split: false });
  });
});
