// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { createWired } from "./test-wired";
import { deferred, loadInboxApp, thread } from "./test-inbox";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import hashes from "./fixtures/sha256.json";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
await loadInboxApp();

// Future schema changes add a new fixture version; never edit an old one.
// v0.2.34 comes from its tag; main-3578240 captures the later unreleased schema.
const fixturePath = (name: string) => join(process.cwd(), "src/fixtures", name);
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const releaseSettings = {
  snoozePresets: "1h, 4h, 2d",
  inactiveThreadsEnabled: false,
  inactiveAfterHours: 12,
  showRunningChildrenWhenCollapsed: false,
  autoSettleInactive: false,
  autoSettleAfterDays: 7,
  autoSettleOnMerge: false,
  childSortField: "activity",
  childSortDirection: "descending",
  childIconStyle: "provider",
  compactWorkingThreads: true,
  workingShelf: true,
  dockShelves: true,
};
// Releases before Thread display saved only the switch, which now decides it.
const migratedThreadDisplay = { threadDisplay: "compact-working" } as const;
const snapshots = [
  {
    version: "v0.2.34",
    settings: {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...releaseSettings,
      ...migratedThreadDisplay,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
    },
  },
  {
    version: "main-3578240",
    settings: {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...releaseSettings,
      ...migratedThreadDisplay,
      projectColorsEnabled: true,
      projectColorDisplay: "full",
    },
  },
];
const databaseSnapshots = [
  ...snapshots,
  {
    version: "json-e77d70b",
    settings: {
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...releaseSettings,
      ...migratedThreadDisplay,
      projectColorsEnabled: true,
      projectColorDisplay: "full",
    },
  },
];

const expectedRows = [
  {
    threadId: "parked",
    parkedAt: 1_799_999_000_000,
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
  },
  {
    threadId: "snoozed",
    parkedAt: null,
    settledAt: null,
    settledOverride: null,
    snoozedUntil: 1_800_003_600_000,
    snoozedAt: 1_800_000_000_000,
  },
  {
    threadId: "settled",
    parkedAt: null,
    settledAt: 1_799_999_000_000,
    settledOverride: "settled",
    snoozedUntil: null,
    snoozedAt: null,
  },
  {
    threadId: "override",
    parkedAt: null,
    settledAt: null,
    settledOverride: "active",
    snoozedUntil: null,
    snoozedAt: null,
  },
  {
    threadId: "child",
    parkedAt: null,
    settledAt: 1_799_999_000_000,
    settledOverride: "settled",
    snoozedUntil: null,
    snoozedAt: null,
  },
];

it.each(Object.entries(hashes))("keeps fixture %s at its committed SHA-256", (name, expected) => {
  const path = fixturePath(name);
  expect(hash(path)).toBe(expected);
  expect(readFileSync(path).length).toBeLessThan(100_000);
});

it("v0.2.34 contains only its released settings schema and cache shape", () => {
  const db = new Database(fixturePath("sidebar-v0.2.34.sqlite"), { readonly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(sidebar_settings)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      "id",
      "snooze_presets",
      "inactive_threads_enabled",
      "inactive_after_hours",
      "auto_settle_inactive",
      "auto_settle_after_days",
      "auto_settle_on_merge",
      "show_running_children_when_collapsed",
      "child_sort_field",
      "child_sort_direction",
      "child_icon_style",
      "compact_working_threads",
      "working_shelf",
      "dock_shelves",
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'project_colors'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM _bb_migrations").get()).toEqual({ n: 16 });
  } finally {
    db.close();
  }
  const storage = JSON.parse(readFileSync(fixturePath("local-storage-v0.2.34.json"), "utf8"));
  expect(JSON.parse(storage["bb-sidebar:settings-cache:v1"])).toEqual(releaseSettings);
});

it.each(databaseSnapshots)(
  "reads both boolean values after upgrading $version without editing the fixture",
  async ({ version }) => {
    const wired = await createWired([], { fixture: fixturePath(`sidebar-${version}.sqlite`) });
    const disabled = {
      inactiveThreadsEnabled: false,
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleOnMerge: false,
    };
    expect(await wired.call("getSidebarSettings")).toMatchObject(disabled);
    // Update a temporary copy before startup to exercise migration of true
    // booleans as well as the false booleans in the immutable originals.
    const directory = mkdtempSync(join(tmpdir(), "sidebar-booleans-"));
    let enabled;
    try {
      const copy = join(directory, "sidebar.sqlite");
      copyFileSync(fixturePath(`sidebar-${version}.sqlite`), copy);
      const db = new Database(copy);
      try {
        db.prepare(`UPDATE sidebar_settings SET inactive_threads_enabled = 1,
          show_running_children_when_collapsed = 1, auto_settle_inactive = 1, auto_settle_on_merge = 1
          WHERE id = 1`).run();
        const columns = db.prepare("PRAGMA table_info(sidebar_settings)").all() as Array<{ name: string }>;
        if (columns.some(({ name }) => name === "settings_json")) {
          db.prepare(`UPDATE sidebar_settings SET settings_json = json_set(settings_json,
            '$.inactiveThreadsEnabled', json('true'), '$.showRunningChildrenWhenCollapsed', json('true'),
            '$.autoSettleInactive', json('true'), '$.autoSettleOnMerge', json('true')) WHERE id = 1`).run();
        }
      } finally {
        db.close();
      }
      enabled = await createWired([], { fixture: copy });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(await enabled.call("getSidebarSettings")).toMatchObject({
      inactiveThreadsEnabled: true,
      showRunningChildrenWhenCollapsed: true,
      autoSettleInactive: true,
      autoSettleOnMerge: true,
    });
  },
);

function assertSettingsControls(container: HTMLElement, settings: (typeof snapshots)[number]["settings"]) {
  const ui = within(container);
  for (const [label, field] of [
    ["Working shelf", "workingShelf"],
    ["Inactive shelf", "inactiveThreadsEnabled"],
    ["Dock shelves to the bottom", "dockShelves"],
    ["Project colors", "projectColorsEnabled"],
    ["Settle quiet threads", "autoSettleInactive"],
    ["Settle finished pull requests", "autoSettleOnMerge"],
    ["Show children that need attention", "showRunningChildrenWhenCollapsed"],
  ] as const) {
    expect(ui.getByRole("switch", { name: label }).getAttribute("aria-checked")).toBe(String(settings[field]));
  }
  expect(ui.getByRole("textbox", { name: "Snooze shortcuts" })).toHaveProperty("value", settings.snoozePresets);
  for (const [label, field] of [
    ["Thread display", "threadDisplay"],
    ["Child threads sort field", "childSortField"],
    ["Child threads sort direction", "childSortDirection"],
    ["Child thread icon", "childIconStyle"],
  ] as const) {
    expect(ui.getByRole("combobox", { name: label })).toHaveProperty("value", settings[field]);
  }
  // These controls are conditional. Reveal each while RPC and save timers stay gated,
  // check its cached value, then restore the original switch state.
  for (const [toggle, label, field] of [
    ["Inactive shelf", "Hours before inactive", "inactiveAfterHours"],
    ["Settle quiet threads", "Days before auto-settle", "autoSettleAfterDays"],
  ] as const) {
    const control = ui.getByRole("switch", { name: toggle });
    fireEvent.click(control);
    expect(ui.getByRole("spinbutton", { name: label })).toHaveProperty("value", String(settings[field]));
    fireEvent.click(control);
  }
  const colors = ui.getByRole("switch", { name: "Project colors" });
  if (!settings.projectColorsEnabled) fireEvent.click(colors);
  expect(ui.getByRole("combobox", { name: "Show project stripes in" })).toHaveProperty(
    "value",
    settings.projectColorDisplay,
  );
  if (!settings.projectColorsEnabled) fireEvent.click(colors);
}

it.each(databaseSnapshots)(
  "opens $version in current fake host storage and preserves settings and lifecycle",
  async ({ version, settings }) => {
    const database = fixturePath(`sidebar-${version}.sqlite`);
    const wired = await createWired([], { fixture: database });
    expect(await wired.call("getSidebarSettings")).toEqual(settings);
    expect(await wired.call("listLifecycle")).toEqual({ rows: expectedRows });
    expect(await wired.call("listInboxOrder")).toEqual({ inboxThreadIds: ["second", "first"] });
    expect(await wired.call("getProjectColors")).toEqual({
      colors: version === "v0.2.34" ? {} : { proj_1: "#123456" },
    });
    expect(wired.db.prepare("SELECT * FROM project_icons").all()).toEqual([
      { project_id: "proj_1", path: "assets/logo.png", updated_at: 1_800_000_000_000 },
    ]);
    expect(wired.db.prepare("SELECT * FROM project_icon_uploads").get()).toEqual({
      project_id: "proj_2",
      filename: "pixel.png",
      mime_type: "image/png",
      size_bytes: 68,
      content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
      updated_at: 1_800_000_000_000,
    });
    expect(wired.db.prepare("SELECT * FROM title_recovery_attempts").all()).toEqual([{ thread_id: "settled" }]);
    expect(wired.db.prepare("SELECT archived_shelf_enabled FROM sidebar_settings").get()).toEqual({
      archived_shelf_enabled: version === "v0.2.34" ? 0 : 1,
    });
    expect(hash(database)).toBe(hashes[`sidebar-${version}.sqlite` as keyof typeof hashes]);
  },
);

it.each(snapshots)(
  "reconstructs $version shelves, order and every setting before any RPC resolves",
  async ({ version, settings }) => {
    const storage = fixturePath(`local-storage-${version}.json`);
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const fixture: Record<string, string> = JSON.parse(readFileSync(storage, "utf8"));
    for (const [key, value] of Object.entries(fixture)) localStorage.setItem(key, value);
    const gate = deferred<void>();
    const threads = [
      "first",
      "second",
      "parked",
      "snoozed",
      "settled",
      "override",
      "child",
      "busy",
      "expanded-child",
    ].map((id) =>
      thread({
        id,
        title: `Golden ${id}`,
        updatedAt: Date.now(),
        parentThreadId: id === "child" ? "settled" : id === "expanded-child" ? "override" : null,
        ...(id === "busy" ? { indicator: "runtime" as const, runtimeStatus: "active" as const } : {}),
      }),
    );
    const wired = await createWired(threads, { rpcGate: gate.promise });
    const inboxSlot = wired.mount();
    const settingsSlot = wired.mount("settings");
    for (const [name, id] of [
      ["Parked", "parked"],
      ["Snoozed", "snoozed"],
      ["Settled", "settled"],
      ["Working", "busy"],
    ]) {
      expect(within(screen.getByRole("region", { name })).getByText(`Golden ${id}`)).toBeDefined();
    }
    expect(screen.getByText("Golden expanded-child")).toBeDefined();
    // Both stored expansions now show: the Active override's, and the Settled
    // parent's, which releases before shelf children kept but never drew.
    expect(screen.getAllByRole("list", { name: "Child threads" })).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Settled" })).getByText("Golden child")).toBeDefined();
    const active = screen.getByRole("region", { name: "Active" });
    expect(
      within(active)
        .getAllByRole("listitem")
        .filter((row) => /Golden (first|second)/.test(row.textContent ?? ""))
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("Golden second"), expect.stringContaining("Golden first")]);
    assertSettingsControls(settingsSlot.container, settings);
    expect(screen.getByText("Working · 5m")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Open port links on" })).toHaveProperty("value", "host_1");
    expect(Object.keys(fixture).sort()).toEqual(
      [
        "active-grouping",
        "active-sort",
        "child-expansion",
        "inbox-order-cache",
        "lifecycle-cache",
        "port-link-host",
        "project-collapse",
        "settings-cache",
        "shelf-expansion",
        "working-since",
      ]
        .map((key) => `bb-sidebar:${key}:v1`)
        .sort(),
    );
    expect(inboxSlot.inspection.rpcCalls.length).toBeGreaterThan(0);
    expect(settingsSlot.inspection.rpcCalls.length).toBeGreaterThan(0);
    expect(inboxSlot.rpcReplies).toEqual([]);
    expect(settingsSlot.rpcReplies).toEqual([]);
    // The bridge is still blocked: no server read or policy reply can replace cache state.
    expect(wired.db.prepare("SELECT COUNT(*) AS n FROM thread_lifecycle").get()).toEqual({ n: 0 });
    fireEvent.keyDown(screen.getByRole("button", { name: "Sort active threads: Manual order" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    const project = screen.getByRole("region", { name: "Sidebar project" });
    expect(
      within(project)
        .getByRole("button", { name: /^Sidebar/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(within(project).queryByText("Golden first")).toBeNull();
    wired.unmount(inboxSlot);
    wired.unmount(settingsSlot);
  },
);

it.each(snapshots)("reads $version legacy grouping when active-sort is absent", async ({ version }) => {
  const fixture: Record<string, string> = JSON.parse(
    readFileSync(fixturePath(`local-storage-${version}.json`), "utf8"),
  );
  // active-grouping is a legacy fallback; active-sort takes priority in the full dump.
  localStorage.setItem("bb-sidebar:active-grouping:v1", fixture["bb-sidebar:active-grouping:v1"]!);
  expect(localStorage.getItem("bb-sidebar:active-sort:v1")).toBeNull();
  const wired = await createWired([thread({ id: "first" }), thread({ id: "second" })], {
    rpcGate: deferred<void>().promise,
  });
  wired.mount();
  expect(screen.getByRole("button", { name: "Sort active threads: Project" })).toBeDefined();
  expect(screen.getByRole("region", { name: "Sidebar project" })).toBeDefined();
});

it("JSON snapshot records the new schema and stores real JSON boolean values", () => {
  const db = new Database(fixturePath("sidebar-json-e77d70b.sqlite"), { readonly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(sidebar_settings)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain("settings_json");
    expect(db.prepare("SELECT COUNT(*) AS n FROM _bb_migrations").get()).toEqual({ n: 23 });
    const row = db.prepare("SELECT settings_json FROM sidebar_settings WHERE id = 1").get() as {
      settings_json: string;
    };
    // Raw fixture contents are frozen; current defaults belong only in RPC expectations.
    expect(JSON.parse(row.settings_json)).toEqual({
      snoozePresets: "1h, 4h, 2d",
      inactiveThreadsEnabled: false,
      inactiveAfterHours: 12,
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 7,
      autoSettleOnMerge: false,
      childSortField: "activity",
      childSortDirection: "descending",
      childIconStyle: "provider",
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
      projectColorsEnabled: true,
      projectColorDisplay: "full",
    });
  } finally {
    db.close();
  }
});
