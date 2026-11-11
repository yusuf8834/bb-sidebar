import { describe, expect, it } from "vitest";
import plugin from "./server";
import { createFakePluginHost, disposers, standardProject } from "./test-server";

describe("project icons", () => {
  it("stores per-project choices and searches only supported image files", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          list: async () => [project],
          paths: async () => ({
            paths: [
              {
                kind: "file" as const,
                name: "brand.svg",
                path: "public/brand.svg",
                positions: [],
                score: 1,
              },
              {
                kind: "file" as const,
                name: "readme.md",
                path: "README.md",
                positions: [],
                score: 0.5,
              },
            ],
            truncated: false,
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

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
    await expect(
      harness.behavior.callRpc("searchProjectIconFiles", {
        projectId: "proj_1",
        query: "brand",
      }),
    ).resolves.toEqual({ paths: ["public/brand.svg"] });

    await expect(
      harness.behavior.callRpc("setProjectIcon", {
        projectId: "proj_1",
        path: "public/brand.svg",
      }),
    ).resolves.toEqual({
      customPath: "public/brand.svg",
      customUploadName: null,
    });
    await expect(harness.behavior.callRpc("listProjectIconSettings", {})).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: "public/brand.svg",
          customUploadName: null,
        },
      ],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "project-icons",
      payload: { projectId: "proj_1" },
    });

    await expect(
      harness.behavior.callRpc("uploadProjectIcon", {
        projectId: "proj_1",
        filename: "brand.svg",
        mimeType: "image/svg+xml",
        contentBase64: "PHN2Zy8+",
      }),
    ).resolves.toEqual({
      customPath: null,
      customUploadName: "brand.svg",
    });
    await expect(harness.behavior.callRpc("listProjectIconSettings", {})).resolves.toEqual({
      projects: [
        {
          id: "proj_1",
          name: "Sidebar",
          customPath: null,
          customUploadName: "brand.svg",
        },
      ],
    });
    const response = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    await expect(response.text()).resolves.toBe("<svg/>");
  });

  it("serves an automatically discovered favicon through the local route", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (path !== "favicon.svg") throw new Error("not found");
            return {
              content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
              contentEncoding: "utf8" as const,
              mimeType: "image/svg+xml",
              sizeBytes: 46,
            };
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const [response, concurrentResponse] = await Promise.all([
      harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1"),
      harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1"),
    ]);
    expect(response.status).toBe(200);
    expect(concurrentResponse.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    await expect(response.text()).resolves.toContain("<svg");
    expect(harness.inspection.sdk.callsTo("projects.fileContent")).toEqual([
      [{ projectId: "proj_1", hostId: "host_1", path: "package.json" }],
      [{ projectId: "proj_1", hostId: "host_1", path: "favicon.svg" }],
    ]);
  });

  it("finds icons outside the conventional paths through project file search", async () => {
    const project = standardProject();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          files: async ({ query }) => ({
            files:
              query === "icon"
                ? [
                    { name: "favicon.svg", path: "node_modules/pkg/favicon.svg" },
                    { name: "icon-picker.png", path: "docs/icon-picker.png" },
                    { name: "favicon.ico", path: "apps/frontend/src/assets/img/favicon.ico" },
                  ]
                : [{ name: "logo.svg", path: "app/frontend/public/pictures/logo.svg" }],
            truncated: false,
          }),
          fileContent: async ({ path }) => {
            if (path !== "apps/frontend/src/assets/img/favicon.ico") throw new Error("not found");
            return { content: svg, contentEncoding: "utf8" as const, mimeType: "image/x-icon", sizeBytes: 46 };
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const response = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect(harness.inspection.sdk.callsTo("projects.files")).toEqual([
      [{ projectId: "proj_1", hostId: "host_1", query: "icon", limit: "100" }],
      [{ projectId: "proj_1", hostId: "host_1", query: "logo", limit: "100" }],
    ]);
    const reads = harness.inspection.sdk
      .callsTo("projects.fileContent")
      .map(([args]) => (args as { path: string }).path);
    expect(reads.at(-1)).toBe("apps/frontend/src/assets/img/favicon.ico");
    expect(reads).not.toContain("node_modules/pkg/favicon.svg");
    expect(reads).not.toContain("docs/icon-picker.png");
  });

  it("prefers the image declared in package.json bb.branding", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (path === "package.json") {
              const content = JSON.stringify({ bb: { branding: { icon: "brand/mark.png" } } });
              return { content, contentEncoding: "utf8" as const, mimeType: "application/json", sizeBytes: 40 };
            }
            if (path === "brand/mark.png" || path === "favicon.svg") {
              return { content: path, contentEncoding: "utf8" as const, mimeType: "image/png", sizeBytes: 10 };
            }
            throw new Error("not found");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const response = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("brand/mark.png");
  });

  it("keeps a missing icon a miss when the search finds nothing", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          files: async () => ({ files: [], truncated: false }),
          fileContent: async () => {
            throw new Error("not found");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const response = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(response.status).toBe(404);
    // The app waits an hour before asking again only when the 404 carries this mark.
    expect(response.headers.get("x-bb-sidebar-icon-missing")).toBe("1");
  });

  it("does not cache a failed icon read as a missing icon", async () => {
    const project = standardProject();
    let hostReady = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (!hostReady) throw new Error("Host host_1 is not connected");
            if (path !== "icon.svg") throw new Error("not found");
            return {
              content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
              contentEncoding: "utf8" as const,
              mimeType: "image/svg+xml",
              sizeBytes: 46,
            };
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const failed = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(failed.headers.get("x-bb-sidebar-icon-missing")).toBeNull();

    hostReady = true;
    const recovered = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(recovered.status).toBe(200);
    await expect(recovered.text()).resolves.toContain("<svg");
  });

  it("does not reuse or cache an icon resolution that was invalidated", async () => {
    const project = standardProject();
    let oldReadStarted!: () => void;
    const oldReadStartedPromise = new Promise<void>((resolve) => {
      oldReadStarted = resolve;
    });
    let resolveOldRead!: (file: {
      content: string;
      contentEncoding: "utf8";
      mimeType: string;
      sizeBytes: number;
    }) => void;
    const oldRead = new Promise<{
      content: string;
      contentEncoding: "utf8";
      mimeType: string;
      sizeBytes: number;
    }>((resolve) => {
      resolveOldRead = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async ({ path }) => {
            if (path === "old.svg") {
              oldReadStarted();
              return oldRead;
            }
            if (path === "new.svg") {
              return {
                content: "new",
                contentEncoding: "utf8" as const,
                mimeType: "image/svg+xml",
                sizeBytes: 3,
              };
            }
            throw new Error("not found");
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await harness.behavior.callRpc("setProjectIcon", {
      projectId: "proj_1",
      path: "old.svg",
    });
    const firstResponse = harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    await oldReadStartedPromise;

    await expect(
      harness.behavior.callRpc("setProjectIcon", {
        projectId: "proj_1",
        path: "new.svg",
      }),
    ).resolves.toEqual({
      customPath: "new.svg",
      customUploadName: null,
    });
    const secondResponse = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.text()).resolves.toBe("new");

    resolveOldRead({
      content: "old",
      contentEncoding: "utf8",
      mimeType: "image/svg+xml",
      sizeBytes: 3,
    });
    const first = await firstResponse;
    expect(first.status).toBe(200);
    await expect(first.text()).resolves.toBe("old");

    const afterPendingResponse = await harness.behavior.fetchHttp("GET", "/project-icon?projectId=proj_1");
    expect(afterPendingResponse.status).toBe(200);
    await expect(afterPendingResponse.text()).resolves.toBe("new");
  });
});
