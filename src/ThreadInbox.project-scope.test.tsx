// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, defaultSidebarSettings, rowLinks } from "./test-inbox";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { BROWSER_EVENTS } from "./lib/browser-events";

await loadInboxApp();

const projects = ["Alpha", "Beta", "Gamma"].map((name) => ({
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
      threads: projects.map(({ id }) => thread({ id, projectId: id, title: `${id} thread` })),
    },
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

function field() {
  return screen.getByRole("combobox", { name: "Filter threads" });
}

function type(value: string) {
  const input = field();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  return input;
}

function chips() {
  return screen.queryAllByRole("button", { name: / from filter$/ }).map((chip) => chip.textContent);
}

function options() {
  return within(screen.getByRole("listbox", { name: "Filter suggestions" }))
    .getAllByRole("option")
    .map((option) => option.textContent);
}

it("adds projects as chips from [prefix + Enter, remembers them on remount, and clears", () => {
  const rendered = renderProjects();
  let input = type("[al");
  expect(options()).toEqual(["Alpha"]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(chips()).toEqual(["Alpha"]);
  expect(input).toHaveProperty("value", "");
  type("[Gam");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(chips()).toEqual(["Alpha", "Gamma"]);
  expect(screen.getByText("Alpha thread")).toBeDefined();
  expect(screen.getByText("Gamma thread")).toBeDefined();
  expect(screen.queryByText("Beta thread")).toBeNull();

  rendered.lifecycle.unmount();
  renderProjects();
  expect(chips()).toEqual(["Alpha", "Gamma"]);
  expect(screen.queryByText("Beta thread")).toBeNull();
  input = type("[alpha");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(chips()).toEqual(["Gamma"]);
  expect(screen.queryByText("Alpha thread")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(chips()).toEqual([]);
  for (const { name } of projects) expect(screen.getByText(`${name} thread`)).toBeDefined();
  expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.projectScope.key)!)).toEqual([]);
});

it("turns pasted tokens into chips and keeps the rest as a title keyword", () => {
  renderProjects();
  const input = type("[alpha] [beta] thread");
  expect(chips()).toEqual(["Alpha", "Beta"]);
  expect(input).toHaveProperty("value", "thread");
  expect(screen.queryByText("Gamma thread")).toBeNull();
  fireEvent.change(input, { target: { value: "missing" } });
  expect(screen.queryByText("Alpha thread")).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveProperty("value", "");
  expect(screen.getByText("Alpha thread")).toBeDefined();
});

it("moves with the arrows, drops the last chip with Backspace, and clears with Ctrl+Backspace", () => {
  renderProjects();
  const input = type("[");
  expect(options()).toEqual(["Alpha", "Beta", "Gamma"]);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(chips()).toEqual(["Beta"]);
  type("is:snoo");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(chips()).toEqual(["Beta", "is:snoozed"]);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(chips()).toEqual(["Beta"]);
  type("is:park ");
  expect(chips()).toEqual(["Beta", "is:parked"]);
  fireEvent.keyDown(input, { key: "Backspace", ctrlKey: true });
  expect(chips()).toEqual([]);
});

it("filters by machine and thread state", () => {
  const threads = [
    thread({
      id: "a",
      projectId: "Alpha",
      title: "Mona asks",
      host: { id: "h1", name: "mona" },
      hasPendingInteraction: true,
    }),
    thread({ id: "b", projectId: "Alpha", title: "Mona quiet", host: { id: "h1", name: "mona" } }),
    thread({
      id: "c",
      projectId: "Beta",
      title: "Ivo asks",
      host: { id: "h2", name: "ivo" },
      hasPendingInteraction: true,
    }),
  ];
  renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", projects, threads },
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
  const input = type("@mo");
  expect(options()).toEqual(["@mona"]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(chips()).toEqual(["@mona"]);
  expect(screen.queryByText("Ivo asks")).toBeNull();
  expect(screen.getByText("Mona quiet")).toBeDefined();
  type("is:needs-you ");
  expect(chips()).toEqual(["is:needs-you", "@mona"]);
  expect(screen.getByText("Mona asks")).toBeDefined();
  expect(screen.queryByText("Mona quiet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove @mona from filter" }));
  expect(screen.getByText("Ivo asks")).toBeDefined();
  expect(screen.queryByText("Mona quiet")).toBeNull();
});

it("focuses the field when the filter command runs", () => {
  renderProjects();
  act(() => {
    window.dispatchEvent(new Event(BROWSER_EVENTS.focusFilter));
  });
  expect(document.activeElement).toBe(field());
  expect(screen.getByRole("listbox", { name: "Filter suggestions" })).toBeDefined();
});

it("keeps selection usable when session storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  try {
    renderProjects();
    type("[beta] [gamma] ");
    expect(screen.getByText("Beta thread")).toBeDefined();
    expect(screen.queryByText("Alpha thread")).toBeNull();
  } finally {
    vi.restoreAllMocks();
  }
});

it("filters every shelf without changing lifecycle or order", async () => {
  const shelves = ["Pinned", "Active", "Working", "Inactive", "Snoozed", "Parked", "Settled"];
  const now = Date.now();
  localStorage.setItem(
    STORAGE_KEYS.shelfExpansion.key,
    JSON.stringify(Object.fromEntries(shelves.map((s) => [s.toLowerCase(), true]))),
  );
  sessionStorage.setItem(STORAGE_KEYS.projectScope.key, JSON.stringify(["Alpha", "Gamma"]));
  const threads = projects.flatMap(({ id }) =>
    shelves.map((shelf) =>
      thread({
        id: `${id}-${shelf}`,
        projectId: id,
        title: `${id} ${shelf}`,
        isPinned: shelf === "Pinned",
        indicator: shelf === "Working" ? "runtime" : "none",
        updatedAt: shelf === "Inactive" ? now - 24 * 60 * 60_000 : now,
      }),
    ),
  );
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", projects, threads },
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, workingShelf: true }),
      listLifecycle: () => ({
        rows: projects.flatMap(({ id }) => [
          { threadId: `${id}-Snoozed`, snoozedAt: now, snoozedUntil: now + 60_000, settledAt: null },
          { threadId: `${id}-Parked`, parkedAt: now, snoozedAt: null, snoozedUntil: null, settledAt: null },
          { threadId: `${id}-Settled`, snoozedAt: null, snoozedUntil: null, settledAt: now },
        ]),
      }),
    },
  });
  for (const shelf of shelves) {
    const region = await screen.findByRole("region", { name: shelf });
    await waitFor(() => expect(rowLinks(region)).toHaveLength(2));
    expect(within(region).getByText(`Alpha ${shelf}`)).toBeDefined();
    expect(within(region).getByText(`Gamma ${shelf}`)).toBeDefined();
    expect(screen.queryByText(`Beta ${shelf}`)).toBeNull();
  }
  expect(rendered.rpcCalls.filter(({ method }) => /^(reorder|settle|snooze|park|setThread)/.test(method))).toEqual([]);
});
