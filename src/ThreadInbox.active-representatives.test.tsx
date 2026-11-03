// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, rowLinks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("scoped active representative regressions", () => {
  it.each([
    ["A", "parent"],
    ["B", "child"],
    [null, "parent"],
  ] as const)("retains closest flat row in collapsed scope %s", async (scope, expected) => {
    const rendered = renderSlot(
      inbox,
      { ...listProps, activeThreadId: "child" },
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "parent", title: "Parent A", projectId: "A" }),
            thread({ id: "child", title: "Child B", projectId: "B", parentThreadId: "parent" }),
          ],
          projects: [
            { id: "A", name: "A", isPersonal: false, href: "", settingsHref: "" },
            { id: "B", name: "B", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: {
          listLifecycle: () => ({
            rows: ["parent", "child"].map((threadId) => ({
              threadId,
              settledAt: 200,
              snoozedUntil: null,
              snoozedAt: null,
            })),
          }),
        },
      },
    );
    if (scope) {
      const field = screen.getByRole("combobox", { name: "Filter threads" });
      fireEvent.change(field, { target: { value: `[${scope}]` } });
      fireEvent.keyDown(field, { key: "Enter" });
    }
    const shelf = await screen.findByRole("region", { name: "Settled" });
    expect(within(shelf).getByRole("button", { name: /^Settled/, expanded: false })).toBeDefined();
    expect(within(shelf).getByText(expected === "parent" ? "Parent A" : "Child B")).toBeDefined();
    expect(rowLinks(shelf)).toHaveLength(1);
    expect(rendered.rpcCalls.filter((call) => /Parent|reorder|Pinned/.test(call.method))).toEqual([]);
  });

  it.each([
    ["A", "Grandchild A"],
    ["B", "Deep B"],
  ])("chooses the nearest alternating-project flat ancestor in %s", async (scope, title) => {
    window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
    renderSlot(
      inbox,
      { ...listProps, activeThreadId: "deep" },
      {
        sidebarThreads: {
          status: "ready",
          projects: [
            { id: "A", name: "A", isPersonal: false, href: "", settingsHref: "" },
            { id: "B", name: "B", isPersonal: false, href: "", settingsHref: "" },
          ],
          threads: [
            thread({ id: "root", title: "Root A", projectId: "A", updatedAt: Date.now() }),
            thread({ id: "child", title: "Child B", projectId: "B", parentThreadId: "root", updatedAt: Date.now() }),
            thread({
              id: "grandchild",
              title: "Grandchild A",
              projectId: "A",
              parentThreadId: "child",
              updatedAt: Date.now(),
            }),
            thread({
              id: "deep",
              title: "Deep B",
              projectId: "B",
              parentThreadId: "grandchild",
              updatedAt: Date.now(),
            }),
          ],
        },
        rpc: { listLifecycle: () => ({ rows: [] }) },
      },
    );
    const field = screen.getByRole("combobox", { name: "Filter threads" });
    fireEvent.change(field, { target: { value: `[${scope}]` } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByRole("link", { name: title })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Root A" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Child B" })).toBeNull();
  });

  it.each(["missing", "archived", "same-project", "unknown"])(
    "handles %s active ancestry after settled limit",
    async (mode) => {
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ settled: true }));
      const parent = thread({ id: "parent", title: "Representative", isArchived: mode === "archived" });
      const child = thread({ id: "child", title: "Orphan", parentThreadId: mode === "missing" ? "missing" : "parent" });
      const rows = [
        ...Array.from({ length: 12 }, (_, i) => thread({ id: `filler-${i}`, title: `Filler ${i}` })),
        ...(mode === "missing" ? [] : [parent]),
        child,
      ];
      renderSlot(
        inbox,
        { ...listProps, activeThreadId: mode === "unknown" ? "unknown" : "child" },
        {
          sidebarThreads: { status: "ready", threads: rows, projects: [] },
          rpc: {
            listLifecycle: () => ({
              rows: rows.map((row, i) => ({
                threadId: row.id,
                settledAt: 1000 - i,
                snoozedUntil: null,
                snoozedAt: null,
              })),
            }),
          },
        },
      );
      const shelf = await screen.findByRole("region", { name: "Settled" });
      const expected = mode === "same-project" ? "Representative" : "Orphan";
      if (mode === "unknown") {
        expect(within(shelf).queryByText("Representative")).toBeNull();
        expect(rowLinks(shelf)).toHaveLength(10);
      } else {
        expect(within(shelf).getByText(expected)).toBeDefined();
        expect(rowLinks(shelf)).toHaveLength(11);
        fireEvent.click(within(shelf).getByRole("button", { expanded: true }));
        expect(within(shelf).getByText(expected)).toBeDefined();
        expect(rowLinks(shelf)).toHaveLength(1);
      }
    },
  );
});
