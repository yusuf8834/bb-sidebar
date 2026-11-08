// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, SETTLED_NOTHING, thread, listProps, parkFromMenu, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("row context menu", () => {
  describe.each([
    ["Parked", "settle"],
    ["Parked", "snooze"],
    ["Snoozed", "settle"],
    ["Snoozed", "park"],
    ["Settled", "snooze"],
    ["Settled", "park"],
  ] as const)("%s compact card: %s", (shelf, action) => {
    it("starts a new thread in the project", async () => {
      const now = Date.now();
      const rendered = renderSlot(
        inbox,
        { ...listProps, activeThreadId: "current" },
        {
          sidebarThreads: {
            status: "ready",
            threads: [
              thread({ id: "current", title: "Current" }),
              thread({ id: "pin", title: "Pin", isPinned: true }),
              thread({ id: "active", title: "Active" }),
            ],
            projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
          },
          rpc: {
            listLifecycle: () => ({
              rows: [
                {
                  threadId: "current",
                  parkedAt: shelf === "Parked" ? now : null,
                  settledAt: shelf === "Settled" ? now : null,
                  snoozedUntil: shelf === "Snoozed" ? now + 60_000 : null,
                  snoozedAt: shelf === "Snoozed" ? now : null,
                },
              ],
            }),
            [action]: () => ({ ok: true, reclaim: SETTLED_NOTHING }),
          },
        },
      );

      const region = await screen.findByRole("region", { name: shelf });
      await parkFromMenu(within(region).getByText("Current"), action);
      await waitFor(() =>
        expect(rendered.navigateCalls).toEqual([
          { method: "toCompose", options: { projectId: "proj_1", focusPrompt: true } },
        ]),
      );
    });
  });
});
