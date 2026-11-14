import { describe, expect, it } from "vitest";
import plugin from "./server";
import { createFakePluginHost, disposers, standardProject } from "./test-server";

describe("project management", () => {
  it("renames standard projects and rejects personal projects or empty names", async () => {
    let project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: { projects: { get: async () => project, update: async ({ name }) => ({ ...project, name: name! }) } },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(
      harness.behavior.callRpc("renameProject", { projectId: "proj_1", name: "  New name  " }),
    ).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("projects.update")).toEqual([[{ projectId: "proj_1", name: "New name" }]]);
    // Project lists in every open settings page reread the new name.
    expect(harness.inspection.experimental_rpcInvalidations).toEqual([["projects"]]);
    await expect(harness.behavior.callRpc("renameProject", { projectId: "proj_1", name: " " })).rejects.toThrow();
    project = { ...project, kind: "personal" } as unknown as typeof project;
    await expect(harness.behavior.callRpc("renameProject", { projectId: "proj_1", name: "No" })).rejects.toThrow(
      "Personal projects",
    );
    expect(harness.inspection.sdk.callsTo("projects.update")).toHaveLength(1);
  });

  it("only offers connected machines without a source and rejects duplicate paths", async () => {
    const project = standardProject();
    const host = {
      id: "host_1",
      name: "Desktop",
      status: "connected" as const,
      type: "persistent" as const,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
      lastRejectedProtocolVersion: null,
      maxPermissionMode: "auto" as const,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        hosts: {
          list: async () => [
            host,
            { ...host, id: "host_2", name: "Laptop" },
            { ...host, id: "host_3", status: "disconnected" },
          ],
        },
        projects: {
          get: async () => project,
          sources: { add: async () => ({ ...project.sources[0]!, hostId: "host_2" }) },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await expect(harness.behavior.callRpc("projectPathHosts", { projectId: "proj_1" })).resolves.toEqual({
      hosts: [{ id: "host_2", name: "Laptop" }],
    });
    await expect(
      harness.behavior.callRpc("addProjectPath", { projectId: "proj_1", hostId: "host_1", path: "/work" }),
    ).rejects.toThrow("already has a path");
    expect(harness.inspection.sdk.callsTo("projects.sources.add")).toHaveLength(0);
    await harness.behavior.callRpc("addProjectPath", { projectId: "proj_1", hostId: "host_2", path: "/work" });
    expect(harness.inspection.sdk.callsTo("projects.sources.add")).toEqual([
      [{ projectId: "proj_1", hostId: "host_2", path: "/work", type: "local_path" }],
    ]);
  });

  it("requires the project name before removing a standard project", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          delete: async () => ({ ok: true as const }),
          get: async () => project,
          list: async () => [project],
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(harness.behavior.callRpc("listProjects", {})).resolves.toEqual({
      projects: [{ id: "proj_1", name: "Sidebar" }],
    });
    await expect(
      harness.behavior.callRpc("removeProject", {
        projectId: "proj_1",
        confirmation: "sidebar",
      }),
    ).rejects.toThrow("Enter the project name exactly as shown");
    expect(harness.inspection.sdk.callsTo("projects.delete")).toEqual([]);

    await harness.behavior.callRpc("uploadProjectIcon", {
      projectId: "proj_1",
      filename: "brand.svg",
      mimeType: "image/svg+xml",
      contentBase64: "PHN2Zy8+",
    });
    await harness.behavior.callRpc("setProjectColor", { projectId: "proj_1", color: "#123456" });
    await expect(
      harness.behavior.callRpc("removeProject", {
        projectId: "proj_1",
        confirmation: "Sidebar",
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.inspection.sdk.callsTo("projects.delete")).toEqual([[{ projectId: "proj_1" }]]);
    expect(await harness.behavior.callRpc("getProjectColors", {})).toEqual({ colors: {} });
    expect(harness.inspection.experimental_rpcInvalidations.at(-1)).toEqual(["projects", "project-colors"]);
    await expect(harness.behavior.callRpc("listProjectIconSettings", {})).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: null,
          customUploadName: null,
        },
      ],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "project-icons",
      payload: { projectId: "proj_1" },
    });
  });
});
