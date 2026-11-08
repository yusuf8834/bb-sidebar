// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import {
  inbox,
  SETTLED_NOTHING,
  thread,
  listProps,
  toastMocks,
  parkingActions,
  parkFromMenu,
  loadInboxApp,
} from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  describe.each(parkingActions)("%s navigation", (action) => {
    it("updates another thread from the context menu without changing the open thread", async () => {
      let settled: string | null = null;
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "open" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "thr_settle", title: "Settle from menu" }),
              thread({ id: "open", title: "Stay here" }),
            ],
            projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: (input) => {
              settled = (input as { threadId: string }).threadId;
              return { ok: true, reclaim: SETTLED_NOTHING };
            },
          },
        },
      );

      await parkFromMenu(await screen.findByText("Settle from menu"), action);
      await waitFor(() => expect(settled).toBe("thr_settle"));
      await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
      expect([
        ...rendered.navigateCalls,
        ...rendered.linkCalls,
        ...rendered.sdkCalls,
        ...rendered.splitSourceCalls,
        ...rendered.threadActionCalls,
      ]).toEqual([]);
    });

    it.each([
      ["an Active", false],
      ["a Pinned", true],
    ])("starts a new thread in the project when leaving %s thread", async (_label, isPinned) => {
      let navigated = 0;
      const rendered = renderSlot(
        inbox,
        {
          ...listProps,
          activeThreadId: "current",
          onNavigate: () => (navigated += 1),
        },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "pin", title: "Other pin", isPinned: true }),
              thread({ id: "current", title: "Current", createdAt: 20, isPinned }),
              thread({ id: "next", title: "Next", createdAt: 10 }),
            ],
            projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({ rows: [] }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      await parkFromMenu(await screen.findByText("Current"), action);
      await waitFor(() =>
        expect(rendered.navigateCalls).toEqual([
          { method: "toCompose", options: { projectId: "proj_1", focusPrompt: true } },
        ]),
      );
      expect(navigated).toBe(1);
    });
  });
});
