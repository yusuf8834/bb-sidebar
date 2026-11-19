import { expect, it } from "vitest";
import plugin from "./server";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { createFakePluginHost, disposers, legacySettings } from "./test-server";

// The defaults every install takes until it saves its own settings.
const NEW_DEFAULTS = {
  dockShelves: true,
  childSortField: "created",
  childSortDirection: "descending",
  childIconStyle: "provider",
  projectColorsEnabled: true,
  projectColorDisplay: "none",
};

// The values these settings had before the new defaults.
const OLD_DEFAULTS = {
  dockShelves: false,
  childSortField: "created",
  childSortDirection: "ascending",
  childIconStyle: "disc",
  projectColorsEnabled: false,
  projectColorDisplay: "all",
};

type Host = ReturnType<typeof createFakePluginHost>;

async function start(host: Host) {
  await plugin(host.bb);
  disposers.push(() => host.harness.lifecycle.dispose());
  return host;
}

function markers(host: Host) {
  return host.bb.storage
    .database()
    .prepare("SELECT name FROM install_defaults ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

/** An install with sidebar data from before these migrations: the first release's table and one row. */
function existingInstall(options: Parameters<typeof createFakePluginHost>[0] = { pluginId: "bb-sidebar" }) {
  const host = createFakePluginHost(options);
  host.bb.storage.database().exec(
    `CREATE TABLE thread_lifecycle (thread_id TEXT PRIMARY KEY, settled_at INTEGER, snoozed_until INTEGER, snoozed_at INTEGER);
       INSERT INTO thread_lifecycle VALUES ('thr_old', 1, NULL, NULL);`,
  );
  return host;
}

it("gives a new install the new defaults, with automatic settling off", async () => {
  const host = await start(createFakePluginHost({ pluginId: "bb-sidebar" }));
  await expect(host.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
    ...DEFAULT_SIDEBAR_SETTINGS,
    ...NEW_DEFAULTS,
    autoSettleInactive: false,
    autoSettleOnMerge: false,
  });
  expect(markers(host)).toEqual([]);

  // The migration ran once, on empty tables: data added later marks nothing.
  host.bb.storage
    .database()
    .prepare("INSERT INTO thread_lifecycle (thread_id, settled_at) VALUES (?, ?)")
    .run("thr", 1);
  const reloaded = await host.harness.lifecycle.reload(plugin);
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  expect(markers(reloaded)).toEqual([]);
  await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    autoSettleInactive: false,
  });
});

it("keeps settling quiet threads for an existing install that never saved settings", async () => {
  const host = await start(existingInstall());
  expect(markers(host)).toEqual(["settle-finished-pull-requests", "settle-quiet-threads"]);
  await expect(host.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
    ...DEFAULT_SIDEBAR_SETTINGS,
    ...NEW_DEFAULTS,
    autoSettleInactive: true,
    autoSettleOnMerge: true,
  });

  // The settings page saves one change at a time. Saving something else
  // stores the setting as shown, so it stays on.
  await host.harness.behavior.callRpc("updateSidebarSettings", { dockShelves: false });
  const afterOtherSave = await host.harness.lifecycle.reload(plugin);
  disposers.push(() => afterOtherSave.harness.lifecycle.dispose());
  expect(
    JSON.parse(
      (
        afterOtherSave.bb.storage.database().prepare("SELECT settings_json FROM sidebar_settings").get() as {
          settings_json: string;
        }
      ).settings_json,
    ),
  ).toMatchObject({ autoSettleInactive: true, dockShelves: false });

  // Turning it off sticks; the marker only supplies a default.
  await expect(
    afterOtherSave.harness.behavior.callRpc("updateSidebarSettings", { autoSettleInactive: false }),
  ).resolves.toMatchObject({ autoSettleInactive: false });
  const reloaded = await afterOtherSave.harness.lifecycle.reload(plugin);
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    autoSettleInactive: false,
  });
});

it("marks only quiet-thread settling for an install made after finished pull requests became opt-in", async () => {
  // Installed with every earlier migration, used, then upgraded to this one.
  const host = await start(createFakePluginHost({ pluginId: "bb-sidebar" }));
  const db = host.bb.storage.database();
  // Un-apply the quiet-thread marker and the migrations added after it
  // (the auto-archive tables, which are idempotent).
  db.prepare("DELETE FROM _bb_migrations WHERE id >= (SELECT MAX(id) - 2 FROM _bb_migrations)").run();
  db.prepare("INSERT INTO inbox_order (thread_id, sort_index) VALUES (?, ?)").run("thr", 0);
  const upgraded = await host.harness.lifecycle.reload(plugin);
  disposers.push(() => upgraded.harness.lifecycle.dispose());
  expect(markers(upgraded)).toEqual(["settle-quiet-threads"]);
  await expect(upgraded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
    ...DEFAULT_SIDEBAR_SETTINGS,
    ...NEW_DEFAULTS,
    autoSettleInactive: true,
    autoSettleOnMerge: false,
  });
});

it("keeps quiet-thread settling when an existing install imports legacy settings without it", async () => {
  const host = await start(
    existingInstall({
      pluginId: "bb-sidebar",
      sdk: { plugins: { getSettings: legacySettings({ snoozePresets: "20m, 6h" }) } },
    }),
  );
  await expect(host.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    snoozePresets: "20m, 6h",
    autoSettleInactive: true,
    ...NEW_DEFAULTS,
  });
});

it.each([
  ["a new install", () => createFakePluginHost({ pluginId: "bb-sidebar" }), true],
  ["an existing install", () => existingInstall(), false],
])("keeps saved settings as stored on %s", async (_, create, autoSettleInactive) => {
  const host = await start(create());
  // Each value differs from the default this install would otherwise get.
  const saved = { ...DEFAULT_SIDEBAR_SETTINGS, ...OLD_DEFAULTS, autoSettleInactive };
  await host.harness.behavior.callRpc("updateSidebarSettings", saved);
  const reloaded = await host.harness.lifecycle.reload(plugin);
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(saved);
});
