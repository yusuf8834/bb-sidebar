// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp, rowLinks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const savedProjectOrder = () => JSON.parse(window.localStorage.getItem("bb-sidebar:project-order:v1") ?? "null");

describe("ThreadInbox", () => {
  describe("moving projects as a whole", () => {
    // These cover lone-thread slots, which only exist with the grouping off.
    beforeEach(() => window.localStorage.setItem("bb-sidebar:single-thread-project-grouping:v1", "false"));

    it.each([true, false])(
      "retains scoped active and deep queued attention in a collapsed project: setting=%s",
      async (showAttention) => {
        window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
        window.localStorage.setItem("bb-sidebar:project-collapse:v1", JSON.stringify(["web"]));
        const rendered = renderSlot(
          inbox,
          { ...listProps, activeThreadId: "b" },
          {
            sidebarThreads: {
              status: "ready",
              threads: [
                thread({ id: "a", projectId: "web", title: "Attention root", updatedAt: Date.now() }),
                thread({ id: "b", projectId: "web", title: "Active root", updatedAt: Date.now() }),
                thread({ id: "child", projectId: "web", parentThreadId: "a", title: "Child" }),
                thread({ id: "grandchild", projectId: "web", parentThreadId: "child", title: "Grandchild" }),
                thread({
                  id: "deep",
                  projectId: "web",
                  parentThreadId: "grandchild",
                  title: "Queued failed leaf",
                  queuedWork: "failed",
                }),
              ],
              projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
            },
            rpc: {
              getSidebarSettings: () => ({
                ...defaultSidebarSettings,
                showRunningChildrenWhenCollapsed: showAttention,
              }),
              listLifecycle: () => ({ rows: [] }),
              listInboxOrder: () => ({ inboxThreadIds: ["a", "b", "child", "grandchild", "deep"] }),
            },
          },
        );
        await waitFor(() => expect(rendered.rpcCalls.some((call) => call.method === "getSidebarSettings")).toBe(true));
        const active = screen.getByRole("region", { name: "Active" });
        await waitFor(() =>
          expect(rowLinks(active).map((row) => row.getAttribute("aria-label"))).toEqual(
            showAttention ? ["Attention root", "Active root"] : ["Active root"],
          ),
        );
        expect(within(active).getByRole("button", { name: "Web (2)", expanded: false })).toBeDefined();
        expect(Boolean(within(active).queryByText("Queued failed leaf"))).toBe(showAttention);
        expect(rendered.rpcCalls.filter((call) => call.method.startsWith("reorder"))).toEqual([]);
      },
    );

    it.each(["keyboard", "pointer"].flatMap((gesture) => [false, true].map((singleton) => ({ gesture, singleton }))))(
      "persists collapsed project attention rows: $gesture/singleton=$singleton",
      async ({ gesture, singleton }) => {
        window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
        window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
        const childIds = ["a1", "a2", "a3", "b1", ...(singleton ? ["x1"] : [])];
        const storedIds = ["a", "x", "b", "c", ...childIds];
        const rendered = renderSlot(inbox, listProps, {
          sidebarThreads: {
            status: "ready",
            threads: [
              ...["a", "b", "c"].map((id) =>
                thread({ id, projectId: "web", title: `Web ${id}`, updatedAt: Date.now() }),
              ),
              thread({ id: "x", projectId: "api", title: "Hidden other project", updatedAt: Date.now() }),
              thread({ id: "a1", projectId: "web", parentThreadId: "a", title: "Child a" }),
              thread({ id: "a2", projectId: "web", parentThreadId: "a1", title: "Grandchild a" }),
              thread({ id: "a3", projectId: "web", parentThreadId: "a2", title: "Deep failed", queuedWork: "failed" }),
              thread({
                id: "b1",
                projectId: "web",
                parentThreadId: "b",
                title: "Child b",
                hasPendingInteraction: true,
              }),
              ...(singleton
                ? [
                    thread({
                      id: "x1",
                      projectId: "api",
                      parentThreadId: "x",
                      title: "Child x",
                      hasPendingInteraction: true,
                    }),
                  ]
                : []),
            ],
            projects: [
              { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
              { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
            ],
          },
          rpc: {
            getSidebarSettings: () => defaultSidebarSettings,
            listLifecycle: () => ({ rows: [] }),
            listInboxOrder: () => ({ inboxThreadIds: storedIds }),
            reorderInbox: (input) => input,
          },
        });
        const active = await screen.findByRole("region", { name: "Active" });
        const rowOrder = () => rowLinks(active).map((row) => row.getAttribute("aria-label"));
        // A folded shelf keeps its rows in their projects' slots.
        await waitFor(() =>
          expect(rowOrder()).toEqual(singleton ? ["Web a", "Web b", "Hidden other project"] : ["Web a", "Web b"]),
        );
        expect(within(active).queryByRole("button", { name: "Web (3)" })).toBeNull();
        expect(within(active).getByText("Deep failed")).toBeDefined();
        const card = within(active).getByRole("link", { name: singleton ? "Hidden other project" : "Web a" });
        let preview: Array<string | null> | undefined;
        if (gesture === "keyboard") {
          fireEvent.keyDown(card, { key: singleton ? "ArrowUp" : "ArrowDown", altKey: true });
        } else {
          const target = within(active)
            .getByRole("link", { name: singleton ? "Web a" : "Web b" })
            .closest("li")!;
          vi.mocked(document.elementFromPoint).mockReturnValue(target);
          fireEvent.pointerDown(card, { button: 0, clientX: 20, clientY: singleton ? 60 : 0, pointerId: 1 });
          fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: singleton ? 30 : 60, pointerId: 1 });
          preview = rowOrder();
          fireEvent.pointerUp(window, { clientX: 20, clientY: singleton ? 30 : 60, pointerId: 1 });
        }
        const expectedVisible = singleton ? ["Hidden other project", "Web a", "Web b"] : ["Web b", "Web a"];
        if (singleton) {
          // Moving a lone thread moves its project; the thread order stays.
          await waitFor(() => expect(savedProjectOrder()).toEqual(["api", "web"]));
          expect({ preview, reorders: rendered.rpcCalls.filter((call) => call.method === "reorderInbox") }).toEqual({
            preview: gesture === "pointer" ? expectedVisible : undefined,
            reorders: [],
          });
        } else {
          await waitFor(() =>
            expect(rendered.rpcCalls.filter((call) => call.method === "reorderInbox")).toHaveLength(1),
          );
          expect({ preview, input: rendered.rpcCalls.find((call) => call.method === "reorderInbox")!.input }).toEqual({
            preview: gesture === "pointer" ? expectedVisible : undefined,
            input: { inboxThreadIds: ["b", "x", "a", "c", ...childIds] },
          });
        }
        await waitFor(() => expect(rowOrder()).toEqual(expectedVisible));
        fireEvent.click(within(active).getByRole("button", { name: /^Active/, expanded: false }));
        expect(within(active).getByRole("button", { name: "Web (3)" })).toBeDefined();
        expect(within(active).getByRole("link", { name: "Web c" })).toBeDefined();
        expect(rendered.rpcCalls.filter((call) => /^(pin|setThreadParent|reorderPinned)$/.test(call.method))).toEqual(
          [],
        );
      },
    );

    it.each(["shelf", "project"].flatMap((fold) => ["keyboard", "pointer"].map((gesture) => ({ fold, gesture }))))(
      "F1 keeps hidden sibling slot: $fold/$gesture",
      async ({ fold, gesture }) => {
        window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
        if (fold === "shelf")
          window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
        else window.localStorage.setItem("bb-sidebar:project-collapse:v1", JSON.stringify(["web"]));
        const order = ["a", "hidden", "b", "ca", "cb"];
        const rendered = renderSlot(inbox, listProps, {
          sidebarThreads: {
            status: "ready",
            projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
            threads: [
              ...["a", "hidden", "b"].map((id) => thread({ id, title: id, projectId: "web", updatedAt: Date.now() })),
              thread({ id: "ca", title: "ca", projectId: "web", parentThreadId: "a", hasPendingInteraction: true }),
              thread({ id: "cb", title: "cb", projectId: "web", parentThreadId: "b", hasPendingInteraction: true }),
            ],
          },
          rpc: {
            getSidebarSettings: () => defaultSidebarSettings,
            listLifecycle: () => ({ rows: [] }),
            listInboxOrder: () => ({ inboxThreadIds: order }),
            reorderInbox: (input) => input,
          },
        });
        const active = screen.getByRole("region", { name: "Active" });
        const visible = () => rowLinks(active).map((e) => e.getAttribute("aria-label"));
        await waitFor(() => expect(visible()).toEqual(["a", "b"]));
        await waitFor(() => expect(rendered.rpcCalls.some((c) => c.method === "listInboxOrder")).toBe(true));
        const a = within(active).getByRole("link", { name: "a" });
        if (gesture === "keyboard") fireEvent.keyDown(a, { key: "ArrowDown", altKey: true });
        else {
          vi.mocked(document.elementFromPoint).mockReturnValue(
            within(active).getByRole("link", { name: "b" }).closest("li")!,
          );
          fireEvent.pointerDown(a, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
          fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 60, pointerId: 1 });
          expect(visible()).toEqual(["b", "a"]);
          fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 1 });
        }
        await waitFor(() => expect(rendered.rpcCalls.filter((c) => c.method === "reorderInbox")).toHaveLength(1));
        const actual = rendered.rpcCalls.find((c) => c.method === "reorderInbox")!.input;
        expect(actual).toEqual({ inboxThreadIds: ["b", "hidden", "a", "ca", "cb"] });
      },
    );
    it.each(["keyboard", "pointer"])("F1 keeps unrepresented project slot: %s", async (gesture) => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      const order = ["a", "hidden-project", "x", "b", "ca", "cx"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          projects: ["web", "hidden-project", "api"].map((id) => ({
            id,
            name: id,
            isPersonal: false,
            href: "",
            settingsHref: "",
          })),
          threads: [
            thread({ id: "a", title: "a", projectId: "web", updatedAt: Date.now() }),
            thread({ id: "b", title: "b", projectId: "web", updatedAt: Date.now() }),
            thread({
              id: "hidden-project",
              title: "hidden-project",
              projectId: "hidden-project",
              updatedAt: Date.now(),
            }),
            thread({ id: "x", title: "x", projectId: "api", updatedAt: Date.now() }),
            thread({ id: "ca", title: "ca", projectId: "web", parentThreadId: "a", hasPendingInteraction: true }),
            thread({ id: "cx", title: "cx", projectId: "api", parentThreadId: "x", hasPendingInteraction: true }),
          ],
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          reorderInbox: (input) => input,
        },
      });
      const active = screen.getByRole("region", { name: "Active" });
      await waitFor(() => expect(rowLinks(active).map((e) => e.getAttribute("aria-label"))).toEqual(["a", "x"]));
      const x = within(active).getByRole("link", { name: "x" });
      if (gesture === "keyboard") fireEvent.keyDown(x, { key: "ArrowUp", altKey: true });
      else {
        vi.mocked(document.elementFromPoint).mockReturnValue(
          within(active).getByRole("link", { name: "a" }).closest("li")!,
        );
        fireEvent.pointerDown(x, { button: 0, clientX: 20, clientY: 90, pointerId: 1 });
        fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
        fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });
      }
      // The unshown project keeps its slot after the project it followed.
      await waitFor(() => expect(savedProjectOrder()).toEqual(["api", "web", "hidden-project"]));
      expect(rendered.rpcCalls.filter((c) => c.method === "reorderInbox")).toEqual([]);
      expect(rowLinks(active).map((e) => e.getAttribute("aria-label"))).toEqual(["x", "a"]);
    });

    it("F1 rebases participating siblings onto a pushed order without moving hidden slots", async () => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      let order = ["a", "hidden", "b", "z", "ca", "cb"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
          threads: [
            ...["a", "hidden", "b", "z"].map((id) =>
              thread({ id, title: id, projectId: "web", updatedAt: Date.now() }),
            ),
            thread({ id: "ca", title: "ca", projectId: "web", parentThreadId: "a", hasPendingInteraction: true }),
            thread({ id: "cb", title: "cb", projectId: "web", parentThreadId: "b", hasPendingInteraction: true }),
          ],
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          reorderInbox: (input) => input,
        },
      });
      const active = screen.getByRole("region", { name: "Active" });
      const visible = () => rowLinks(active).map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(visible()).toEqual(["a", "b"]));
      const a = within(active).getByRole("link", { name: "a" });
      vi.mocked(document.elementFromPoint).mockReturnValue(
        within(active).getByRole("link", { name: "b" }).closest("li")!,
      );
      fireEvent.pointerDown(a, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 60, pointerId: 1 });
      expect(visible()).toEqual(["b", "a"]);
      order = ["z", "a", "hidden", "b", "ca", "cb"];
      await rendered.behavior.emitRealtime("inbox-order", {});
      fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 1 });
      await waitFor(() =>
        expect(rendered.rpcCalls.find((call) => call.method === "reorderInbox")?.input).toEqual({
          inboxThreadIds: ["z", "b", "hidden", "a", "ca", "cb"],
        }),
      );
      expect(visible()).toEqual(["b", "a"]);
    });

    it.each(["singleton-grows", "source-joins-target"])("F2 cancels a vanished moving unit key: %s", async (change) => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      const rows = [
        thread({ id: "a", title: "a", projectId: "web", updatedAt: Date.now() }),
        thread({ id: "x", title: "x", projectId: "api", updatedAt: Date.now() }),
        thread({ id: "y", title: "y", projectId: "zed", updatedAt: Date.now() }),
        thread({ id: "b", title: "b", projectId: "web", updatedAt: Date.now() }),
        ...[
          ["ca", "a", "web"],
          ["cx", "x", "api"],
          ["cy", "y", "zed"],
        ].map(([id, parentThreadId, projectId]) =>
          thread({ id, title: id, parentThreadId, projectId, hasPendingInteraction: true }),
        ),
      ];
      let order = ["a", "x", "y", "b", "ca", "cx", "cy"];
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: null },
        {
          sidebarThreads: {
            status: "ready",
            threads: rows,
            projects: ["web", "api", "zed"].map((id) => ({
              id,
              name: id,
              isPersonal: false,
              href: "",
              settingsHref: "",
            })),
          },
          rpc: {
            getSidebarSettings: () => defaultSidebarSettings,
            listLifecycle: () => ({ rows: [] }),
            listInboxOrder: () => ({ inboxThreadIds: order }),
            reorderInbox: (input) => {
              order = (input as { inboxThreadIds: string[] }).inboxThreadIds;
              return { inboxThreadIds: order };
            },
          },
        },
      );
      const active = screen.getByRole("region", { name: "Active" });
      const visible = () => rowLinks(active).map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(visible()).toEqual(["a", "x", "y"]));
      vi.mocked(document.elementFromPoint).mockReturnValue(
        within(active).getByRole("link", { name: "a" }).closest("li")!,
      );
      fireEvent.pointerDown(within(active).getByRole("link", { name: "x" }), {
        button: 0,
        clientX: 20,
        clientY: 90,
        pointerId: 1,
      });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
      expect(visible()).toEqual(["x", "a", "y"]);
      // Update the public harness input, then refresh through its public event drivers.
      if (change === "singleton-grows") {
        rows.push(thread({ id: "x2", title: "x2", projectId: "api", updatedAt: Date.now() }));
        order = ["a", "x", "y", "b", "x2", "ca", "cx", "cy"];
      } else {
        const index = rows.findIndex((row) => row.id === "x");
        rows[index] = { ...rows[index]!, projectId: "web" };
      }
      const expected = [...order];
      await rendered.behavior.emitRealtime("lifecycle", {});
      await rendered.behavior.emitRealtime("inbox-order", {});
      await waitFor(() => expect(visible()).toEqual(["a", "x", "y"]));
      fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });
      await act(async () => {});
      expect({ order, rpc: rendered.rpcCalls.filter((call) => call.method === "reorderInbox") }).toEqual({
        order: expected,
        rpc: [],
      });
      expect(visible()).toEqual(["a", "x", "y"]);
      expect(active.querySelector("[data-drag-preview]")).toBeNull();
      expect(document.body.style.cursor).toBe("");
    });

    it("F2 preserves the member-shrinks no-op", async () => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      window.localStorage.setItem("bb-sidebar:shelf-expansion:v1", JSON.stringify({ active: false }));
      const rows = [
        ...["a", "hidden", "b"].map((id) => thread({ id, title: id, projectId: "web", updatedAt: Date.now() })),
        thread({ id: "ca", title: "ca", projectId: "web", parentThreadId: "a", hasPendingInteraction: true }),
        thread({ id: "cb", title: "cb", projectId: "web", parentThreadId: "b", hasPendingInteraction: true }),
      ];
      let order = ["a", "hidden", "b", "ca", "cb"];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: rows,
          projects: [{ id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: order }),
          reorderInbox: (input) => input,
        },
      });
      const active = screen.getByRole("region", { name: "Active" });
      const visible = () => rowLinks(active).map((row) => row.getAttribute("aria-label"));
      await waitFor(() => expect(visible()).toEqual(["a", "b"]));
      vi.mocked(document.elementFromPoint).mockReturnValue(
        within(active).getByRole("link", { name: "b" }).closest("li")!,
      );
      fireEvent.pointerDown(within(active).getByRole("link", { name: "a" }), {
        button: 0,
        clientX: 20,
        clientY: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 60, pointerId: 1 });
      expect(visible()).toEqual(["b", "a"]);
      rows.splice(0, rows.length, ...rows.filter((row) => ["a", "ca"].includes(row.id)));
      order = ["a", "ca"];
      await rendered.behavior.emitRealtime("lifecycle", {});
      await rendered.behavior.emitRealtime("inbox-order", {});
      await waitFor(() => expect(visible()).toEqual(["a"]));
      fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 1 });
      await act(async () => {});
      expect(rendered.rpcCalls.filter((call) => call.method === "reorderInbox")).toEqual([]);
      expect(order).toEqual(["a", "ca"]);
      expect(active.querySelector("[data-drag-preview]")).toBeNull();
    });

    it("keeps each project's slot while its threads settle and come back", async () => {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      const settledRow = (threadId: string) => ({
        threadId,
        settledAt: Date.now(),
        snoozedUntil: null,
        snoozedAt: null,
      });
      let lifecycleRows: Array<ReturnType<typeof settledRow>> = [];
      const rows = [
        thread({ id: "w1", projectId: "web", title: "Web one", updatedAt: Date.now() }),
        thread({ id: "x", projectId: "api", title: "Loose X", updatedAt: Date.now() }),
        thread({ id: "y", projectId: "zed", title: "Loose Y", updatedAt: Date.now() }),
        thread({ id: "w2", projectId: "web", title: "Web two", updatedAt: Date.now() }),
      ];
      const rendered = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: rows,
          projects: ["web", "api", "zed", "new"].map((id) => ({
            id,
            name: id[0]!.toUpperCase() + id.slice(1),
            isPersonal: false,
            href: "",
            settingsHref: "",
          })),
        },
        rpc: {
          getSidebarSettings: () => defaultSidebarSettings,
          listLifecycle: () => ({ rows: lifecycleRows }),
          listInboxOrder: () => ({ inboxThreadIds: ["w1", "x", "y", "w2"] }),
        },
      });
      const active = await screen.findByRole("region", { name: "Active" });
      const layout = () =>
        [...active.querySelectorAll("[aria-label]")]
          .map((element) => element.getAttribute("aria-label"))
          .filter((label) => /^(Web|Api|Zed|New) \(|^(Web one|Web two|Loose X|Loose Y|New one)$/.test(label ?? ""));
      const settle = async (...threadIds: string[]) => {
        lifecycleRows = threadIds.map(settledRow);
        await rendered.behavior.emitRealtime("lifecycle", {});
      };
      await waitFor(() => expect(layout()).toEqual(["Web (2)", "Web one", "Web two", "Loose X", "Loose Y"]));
      await waitFor(() => expect(savedProjectOrder()).toEqual(["web", "api", "zed"]));

      // The project's first thread leaves: its other thread keeps the slot.
      await settle("w1");
      await waitFor(() => expect(layout()).toEqual(["Web two", "Loose X", "Loose Y"]));
      // And it comes back to the same place.
      await settle();
      await waitFor(() => expect(layout()).toEqual(["Web (2)", "Web one", "Web two", "Loose X", "Loose Y"]));
      // A project with nothing in Active keeps its slot for when it returns.
      await settle("x");
      await waitFor(() => expect(layout()).toEqual(["Web (2)", "Web one", "Web two", "Loose Y"]));
      await settle();
      await waitFor(() => expect(layout()).toEqual(["Web (2)", "Web one", "Web two", "Loose X", "Loose Y"]));

      // A project new to the view starts at the top.
      rows.push(thread({ id: "n1", projectId: "new", title: "New one", createdAt: Date.now(), updatedAt: Date.now() }));
      await rendered.behavior.emitRealtime("lifecycle", {});
      await waitFor(() => expect(layout()).toEqual(["New one", "Web (2)", "Web one", "Web two", "Loose X", "Loose Y"]));
      await waitFor(() => expect(savedProjectOrder()).toEqual(["new", "web", "api", "zed"]));
      expect(rendered.rpcCalls.filter((call) => call.method.startsWith("reorder"))).toEqual([]);
    });

    function renderProjects(onReorder: (ids: string[]) => void) {
      window.localStorage.setItem("bb-sidebar:active-sort:v1", "project");
      const storedIds = ["w1", "x", "w2", "y"];
      return renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread({ id: "w1", projectId: "web", title: "Web one" }),
            thread({ id: "x", projectId: "api", title: "Loose X" }),
            thread({ id: "w2", projectId: "web", title: "Web two" }),
            thread({ id: "y", projectId: "zed", title: "Loose Y" }),
          ],
          projects: [
            { id: "web", name: "Web", isPersonal: false, href: "", settingsHref: "" },
            { id: "api", name: "Api", isPersonal: false, href: "", settingsHref: "" },
            { id: "zed", name: "Zed", isPersonal: false, href: "", settingsHref: "" },
          ],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          listInboxOrder: () => ({ inboxThreadIds: storedIds }),
          reorderInbox: (input) => {
            const parsed = input as { inboxThreadIds: string[] };
            onReorder(parsed.inboxThreadIds);
            return { inboxThreadIds: parsed.inboxThreadIds };
          },
        },
      });
    }

    it("drags a project header past a lone thread, taking its threads along", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const header = await screen.findByRole("button", { name: "Web (2)" });
      const target = screen.getByText("Loose Y").closest("li")!;
      vi.mocked(document.elementFromPoint).mockReturnValue(target);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 40,
        left: 0,
        right: 200,
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      fireEvent.pointerDown(header, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: 20, clientY: 30, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 20, clientY: 30, pointerId: 1 });

      await waitFor(() => expect(savedProjectOrder()).toEqual(["api", "zed", "web"]));
      expect(saved).toBeNull();
      // The drag must not also toggle the project it started on.
      expect(header.getAttribute("aria-expanded")).toBe("true");
    });

    it("moves a lone thread over a whole project from the keyboard", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const card = await screen.findByRole("link", { name: "Loose X" });
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      await waitFor(() => expect(savedProjectOrder()).toEqual(["api", "web", "zed"]));
      expect(saved).toBeNull();
    });

    it("moves a project header from the keyboard", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const header = await screen.findByRole("button", { name: "Web (2)" });
      fireEvent.keyDown(header, { key: "ArrowDown", altKey: true });
      await waitFor(() => expect(savedProjectOrder()).toEqual(["api", "web", "zed"]));
      expect(saved).toBeNull();
    });

    it("reorders inside a project without moving the project", async () => {
      let saved: string[] | null = null;
      renderProjects((ids) => (saved = ids));
      const card = await screen.findByRole("link", { name: "Web two" });
      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });
      // The project's threads swap within the slots they already held.
      await waitFor(() => expect(saved).toEqual(["w2", "x", "w1", "y"]));
    });
  });
});
