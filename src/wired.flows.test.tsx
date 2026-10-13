// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createWired } from "./test-wired";
import { loadInboxApp, thread, toastMocks, parkFromCard } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

const item = (id = "a", extra: Parameters<typeof thread>[0] = {}) =>
  thread({ id, title: `Work ${id}`, updatedAt: Date.now(), ...extra });
const row = (title = "Work a") => screen.getByText(title).closest("li")!;
const lifecycle = (wired: Awaited<ReturnType<typeof createWired>>, id = "a") =>
  wired.db.prepare("SELECT * FROM thread_lifecycle WHERE thread_id = ?").get(id);
async function shelf(name: string) {
  const region = await screen.findByRole("region", { name });
  const heading = within(region).getByRole("button", { name: new RegExp(`^${name}`) });
  if (heading.getAttribute("aria-expanded") === "false") fireEvent.click(heading);
  return region;
}
async function saved(wired: Awaited<ReturnType<typeof createWired>>, column: string, value: unknown, id = "a") {
  await waitFor(() => expect(lifecycle(wired, id)).toMatchObject({ [column]: value }));
  await wired.flush();
}

it("snoozes through the picker, wakes on the clock, and dismisses the durable Woke marker", async () => {
  const wired = await createWired([item()]);
  wired.mount();
  await screen.findByText("Work a");
  vi.useFakeTimers();
  fireEvent.keyDown(within(row()).getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: "1 hour" }));
  await wired.advance(1);
  const storedSnooze = lifecycle(wired) as { snoozed_until: number; snoozed_at: number };
  expect(storedSnooze.snoozed_until - storedSnooze.snoozed_at).toBe(3600_000);
  const snoozed = screen.getByRole("region", { name: "Snoozed" });
  fireEvent.click(within(snoozed).getByRole("button", { name: /^Snoozed/ }));
  expect(within(snoozed).getByText("Work a")).toBeDefined();
  await wired.advance(60 * 60_000 + 50);
  expect(screen.getByRole("button", { name: "Dismiss Woke marker" })).toBeDefined();
  expect(lifecycle(wired)).toEqual(storedSnooze);
  expect(storedSnooze.snoozed_until).toBeLessThanOrEqual(Date.now());
  fireEvent.click(screen.getByRole("button", { name: "Dismiss Woke marker" }));
  await wired.advance(1);
  expect(lifecycle(wired)).toBeUndefined();
  expect(screen.queryByRole("button", { name: "Dismiss Woke marker" })).toBeNull();
});

it("parks through the card and resumes from Parked", async () => {
  const wired = await createWired([item()]);
  wired.mount();
  await screen.findByText("Work a");
  await parkFromCard(row(), "park");
  await waitFor(() => expect(lifecycle(wired)).toMatchObject({ parked_at: expect.any(Number) }));
  await wired.flush();
  const parked = await shelf("Parked");
  expect(within(parked).getByText("Work a")).toBeDefined();
  fireEvent.click(within(parked).getByRole("button", { name: "Resume thread" }));
  await saved(wired, "settled_override", "active");
  expect(within(await screen.findByRole("region", { name: "Active" })).getByText("Work a")).toBeDefined();
  expect(lifecycle(wired)).toMatchObject({ parked_at: null });
});

it("settles a tree and Undo restores the parent's park and child's snooze", async () => {
  const wired = await createWired([item(), item("child", { parentThreadId: "a" })]);
  await wired.call("park", { threadId: "a" });
  await wired.call("snooze", { threadId: "child", snoozedUntil: Date.now() + 3600_000 });
  const before = [lifecycle(wired), lifecycle(wired, "child")];
  wired.mount();
  const parked = await shelf("Parked");
  fireEvent.contextMenu(within(parked).getByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Settle" }));
  await saved(wired, "settled_override", "settled");
  expect(lifecycle(wired, "child")).toMatchObject({ settled_override: "settled" });
  expect(within(await shelf("Settled")).getByText("Work a")).toBeDefined();
  await waitFor(() =>
    expect(toastMocks.success.mock.calls.some(([message]) => message === "Thread settled")).toBe(true),
  );
  const toast = toastMocks.success.mock.calls.find(([message]) => message === "Thread settled")!;
  await act(async () => toast[1].action.onClick());
  await waitFor(() => expect([lifecycle(wired), lifecycle(wired, "child")]).toEqual(before));
  await wired.flush();
  expect(within(await shelf("Parked")).getByText("Work a")).toBeDefined();
  await wired.call("resume", { threadId: "a" });
  fireEvent.click(await screen.findByRole("button", { name: "1 child thread" }));
  expect(screen.getByText("Work child")).toBeDefined();
});

it("pins from the menu and persists a keyboard manual reorder through server and cache remounts", async () => {
  const wired = await createWired([item(), item("b"), item("pin")]);
  const initial = wired.mount();
  fireEvent.contextMenu(await screen.findByText("Work pin"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
  await saved(wired, "settled_override", "active", "pin");
  expect(initial.inspection.rpcCalls).toContainEqual({ method: "pin", input: { threadId: "pin" } });
  // The SDK has no sidebar snapshot update driver; native pin state is read on remount.
  wired.unmount(initial);
  expect(wired.harness.inspection.sdk.callsTo("threads.pin")).toHaveLength(1);
  let slot = wired.mount();
  const sender = within(slot.container);
  await within(await sender.findByRole("region", { name: "Pinned" })).findByText("Work pin");
  const receiver = wired.mount();
  const observer = within(receiver.container);
  // Its initial read must finish before the mutation; only realtime can then refresh it.
  await waitFor(() =>
    expect(receiver.rpcReplies).toContainEqual({
      method: "listInboxOrder",
      result: { inboxThreadIds: [] },
    }),
  );
  expect(within(observer.getByRole("region", { name: "Active" })).getAllByRole("listitem")[0]!.textContent).toContain(
    "Work a",
  );
  fireEvent.keyDown(sender.getByRole("link", { name: "Work a" }), { key: "ArrowDown", altKey: true });
  await waitFor(() =>
    expect(wired.db.prepare("SELECT thread_id FROM inbox_order ORDER BY sort_index").all()).toEqual([
      { thread_id: "b" },
      { thread_id: "a" },
    ]),
  );
  await wired.flush();
  expect(JSON.parse(localStorage.getItem("bb-sidebar:inbox-order-cache:v1")!)).toEqual(["b", "a"]);
  await waitFor(() =>
    expect(within(observer.getByRole("region", { name: "Active" })).getAllByRole("listitem")[0]!.textContent).toContain(
      "Work b",
    ),
  );
  expect(receiver.rpcReplies).toContainEqual({ method: "listInboxOrder", result: { inboxThreadIds: ["b", "a"] } });
  wired.unmount(receiver);
  wired.unmount(slot);
  slot = wired.mount();
  expect(within(screen.getByRole("region", { name: "Active" })).getAllByRole("listitem")[0]!.textContent).toContain(
    "Work b",
  );
  wired.unmount(slot);
  localStorage.removeItem("bb-sidebar:inbox-order-cache:v1");
  wired.mount();
  await waitFor(() =>
    expect(within(screen.getByRole("region", { name: "Active" })).getAllByRole("listitem")[0]!.textContent).toContain(
      "Work b",
    ),
  );
});

it("saves settings in the real settings slot and publishes the Working shelf to the inbox", async () => {
  const wired = await createWired([item("busy", { indicator: "runtime", runtimeStatus: "active" })]);
  wired.mount();
  wired.mount("settings");
  const toggle = await screen.findByRole("switch", { name: "Working shelf" });
  vi.useFakeTimers();
  fireEvent.click(toggle);
  await wired.advance(500);
  expect(
    wired.db.prepare("SELECT json_extract(settings_json, '$.workingShelf') AS enabled FROM sidebar_settings").get(),
  ).toEqual({ enabled: 1 });
  expect(within(screen.getByRole("region", { name: "Working" })).getByText("Work busy")).toBeDefined();
  expect(await wired.call("getSidebarSettings")).toMatchObject({ workingShelf: true });
});

it("publishes a custom project color to both stripe and name", async () => {
  const wired = await createWired([item()]);
  await wired.call("updateSidebarSettings", { projectColorsEnabled: true });
  const slot = wired.mount();
  // The default stripe can render before the first read finishes; wait for that reply too.
  await waitFor(() => expect(slot.rpcReplies).toContainEqual({ method: "getProjectColors", result: { colors: {} } }));
  await waitFor(() =>
    expect(
      (row().querySelector("[data-project-stripe]") as HTMLElement).style.getPropertyValue("--bb-sidebar-project"),
    ).toBe("#c398bf"),
  );
  await wired.call("setProjectColor", { projectId: "proj_1", color: "#123456" });
  await waitFor(() =>
    expect(
      (row().querySelector("[data-project-stripe]") as HTMLElement).style.getPropertyValue("--bb-sidebar-project"),
    ).toBe("#123456"),
  );
  expect(
    (row().querySelector(".bb-sidebar-project-name") as HTMLElement).style.getPropertyValue("--bb-sidebar-project"),
  ).toBe("#123456");
  expect(wired.db.prepare("SELECT * FROM project_colors").all()).toEqual([{ project_id: "proj_1", color: "#123456" }]);
});

it("child activity publishes lifecycle changes that reopen a settled parent", async () => {
  const wired = await createWired([item(), item("child", { parentThreadId: "a" })]);
  await wired.call("settle", { threadId: "a" });
  wired.mount();
  expect(within(await shelf("Settled")).getByText("Work a")).toBeDefined();
  await wired.event("thread.active", "child");
  expect(lifecycle(wired)).toBeUndefined();
  expect(lifecycle(wired, "child")).toBeUndefined();
  await within(await screen.findByRole("region", { name: "Active" })).findByText("Work a");
});

it("Clean uses the real preview token and renders the cleanup result shape", async () => {
  const wired = await createWired([item()], { terminals: true });
  // Seed only lifecycle: settling would intentionally reclaim the terminal first.
  wired.db
    .prepare("INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override) VALUES (?, ?, 'settled')")
    .run("a", Date.now());
  const slot = wired.mount();
  const settled = await shelf("Settled");
  fireEvent.click(within(settled).getByRole("button", { name: "Close terminals and ports of settled threads" }));
  const dialog = await screen.findByRole("dialog", { name: "Clean settled resources?" });
  await within(dialog).findByText("1 terminal to close");
  fireEvent.click(within(dialog).getByRole("button", { name: "Clean resources" }));
  await waitFor(() => expect(dialog.textContent).toContain("1 terminal closed"));
  expect(slot.inspection.rpcCalls.find((call) => call.method === "cleanSettled")?.input).toEqual({
    token: expect.any(String),
  });
  expect(wired.harness.inspection.sdk.callsTo("terminals.close")[0]).toEqual([
    { terminalId: "terminal_1", mode: "force" },
  ]);
  expect(lifecycle(wired)).toMatchObject({ settled_override: "settled" });
  const preview = (await wired.call("previewSettledCleanup", { threadIds: ["a"] })) as { token: string };
  expect(await wired.call("cleanSettled", { token: preview.token })).toEqual({
    closedTerminals: 0,
    signalledPorts: [],
    remainingPorts: [],
    skipped: [],
    failed: [],
  });
});

it("thread.deleted clears lifecycle and order and publishes both channels to the app", async () => {
  const wired = await createWired([item(), item("b")]);
  await wired.call("park", { threadId: "a" });
  await wired.call("park", { threadId: "b" });
  await wired.call("reorderInbox", { inboxThreadIds: ["a", "b"] });
  wired.mount();
  const parked = await shelf("Parked");
  expect(within(parked).getByText("Work a")).toBeDefined();
  await wired.event("thread.deleted", "a");
  expect(lifecycle(wired)).toBeUndefined();
  expect(wired.db.prepare("SELECT thread_id FROM inbox_order ORDER BY sort_index").all()).toEqual([{ thread_id: "b" }]);
  await waitFor(() => expect(JSON.parse(localStorage.getItem("bb-sidebar:inbox-order-cache:v1")!)).toEqual(["b"]));
  expect(
    JSON.parse(localStorage.getItem("bb-sidebar:lifecycle-cache:v1")!).map((row: { threadId: string }) => row.threadId),
  ).toEqual(["b"]);
  const remaining = screen.getByRole("region", { name: "Parked" });
  expect(within(remaining).getByText("Work b")).toBeDefined();
  expect(within(remaining).queryByText("Work a")).toBeNull();
  expect(within(remaining).getAllByRole("listitem")).toHaveLength(1);
});

it("pins a parked root through lifecycle policy, then unpins through the bound core action", async () => {
  const wired = await createWired([item()]);
  await wired.call("park", { threadId: "a" });
  let slot = wired.mount();
  fireEvent.contextMenu(within(await shelf("Parked")).getByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
  await saved(wired, "settled_override", "active");
  expect(lifecycle(wired)).toMatchObject({ parked_at: null, snoozed_until: null, settled_at: null });
  expect(wired.harness.inspection.sdk.callsTo("threads.pin")).toEqual([[{ threadId: "a" }]]);
  expect((await wired.bb.sdk.threads.get({ threadId: "a" })).pinnedAt).toEqual(expect.any(Number));
  wired.unmount(slot);
  slot = wired.mount();
  fireEvent.click(await screen.findByRole("button", { name: "Unpin Work a" }));
  await waitFor(() => expect(slot.sdkCalls).toContainEqual({ method: "threads.unpin", args: [{ threadId: "a" }] }));
  expect(slot.threadActionCalls).toContainEqual({ key: "bb--core/pin", threadId: "a" });
  expect(wired.harness.inspection.sdk.callsTo("threads.unpin").at(-1)).toEqual([{ threadId: "a" }]);
  expect((await wired.bb.sdk.threads.get({ threadId: "a" })).pinnedAt).toBeNull();
});

it.each([false, true])("changes unread=%s through the bound read action and SDK", async (isUnread) => {
  const wired = await createWired([item("a", { isUnread })]);
  const slot = wired.mount();
  fireEvent.contextMenu(await screen.findByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: isUnread ? "Mark read" : "Mark unread" }));
  const method = isUnread ? "threads.markRead" : "threads.markUnread";
  await waitFor(() => expect(wired.harness.inspection.sdk.callsTo(method)).toEqual([[{ threadId: "a" }]]));
  expect(slot.threadActionCalls).toContainEqual({ key: "bb--core/read", threadId: "a" });
  const saved = await wired.bb.sdk.threads.get({ threadId: "a" });
  expect(saved.lastReadAt).toEqual(isUnread ? expect.any(Number) : null);
});

it("requests inline rename through the bound action and writes the title through the SDK", async () => {
  const wired = await createWired([item()]);
  const slot = wired.mount();
  fireEvent.contextMenu(await screen.findByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = await screen.findByRole("textbox", { name: "Rename Work a" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(document.activeElement).toBe(input);
  expect(slot.threadActionCalls).toContainEqual({ key: "bb--core/rename", threadId: "a" });
  expect(wired.harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
  fireEvent.change(input, { target: { value: "Renamed work" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(wired.harness.inspection.sdk.callsTo("threads.update")).toEqual([
      [{ threadId: "a", title: "Renamed work" }],
    ]),
  );
  expect((await wired.bb.sdk.threads.get({ threadId: "a" })).title).toBe("Renamed work");
});

it.each(["Title write unavailable", "HTTP 500: Title write unavailable"])(
  "preserves the native rename error toast for %s without an unhandled rejection or a changed server title",
  async (message) => {
    const wired = await createWired([item()]);
    wired.harness.inspection.sdk.stub("threads.update", async () => {
      throw new Error(message);
    });
    wired.mount();
    fireEvent.doubleClick(await screen.findByRole("link", { name: "Work a" }));
    const input = await screen.findByRole("textbox", { name: "Rename Work a" });
    fireEvent.change(input, { target: { value: "Rejected title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(wired.harness.inspection.sdk.callsTo("threads.update")).toEqual([
        [{ threadId: "a", title: "Rejected title" }],
      ]),
    );
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to update thread", {
        className: "bb-sidebar-toast",
        description: "Title write unavailable",
      }),
    );
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
    expect((await wired.bb.sdk.threads.get({ threadId: "a" })).title).toBe("Work a");
  },
);

it("hands a parent archive to the bound action, waits for child confirmation, and undoes the tree", async () => {
  const wired = await createWired([
    item(),
    item("child", { parentThreadId: "a" }),
    item("grandchild", { parentThreadId: "child" }),
    item("b"),
  ]);
  const slot = wired.mount();
  fireEvent.contextMenu(await screen.findByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(wired.archiveRequests).toHaveLength(1));
  expect(slot.threadActionCalls).toContainEqual({ key: "bb--core/archive", threadId: "a" });
  expect(wired.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  await act(async () => {
    await wired.archiveRequests[0]!.confirm();
  });
  expect(wired.harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "a" }]]);
  for (const threadId of ["a", "child", "grandchild"]) {
    expect((await wired.bb.sdk.threads.get({ threadId })).archivedAt).toEqual(expect.any(Number));
  }
  expect((await wired.bb.sdk.threads.get({ threadId: "b" })).archivedAt).toBeNull();
  const archiveToasts = toastMocks.success.mock.calls.filter(([message]) => message === "Thread archived");
  expect(archiveToasts).toHaveLength(1);
  expect(archiveToasts[0]![1].action.label).toBe("Undo");
  await act(async () => {
    await archiveToasts[0]![1].action.onClick();
  });
  expect(wired.harness.inspection.sdk.callsTo("threads.unarchive")).toEqual([
    [{ threadId: "a" }],
    [{ threadId: "child" }],
    [{ threadId: "grandchild" }],
  ]);
  for (const threadId of ["a", "child", "grandchild"]) {
    expect((await wired.bb.sdk.threads.get({ threadId })).archivedAt).toBeNull();
  }
});

it("cancels the host archive request without archiving or offering Undo", async () => {
  const wired = await createWired([item(), item("child", { parentThreadId: "a" })]);
  wired.mount();
  fireEvent.contextMenu(await screen.findByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() => expect(wired.archiveRequests).toHaveLength(1));
  await act(async () => wired.archiveRequests[0]!.cancel());
  expect(wired.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  expect(toastMocks.success).not.toHaveBeenCalled();
});

it("keeps the named delete confirmation and sends its confirmed tree through the plugin RPC", async () => {
  const wired = await createWired([item(), item("child", { parentThreadId: "a" })]);
  const slot = wired.mount();
  fireEvent.contextMenu(await screen.findByText("Work a"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete thread?" });
  expect(within(dialog).getByText("Work a")).toBeDefined();
  expect(within(dialog).getByText("Sidebar")).toBeDefined();
  expect(within(dialog).getByText(/its 1 child thread/)).toBeDefined();
  expect(wired.harness.inspection.sdk.callsTo("threads.delete")).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete thread" }));
  await waitFor(() =>
    expect(wired.harness.inspection.sdk.callsTo("threads.delete")).toEqual([
      [{ threadId: "a", childThreadsConfirmed: true }],
    ]),
  );
  expect(slot.rpcCalls).toContainEqual({
    method: "deleteThread",
    input: { threadId: "a", childThreadsConfirmed: true },
  });
  expect(slot.threadActionCalls.some((call) => call.key === "bb--core/delete")).toBe(false);
  await expect(wired.bb.sdk.threads.get({ threadId: "child" })).rejects.toThrow("Unknown thread child");
});
