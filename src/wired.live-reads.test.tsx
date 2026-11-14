// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { createWired } from "./test-wired";
import { loadInboxApp, thread } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

const item = (id = "a", extra: Parameters<typeof thread>[0] = {}) =>
  thread({ id, title: `Work ${id}`, updatedAt: Date.now(), ...extra });

it("an inbox reorder whose invalidation reaches the app before its reply keeps the new order", async () => {
  const wired = await createWired([item(), item("b")], { deliverBeforeReply: true });
  const slot = wired.mount();
  const view = within(slot.container);
  const first = () => within(view.getByRole("region", { name: "Active" })).getAllByRole("listitem")[0]!.textContent;
  await waitFor(() =>
    expect(slot.rpcReplies).toContainEqual({ method: "listInboxOrder", result: { inboxThreadIds: [] } }),
  );
  expect(first()).toContain("Work a");
  fireEvent.keyDown(view.getByRole("link", { name: "Work a" }), { key: "ArrowDown", altKey: true });
  await waitFor(() =>
    expect(slot.rpcReplies.filter((reply) => reply.method === "listInboxOrder").at(-1)).toEqual({
      method: "listInboxOrder",
      result: { inboxThreadIds: ["b", "a"] },
    }),
  );
  await waitFor(() => expect(first()).toContain("Work b"));
  expect(JSON.parse(localStorage.getItem("bb-sidebar:inbox-order-cache:v1")!)).toEqual(["b", "a"]);
});
