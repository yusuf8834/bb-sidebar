import { describe, expect, it, vi } from "vitest";
import plugin from "./server";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings-values";
import { createFakePluginHost, disposers, loadPlugin } from "./test-server";

describe("lifecycle RPC", () => {
  it("stores the grouped sidebar settings through RPC", async () => {
    const harness = await loadPlugin();
    expect(harness.inspection.registrations.settingsDescriptors).toEqual({});
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      snoozePresets: "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00",
      inactiveThreadsEnabled: true,
      inactiveAfterHours: 6,
      showRunningChildrenWhenCollapsed: true,
      autoSettleInactive: true,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: false,
      childSortField: "created",
      childSortDirection: "ascending",
      childIconStyle: "disc",
      compactWorkingThreads: false,
      workingShelf: false,
      dockShelves: false,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
    });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "10m, 4h",
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
        projectColorDisplay: "grouped",
      }),
    ).resolves.toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      snoozePresets: "10m, 4h",
      inactiveThreadsEnabled: false,
      inactiveAfterHours: 12,
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 7,
      autoSettleOnMerge: false,
      childSortField: "activity",
      childSortDirection: "descending",
      childIconStyle: "provider",
      threadDisplay: "compact-working",
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
      projectColorsEnabled: true,
      projectColorDisplay: "grouped",
    });
    // A client that predates the setting leaves it out and must not reset it.
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "10m, 4h",
        inactiveThreadsEnabled: false,
        inactiveAfterHours: 12,
        showRunningChildrenWhenCollapsed: false,
        autoSettleInactive: false,
        autoSettleAfterDays: 7,
        autoSettleOnMerge: false,
        childSortField: "activity",
        childSortDirection: "descending",
        childIconStyle: "provider",
      }),
    ).resolves.toMatchObject({
      threadDisplay: "compact-working",
      compactWorkingThreads: true,
      workingShelf: true,
      dockShelves: true,
      projectColorsEnabled: true,
      projectColorDisplay: "grouped",
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "sidebar-settings",
      payload: {},
    });
    expect(harness.inspection.registrations.schedules).toContainEqual(
      expect.objectContaining({ name: "auto-settle", cron: "*/5 * * * *" }),
    );
  });

  it("persists color display mode across reloads and rejects unknown modes", async () => {
    const harness = await loadPlugin();
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, projectColorDisplay: "full" });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", { ...settings, projectColorDisplay: "invalid" }),
    ).rejects.toThrow("rpc input validation failed");
    const reloaded = await harness.lifecycle.reload(plugin);
    disposers.push(() => reloaded.harness.lifecycle.dispose());
    await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      projectColorDisplay: "full",
      projectColorsEnabled: false,
    });
  });

  it("rejects invalid snooze shortcuts at the RPC boundary", async () => {
    const harness = await loadPlugin();

    await expect(
      harness.behavior.callRpc("updateSidebarSettings", {
        snoozePresets: "later",
        inactiveThreadsEnabled: true,
        inactiveAfterHours: 6,
        showRunningChildrenWhenCollapsed: true,
        autoSettleInactive: true,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
        childSortField: "created",
        childSortDirection: "ascending",
        childIconStyle: "disc",
      }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      snoozePresets: "1h, Wait refresh (5 hours)=5h, evening@18:00, tomorrow@09:00, next-week@09:00",
    });
  });

  it("saves editable calendar shortcuts and rejects invalid times", async () => {
    const harness = await loadPlugin();
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    const snoozePresets = "1h, Wait refresh=5h, Tonight=evening@20:00, Morning=tomorrow@08:30, Monday=next-week@10:00";
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", { ...settings, snoozePresets }),
    ).resolves.toMatchObject({ snoozePresets });
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ snoozePresets });
    await expect(
      harness.behavior.callRpc("updateSidebarSettings", { ...settings, snoozePresets: "tomorrow@24:00" }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ snoozePresets });
  });

  it("migrates values from the previous flat settings form", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        plugins: {
          getSettings: async () => ({
            ok: true as const,
            schema: {},
            values: {
              snoozePresets: "20m, 6h",
              inactiveThreadsEnabled: false,
              inactiveAfterHours: "18",
              showRunningChildrenWhenCollapsed: false,
              autoSettleInactive: false,
              autoSettleAfterDays: "14",
              autoSettleOnMerge: false,
            },
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      snoozePresets: "20m, 6h",
      inactiveThreadsEnabled: false,
      inactiveAfterHours: 18,
      showRunningChildrenWhenCollapsed: false,
      autoSettleInactive: false,
      autoSettleAfterDays: 14,
      autoSettleOnMerge: false,
      childSortField: "created",
      childSortDirection: "ascending",
      childIconStyle: "disc",
      compactWorkingThreads: false,
      workingShelf: false,
      dockShelves: false,
      projectColorsEnabled: false,
      projectColorDisplay: "all",
    });
  });
});

it("writes only JSON and keeps historical columns unchanged across reloads", async () => {
  const getSettings = vi.fn(async () => ({ values: {}, pluginId: "bb-sidebar" }));
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar", sdk: { plugins: { getSettings } } });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  const { settings_json: beforeJson, ...beforeColumns } = db.prepare("SELECT * FROM sidebar_settings").get() as Record<
    string,
    unknown
  >;
  expect(beforeJson).toBeNull();
  const next = {
    ...DEFAULT_SIDEBAR_SETTINGS,
    snoozePresets: "20m, 6h",
    inactiveAfterHours: 18,
    workingShelf: true,
    compactProjectIconOnly: true,
  };
  await expect(harness.behavior.callRpc("updateSidebarSettings", next)).resolves.toEqual(next);
  const { settings_json: storedJson, ...afterColumns } = db.prepare("SELECT * FROM sidebar_settings").get() as Record<
    string,
    unknown
  >;
  expect(JSON.parse(storedJson as string)).toEqual(next);
  expect(afterColumns).toEqual(beforeColumns);
  const reloaded = await harness.lifecycle.reload(plugin);
  disposers.push(() => reloaded.harness.lifecycle.dispose());
  await expect(reloaded.harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(next);
  expect(getSettings).toHaveBeenCalledTimes(1);
});

it("defaults missing and invalid JSON fields without losing valid settings", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  db.prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1").run(
    JSON.stringify({
      snoozePresets: "20m, 6h",
      inactiveAfterHours: 18,
      autoSettleInactive: false,
      inactiveThreadsEnabled: "false",
      autoSettleAfterDays: -1,
      childSortField: "invalid",
      compactProjectIconOnly: "true",
      projectColorDisplay: "invalid",
      removedSetting: true,
    }),
  );
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual({
    ...DEFAULT_SIDEBAR_SETTINGS,
    snoozePresets: "20m, 6h",
    inactiveAfterHours: 18,
    autoSettleInactive: false,
  });
});

it.each(["", "{broken", "null", "[]", "42", '"settings"'])("defaults malformed JSON %s", async (stored) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  bb.storage.database().prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1").run(stored);
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(DEFAULT_SIDEBAR_SETTINGS);
  expect(harness.inspection.logEntries).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: expect.stringMatching(/^Could not parse sidebar_settings\.settings_json; using defaults: .+/),
    }),
  );
});

it.each([
  [{ compactWorkingThreads: true }, "compact-working"],
  [{ compactWorkingThreads: false }, "full"],
  // A newer version's choice this version doesn't know falls back to the switch it kept in step.
  [{ threadDisplay: "dense-future", compactWorkingThreads: true }, "compact-working"],
  [{ threadDisplay: "dense-future", compactWorkingThreads: false }, "full"],
])("reads thread display %j from settings saved without a known value", async (stored, threadDisplay) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  bb.storage
    .database()
    .prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1")
    .run(JSON.stringify(stored));
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    threadDisplay,
    compactWorkingThreads: threadDisplay !== "full",
  });
});

it("keeps the legacy switch in step when thread display changes", async () => {
  const harness = await loadPlugin();
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", { threadDisplay: "compact-working" }),
  ).resolves.toMatchObject({ threadDisplay: "compact-working", compactWorkingThreads: true });
  // An older version reads Compact all as the old switch turned on.
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", { threadDisplay: "compact-all" }),
  ).resolves.toMatchObject({ threadDisplay: "compact-all", compactWorkingThreads: true });
  await expect(harness.behavior.callRpc("updateSidebarSettings", { threadDisplay: "full" })).resolves.toMatchObject({
    threadDisplay: "full",
    compactWorkingThreads: false,
  });
});

it("keeps settling finished pull requests on for installs that already had sidebar data", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  // The shape the first release created, with one stored shelf choice.
  bb.storage.database().exec(
    `CREATE TABLE thread_lifecycle (thread_id TEXT PRIMARY KEY, settled_at INTEGER, snoozed_until INTEGER, snoozed_at INTEGER);
       INSERT INTO thread_lifecycle VALUES ('thr_old', 1, NULL, NULL);`,
  );
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({ autoSettleOnMerge: true });
  await expect(harness.behavior.callRpc("updateSidebarSettings", { autoSettleOnMerge: false })).resolves.toMatchObject({
    autoSettleOnMerge: false,
  });
});

it("shows side chats as children unless the user turned it off", async () => {
  expect(DEFAULT_SIDEBAR_SETTINGS.showSideChatsAsChildren).toBe(true);
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const store = bb.storage.database().prepare("UPDATE sidebar_settings SET settings_json = ? WHERE id = 1");
  // Settings saved before the switch existed, and a value it cannot read.
  for (const stored of [{ dockShelves: true }, { dockShelves: true, showSideChatsAsChildren: "no" }]) {
    store.run(JSON.stringify(stored));
    await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
      dockShelves: true,
      showSideChatsAsChildren: true,
    });
  }
  await expect(
    harness.behavior.callRpc("updateSidebarSettings", { ...DEFAULT_SIDEBAR_SETTINGS, showSideChatsAsChildren: false }),
  ).resolves.toMatchObject({ showSideChatsAsChildren: false });
  await expect(harness.behavior.callRpc("getSidebarSettings", {})).resolves.toMatchObject({
    showSideChatsAsChildren: false,
  });
});
