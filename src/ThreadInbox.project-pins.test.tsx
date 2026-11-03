// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createEvent, fireEvent, screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";
import { STORAGE_KEYS } from "./lib/storage-keys";

await loadInboxApp();

const projects = ["Alpha", "Beta", "Empty"].map((name) => ({
  id: name,
  name,
  isPersonal: false,
  href: "",
  settingsHref: "",
}));

function renderProjects() {
  return renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      projects,
      threads: ["Alpha", "Beta"].map((id) => thread({ id, projectId: id, title: `${id} thread` })),
    },
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

function filterField() {
  return screen.getByRole("combobox", { name: "Filter threads" });
}

function typeFilter(value: string) {
  const field = filterField();
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value } });
  return field;
}

function chips() {
  return screen.queryAllByRole("button", { name: / from filter$/ }).map((chip) => chip.textContent);
}

function shortcutOrder() {
  return within(screen.getByRole("group", { name: "Pinned projects" }))
    .getAllByRole("button")
    .map((button) => button.textContent);
}

function dragProject(source: HTMLElement, target: HTMLElement, placement: "before" | "after") {
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 40, 80, 28));
  fireEvent.dragStart(source, { dataTransfer });
  const over = createEvent.dragOver(target, { dataTransfer });
  Object.defineProperty(over, "clientX", { value: placement === "before" ? 110 : 170 });
  fireEvent(target, over);
  return () => {
    const drop = createEvent.drop(target, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: placement === "before" ? 110 : 170 });
    fireEvent(target, drop);
    fireEvent.dragEnd(source, { dataTransfer });
  };
}

it("drags pinned projects before and after other shortcuts and persists the order without filtering", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Alpha", "Beta", "Empty"]));
  const rendered = renderProjects();
  const alpha = screen.getByRole("button", { name: "Filter by Alpha" });
  const empty = screen.getByRole("button", { name: "Filter by Empty" });
  expect(alpha.draggable).toBe(true);
  const drop = dragProject(alpha, empty, "after");
  expect(shortcutOrder()).toEqual(["Alpha", "Beta", "Empty"]);
  drop();
  expect(shortcutOrder()).toEqual(["Beta", "Empty", "Alpha"]);
  dragProject(empty, screen.getByRole("button", { name: "Filter by Beta" }), "before")();
  expect(shortcutOrder()).toEqual(["Empty", "Beta", "Alpha"]);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Empty", "Beta", "Alpha"]);
  expect(chips()).toEqual([]);
  rendered.lifecycle.unmount();
  renderProjects();
  expect(shortcutOrder()).toEqual(["Empty", "Beta", "Alpha"]);
  fireEvent.click(screen.getByRole("button", { name: "Filter by Beta" }));
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: true })).toBeDefined();
});

it("leaves pin order and filters unchanged when a drag is cancelled or an external item is dropped", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Alpha", "Beta"]));
  renderProjects();
  const alpha = screen.getByRole("button", { name: "Filter by Alpha" });
  const beta = screen.getByRole("button", { name: "Filter by Beta" });
  dragProject(alpha, beta, "after");
  fireEvent.dragEnd(alpha);
  fireEvent.drop(beta);
  expect(shortcutOrder()).toEqual(["Alpha", "Beta"]);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Alpha", "Beta"]);
  expect(chips()).toEqual([]);
});

it("reorders project pins with Alt+Left/Right, keeps focus, and stops at either end", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Alpha", "Beta", "Empty"]));
  renderProjects();
  const beta = screen.getByRole("button", { name: "Filter by Beta" });
  beta.focus();
  fireEvent.keyDown(beta, { key: "ArrowLeft" });
  expect(shortcutOrder()).toEqual(["Alpha", "Beta", "Empty"]);
  fireEvent.keyDown(beta, { key: "ArrowLeft", altKey: true });
  expect(shortcutOrder()).toEqual(["Beta", "Alpha", "Empty"]);
  expect(document.activeElement).toBe(beta);
  fireEvent.keyDown(beta, { key: "ArrowLeft", altKey: true });
  expect(shortcutOrder()).toEqual(["Beta", "Alpha", "Empty"]);
  fireEvent.keyDown(beta, { key: "ArrowRight", altKey: true });
  fireEvent.keyDown(beta, { key: "ArrowRight", altKey: true });
  fireEvent.keyDown(beta, { key: "ArrowRight", altKey: true });
  expect(shortcutOrder()).toEqual(["Alpha", "Empty", "Beta"]);
  expect(document.activeElement).toBe(beta);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Alpha", "Empty", "Beta"]);
  expect(chips()).toEqual([]);
});

it("pins independently of selection, persists shortcuts, and toggles multiple project filters", () => {
  const rendered = renderProjects();
  expect(screen.queryByRole("group", { name: "Pinned projects" })).toBeNull();
  typeFilter("[");
  fireEvent.click(screen.getByRole("button", { name: "Pin Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin Alpha" }));
  expect(chips()).toEqual([]);
  expect(screen.getByRole("listbox", { name: "Filter suggestions" })).toBeDefined();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Beta", "Alpha"]);
  fireEvent.keyDown(filterField(), { key: "Escape" });
  fireEvent.keyDown(filterField(), { key: "Escape" });
  const shortcuts = screen.getByRole("group", { name: "Pinned projects" });
  expect(shortcutOrder()).toEqual(["Beta", "Alpha"]);
  fireEvent.click(within(shortcuts).getByRole("button", { name: "Filter by Beta" }));
  expect(screen.queryByText("Alpha thread")).toBeNull();
  expect(screen.getByText("Beta thread")).toBeDefined();
  expect(within(shortcuts).getByRole("button", { name: "Filter by Beta", pressed: true })).toBeDefined();
  expect(chips()).toEqual(["Beta"]);
  fireEvent.click(within(shortcuts).getByRole("button", { name: "Filter by Alpha" }));
  expect(screen.getByText("Beta thread")).toBeDefined();
  expect(screen.getByText("Alpha thread")).toBeDefined();
  expect(chips()).toEqual(["Beta", "Alpha"]);
  expect(within(shortcuts).getAllByRole("button", { pressed: true })).toHaveLength(2);
  fireEvent.click(within(shortcuts).getByRole("button", { name: "Filter by Alpha" }));
  expect(screen.getByText("Beta thread")).toBeDefined();
  expect(screen.queryByText("Alpha thread")).toBeNull();

  rendered.lifecycle.unmount();
  renderProjects();
  expect(within(screen.getByRole("group", { name: "Pinned projects" })).getAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: true })).toBeDefined();
  typeFilter("[Bet");
  fireEvent.click(screen.getByRole("button", { name: "Unpin Beta" }));
  expect(screen.queryByRole("button", { name: "Filter by Beta" })).toBeNull();
  expect(chips()).toEqual(["Beta"]);
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(chips()).toEqual([]);
  expect(screen.getByRole("button", { name: "Filter by Alpha" })).toBeDefined();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pinnedProjects.key)!)).toEqual(["Alpha"]);
});

it("shows pinned and typed selections as one chip row and clears without removing pins", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Beta"]));
  renderProjects();
  fireEvent.click(screen.getByRole("button", { name: "Filter by Beta" }));
  const field = typeFilter("[Alp");
  fireEvent.keyDown(field, { key: "Enter" });
  expect(chips()).toEqual(["Beta", "Alpha"]);
  fireEvent.keyDown(field, { key: "Backspace" });
  expect(chips()).toEqual(["Beta"]);
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: true })).toBeDefined();
  fireEvent.keyDown(field, { key: "Backspace", ctrlKey: true });
  expect(chips()).toEqual([]);
  expect(screen.getByRole("button", { name: "Filter by Beta", pressed: false })).toBeDefined();
  expect(screen.getByText("Alpha thread")).toBeDefined();
  expect(screen.getByText("Beta thread")).toBeDefined();
});

it("keeps shortcuts outside the scroller even with collapsed shelves or no threads", () => {
  localStorage.setItem(STORAGE_KEYS.pinnedProjects.key, JSON.stringify(["Alpha", "Empty"]));
  localStorage.setItem(STORAGE_KEYS.shelfExpansion.key, JSON.stringify({ active: false }));
  renderProjects();
  const shortcuts = screen.getByRole("group", { name: "Pinned projects" });
  expect(shortcuts.closest("[data-list-motion-scroller]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filter by Empty" }));
  expect(screen.getByRole("button", { name: "Filter by Empty", pressed: true })).toBeDefined();
  expect(screen.queryByText("Alpha thread")).toBeNull();
  expect(within(screen.getByRole("group", { name: "Pinned projects" })).getAllByRole("button")).toHaveLength(2);
});

it("keeps pinning usable when storage is blocked and pins from the keyboard", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  try {
    renderProjects();
    const field = typeFilter("[Alpha");
    fireEvent.keyDown(field, { key: "p", altKey: true });
    expect(screen.getByRole("button", { name: "Unpin Alpha" })).toBeDefined();
    expect(chips()).toEqual([]);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chips()).toEqual(["Alpha"]);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Filter by Alpha", pressed: true })).toBeDefined();
  } finally {
    spy.mockRestore();
  }
});
