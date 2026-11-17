// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { projectColorsById } from "./project-colors";
import { inbox, defaultSidebarSettings, thread, listProps, deferred, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("parking threads", () => {
  it("previews every Settled row and cleans only after confirmation", async () => {
    const settledThreads = Array.from({ length: 11 }, (_, index) =>
      thread({ id: `thr_${index}`, title: `Finished ${index}` }),
    );
    const previewSettledCleanup = vi.fn((input: unknown) => ({
      token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
      threads: (input as { threadIds: string[] }).threadIds.slice(0, 2).map((threadId, index) => ({
        threadId,
        title: threadId,
        terminalCount: index === 0 ? 1 : 0,
        ports: index === 1 ? [3000] : [],
      })),
      skipped: [],
    }));
    const cleanSettled = vi.fn(() => ({
      closedTerminals: 1,
      signalledPorts: [{ threadId: "thr_1", port: 3000 }],
      remainingPorts: [],
      skipped: [],
      failed: [],
    }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: settledThreads,
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: settledThreads.map((item) => ({
            threadId: item.id,
            settledAt: 200,
            snoozedUntil: null,
            snoozedAt: null,
          })),
        }),
        previewSettledCleanup,
        cleanSettled,
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    await waitFor(() => expect(previewSettledCleanup).toHaveBeenCalledTimes(1));
    expect(new Set((previewSettledCleanup.mock.calls[0]![0] as { threadIds: string[] }).threadIds)).toEqual(
      new Set(settledThreads.map((item) => item.id)),
    );
    expect(dialog.textContent).toContain("1 terminal to close · 1 listening port to stop");
    expect(dialog.textContent).not.toContain("0 terminals");
    expect(dialog.textContent).not.toContain("session");
    expect(within(dialog).queryByText("thr_2")).toBeNull();
    expect(cleanSettled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clean resources" }));
    await waitFor(() => expect(cleanSettled).toHaveBeenCalledWith({ token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55" }));
    expect(dialog.textContent).toContain("1 terminal closed · 1 port shutdown request sent");
  });

  it("names a mention-titled workspace owner in a skip reason the way bb shows it", async () => {
    const settled = thread({ id: "thr_settled", title: "Finished" });
    const owner = thread({ id: "thr_owner", title: "Review @thread:thr_x", displayTitle: "Review Login fix" });
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [settled, owner],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [{ threadId: "thr_settled", settledAt: 200, snoozedUntil: null, snoozedAt: null }],
        }),
        previewSettledCleanup: () => ({
          token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
          threads: [],
          skipped: [
            {
              threadId: "thr_settled",
              resource: "terminal",
              message: 'Kept 1 terminal open: shares a workspace with "Review @thread:thr_x", which is not settled',
            },
          ],
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    await waitFor(() => expect(dialog.textContent).toContain('shares a workspace with "Review Login fix"'));
    expect(dialog.textContent).not.toContain("@thread:thr_x");
  });

  it("marks each project's rows with that project's own soft colour", async () => {
    const settled = [
      thread({ id: "thr_a", title: "In bb" }),
      thread({ id: "thr_b", title: "Also bb" }),
      thread({ id: "thr_c", title: "In Git-Local", projectId: "proj_2" }),
    ];
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: settled,
        projects: [
          { id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" },
          { id: "proj_2", name: "Git-Local", isPersonal: false, href: "", settingsHref: "" },
        ],
      },
      rpc: {
        getSidebarSettings: () => ({
          ...defaultSidebarSettings,
          projectColorsEnabled: true,
          projectColorDisplay: "all",
        }),
        getProjectColors: () => ({ colors: {} }),
        listLifecycle: () => ({
          rows: settled.map((item) => ({
            threadId: item.id,
            settledAt: 200,
            snoozedUntil: null,
            snoozedAt: null,
          })),
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: /Settled/ }));
    const stripeOf = async (title: string) =>
      (await within(shelf).findByText(title))
        .closest("li")!
        .querySelector("[data-project-stripe]")!
        .getAttribute("style");
    const colors = projectColorsById(["proj_1", "proj_2"], {});
    expect(colors.get("proj_1")).not.toBe(colors.get("proj_2"));
    expect(await stripeOf("In bb")).toContain(colors.get("proj_1")!);
    expect(await stripeOf("Also bb")).toContain(colors.get("proj_1")!);
    expect(await stripeOf("In Git-Local")).toContain(colors.get("proj_2")!);
    const name = within((await within(shelf).findByText("In Git-Local")).closest("li")!).getByText("Git-Local");
    expect(name.className).toContain("bb-sidebar-project-name");
    expect(name.style.getPropertyValue("--bb-sidebar-project")).toBe(colors.get("proj_2"));
  });

  it("shows an empty preview without a Clean confirmation button", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_empty", title: "Finished" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [{ threadId: "thr_empty", settledAt: 200, snoozedUntil: null, snoozedAt: null }],
        }),
        previewSettledCleanup: () => ({ token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55", threads: [], skipped: [] }),
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    await waitFor(() =>
      expect(dialog.textContent).toContain("No live terminals or thread-owned listening ports found."),
    );
    expect(within(dialog).queryByRole("button", { name: "Clean resources" })).toBeNull();
  });

  it("opens a thread from the Clean preview and closes the dialog", async () => {
    const onNavigate = vi.fn();
    const rendered = renderSlot(
      inbox,
      { ...listProps, onNavigate },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_terminal", title: "Check this terminal" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        rpc: {
          listLifecycle: () => ({
            rows: [{ threadId: "thr_terminal", settledAt: 200, snoozedUntil: null, snoozedAt: null }],
          }),
          previewSettledCleanup: () => ({
            token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
            threads: [{ threadId: "thr_terminal", title: "Check this terminal", terminalCount: 1, ports: [] }],
            skipped: [],
          }),
        },
      },
    );
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Open thread: Check this terminal" }));
    expect(rendered.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_terminal" });
    expect(onNavigate).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Clean settled resources?" })).toBeNull());
  });

  it("keeps the Clean preview open while cleanup is running", async () => {
    const pending = deferred<{
      closedTerminals: number;
      signalledPorts: never[];
      remainingPorts: never[];
      skipped: never[];
      failed: never[];
    }>();
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_terminal", title: "Check this terminal" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: [{ threadId: "thr_terminal", settledAt: 200, snoozedUntil: null, snoozedAt: null }],
        }),
        previewSettledCleanup: () => ({
          token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
          threads: [{ threadId: "thr_terminal", title: "Check this terminal", terminalCount: 1, ports: [] }],
          skipped: [],
        }),
        cleanSettled: () => pending.promise,
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    const cleanButton = await within(dialog).findByRole("button", { name: "Clean resources" });
    fireEvent.click(cleanButton);
    const openButton = within(dialog).getByRole("button", { name: "Open thread: Check this terminal" });
    expect(openButton).toHaveProperty("disabled", true);
    fireEvent.click(openButton);
    expect(rendered.navigateCalls).not.toContainEqual({ method: "toThread", threadId: "thr_terminal" });
    expect(screen.getByRole("dialog", { name: "Clean settled resources?" })).toBeDefined();
    pending.resolve({ closedTerminals: 1, signalledPorts: [], remainingPorts: [], skipped: [], failed: [] });
    await waitFor(() => expect(dialog.textContent).toContain("1 terminal closed"));
  });

  it("keeps cleanup failures visible after the last thread leaves Settled", async () => {
    const pending = deferred<never>();
    let settled = true;
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_terminal", title: "Last settled thread" })],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: settled ? [{ threadId: "thr_terminal", settledAt: 200, snoozedUntil: null, snoozedAt: null }] : [],
        }),
        previewSettledCleanup: () => ({
          token: "98bb67b5-b58b-4fc4-9a55-34e557dc8f55",
          threads: [{ threadId: "thr_terminal", title: "Last settled thread", terminalCount: 1, ports: [] }],
          skipped: [],
        }),
        cleanSettled: () => pending.promise,
      },
    });
    const shelf = await screen.findByRole("region", { name: "Settled" });
    fireEvent.click(within(shelf).getByRole("button", { name: "Close terminals and ports of settled threads" }));
    const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Clean resources" }));
    await within(dialog).findByRole("button", { name: "Cleaning..." });

    settled = false;
    await rendered.experimental_invalidateRpc(["lifecycle"]);
    await waitFor(() => expect(shelf.hidden).toBe(true));
    expect(screen.getByRole("dialog", { name: "Clean settled resources?" })).toBe(dialog);

    await act(async () => pending.reject(new Error("Cleanup connection lost")));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Cleanup connection lost");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false);
  });
});
