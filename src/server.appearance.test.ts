import { describe, expect, it } from "vitest";
import plugin from "./server";
import { createFakePluginHost, disposers, standardProject, loadPlugin } from "./test-server";

describe("lifecycle RPC", () => {
  it("loads archive-preview storage without resetting shelves or project appearance", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    const saved = await harness.behavior.callRpc("updateSidebarSettings", {
      ...settings,
      projectColorsEnabled: true,
      projectColorDisplay: "grouped",
      autoSettleInactive: false,
      autoSettleOnMerge: false,
    });
    const db = bb.storage.database();
    db.prepare("UPDATE sidebar_settings SET archived_shelf_enabled = 1 WHERE id = 1").run();
    db.prepare("INSERT INTO project_colors (project_id, color) VALUES (?, ?)").run("proj_1", "#668899");
    db.prepare(
      `INSERT INTO thread_lifecycle
      (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("thr_1", 123, "settled", null, null, null);
    const before = await harness.behavior.callRpc("listLifecycle", {});

    const restored = (await harness.lifecycle.reload(plugin)).harness;
    disposers.push(() => restored.lifecycle.dispose());
    await expect(restored.behavior.callRpc("getSidebarSettings", {})).resolves.toEqual(saved);
    expect(saved).not.toHaveProperty("archivedShelfEnabled");
    await expect(restored.behavior.callRpc("listLifecycle", {})).resolves.toEqual(before);
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: { proj_1: "#668899" } });
    expect(restored.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(restored.inspection.sdk.callsTo("threads.unarchive")).toHaveLength(0);
  });

  it("persists per-project colors, validates them, and resets to automatic", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("projects.get", async () => standardProject());
    await expect(harness.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: {} });
    await harness.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: "#Ab12CD" });
    const reloaded = await harness.lifecycle.reload(plugin);
    const restored = reloaded.harness;
    disposers.push(() => restored.lifecycle.dispose());
    restored.inspection.sdk.stub("projects.get", async () => standardProject());
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: { proj_1: "#ab12cd" } });
    await expect(
      restored.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: "url(https://example.com)" }),
    ).rejects.toThrow();
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: { proj_1: "#ab12cd" } });
    await restored.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: null });
    await expect(restored.behavior.callRpc("getProjectColors", {})).resolves.toEqual({ colors: {} });
    expect(restored.inspection.experimental_rpcInvalidations).toContainEqual(["project-colors"]);
  });
});
