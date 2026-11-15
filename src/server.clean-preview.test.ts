import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  projectThread,
  projectsWith,
  terminalSession,
  type Environment,
} from "./test-server";

describe("lifecycle RPC", () => {
  it("previews settled resources and skips a thread that becomes active before cleaning", async () => {
    let laterActive = false;
    const settled = projectThread({
      id: "thr_settled",
      environmentId: "env_shared",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared",
    });
    const active = projectThread({
      id: "thr_active",
      environmentId: "env_shared",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared",
      status: "active",
    });
    const safe = projectThread({ id: "thr_safe" });
    const empty = projectThread({ id: "thr_empty" });
    const later = () => projectThread({ id: "thr_later", status: laterActive ? "active" : "idle" });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith([settled, active, safe, empty, later()]) },
        threads: {
          get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
          unpin: async ({ threadId }) => makeThreadResponse({ id: threadId }),
          stop: async () => ({ ok: true as const }),
        },
        terminals: {
          list: async ({ scope }) => ({
            sessions:
              scope.threadId === "thr_empty"
                ? []
                : [
                    {
                      ...terminalSession({ id: `term_${scope.threadId}`, lastUserInputAt: 5 }),
                      threadId: scope.threadId,
                    },
                  ],
          }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_settled" });
    await harness.behavior.callRpc("settle", { threadId: "thr_later" });
    await harness.behavior.callRpc("settle", { threadId: "thr_safe" });
    await harness.behavior.callRpc("settle", { threadId: "thr_empty" });

    const preview = (await harness.behavior.callRpc("previewSettledCleanup", {
      threadIds: ["thr_settled", "thr_safe", "thr_later", "thr_active", "thr_empty"],
    })) as {
      token: string;
      threads: Array<{ threadId: string; terminalCount: number; ports: number[] }>;
      skipped: Array<{ threadId: string }>;
    };
    expect(preview.threads).toEqual([
      expect.objectContaining({ threadId: "thr_safe", terminalCount: 1, ports: [] }),
      expect.objectContaining({ threadId: "thr_later", terminalCount: 1, ports: [] }),
    ]);
    expect(preview.skipped).toHaveLength(2);
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: "thr_active" }),
        {
          threadId: "thr_settled",
          resource: "terminal",
          message: "Kept 1 terminal open: could not confirm that its workspace is not shared with active work",
        },
      ]),
    );
    const stopsBefore = harness.inspection.sdk.callsTo("threads.stop").length;
    laterActive = true;
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({
      closedTerminals: 1,
      signalledPorts: [],
      skipped: expect.arrayContaining([expect.objectContaining({ threadId: "thr_later", resource: "thread" })]),
    });
    expect(harness.inspection.sdk.callsTo("threads.stop").slice(stopsBefore)).toEqual([]);
    expect(harness.inspection.sdk.callsTo("terminals.close")).toEqual([
      [{ terminalId: "term_thr_safe", mode: "force" }],
    ]);
    await expect(harness.behavior.callRpc("cleanSettled", { token: preview.token })).rejects.toThrow("expired");
  });

  it("signals only previewed owned ports and rechecks shared workspaces before cleaning", async () => {
    let portOpen = true;
    let activeSibling = false;
    let shutdownCalls = 0;
    let workspacePath = "/workspace/shared";
    const owner = projectThread({
      id: "thr_owner",
      environmentId: "env_one",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared",
    });
    const sibling = projectThread({
      id: "thr_sibling",
      environmentId: "env_other",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared",
      status: "active",
      visibility: "hidden",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots")
          return { roots: (input as { roots: Array<{ environmentId: string; path: string }> }).roots };
        if (method === "scan")
          return {
            ports: portOpen
              ? [
                  {
                    environmentId: "env_one",
                    port: 3000,
                    pid: 45,
                    processStartedAt: "Sat Oct  3 12:29:38 2026",
                    source: "process",
                    ownerThreadId: "thr_owner",
                  },
                ]
              : [],
          };
        if (method === "closeOwnedPorts") {
          shutdownCalls += 1;
          portOpen = false;
          return { signalled: [3000], skipped: [], failed: [] };
        }
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith(activeSibling ? [owner, sibling] : [owner]) },
        threads: {
          get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        environments: {
          get: async () => ({ id: "env_one", hostId: "host_1", path: workspacePath, status: "ready" }) as Environment,
        },
        terminals: { list: async () => ({ sessions: [] }) },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });

    const first = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      token: string;
      threads: Array<{ ports: number[] }>;
    };
    expect(first.threads[0]?.ports).toEqual([3000]);
    const firstResult = await harness.behavior.callRpc("cleanSettled", { token: first.token });
    expect(firstResult).toMatchObject({ signalledPorts: [{ threadId: "thr_owner", port: 3000 }], remainingPorts: [] });
    expect(shutdownCalls).toBe(1);

    portOpen = true;
    const second = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      token: string;
    };
    activeSibling = true;
    const secondResult = await harness.behavior.callRpc("cleanSettled", { token: second.token });
    expect(secondResult).toMatchObject({
      signalledPorts: [],
      skipped: [expect.objectContaining({ threadId: "thr_owner", resource: "thread" })],
    });
    expect(shutdownCalls).toBe(1);

    activeSibling = false;
    const third = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      token: string;
    };
    workspacePath = "/workspace/elsewhere";
    const thirdResult = await harness.behavior.callRpc("cleanSettled", { token: third.token });
    expect(thirdResult).toMatchObject({
      signalledPorts: [],
      skipped: [
        expect.objectContaining({
          threadId: "thr_owner",
          resource: "port",
          message: "Thread workspace changed since preview",
        }),
      ],
    });
    expect(shutdownCalls).toBe(1);
  });

  it("does not close a previewed terminal when its thread starts working during inspection", async () => {
    let working = false;
    let terminalLists = 0;
    const closed: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () => projectsWith([projectThread({ id: "thr_race", status: working ? "active" : "idle" })]),
        },
        threads: {
          get: async () => makeThreadResponse({ id: "thr_race" }),
          unpin: async () => makeThreadResponse({ id: "thr_race" }),
          stop: async () => ({ ok: true as const }),
        },
        terminals: {
          list: async () => {
            terminalLists += 1;
            if (terminalLists === 3) working = true;
            return {
              sessions: [{ ...terminalSession({ id: "term_race", lastUserInputAt: 5 }), threadId: "thr_race" }],
            };
          },
          close: async ({ terminalId }) => {
            closed.push(terminalId);
            return terminalSession({ id: terminalId, status: "exited" });
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_race" });
    const preview = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_race"] })) as {
      token: string;
      threads: unknown[];
    };
    expect(preview.threads).toHaveLength(1);
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({ closedTerminals: 0, skipped: [expect.objectContaining({ resource: "terminal" })] });
    expect(closed).toEqual([]);
  });

  it("protects terminals when different environments resolve to the same workspace", async () => {
    const owner = projectThread({
      id: "thr_owner",
      environmentId: "env_one",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared",
    });
    const active = projectThread({
      id: "thr_active",
      environmentId: "env_two",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared/",
      status: "active",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots")
          return {
            roots: (input as { roots: Array<{ environmentId: string }> }).roots.map((root) => ({
              environmentId: root.environmentId,
              path: "/workspace/shared",
            })),
          };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner, active]) },
        threads: {
          get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        terminals: {
          list: async () => ({
            sessions: [{ ...terminalSession({ id: "term_shared", lastUserInputAt: 5 }), threadId: "thr_owner" }],
          }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const closesBefore = harness.inspection.sdk.callsTo("terminals.close").length;
    const preview = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      threads: unknown[];
      skipped: unknown[];
    };
    expect(preview.threads).toEqual([]);
    expect(preview.skipped).toEqual([
      {
        threadId: "thr_owner",
        resource: "terminal",
        message: 'Kept 1 terminal open: shares a workspace with "Untitled thread", which is not settled',
      },
    ]);
    expect(harness.inspection.sdk.callsTo("terminals.close").slice(closesBefore)).toEqual([]);
  });

  it("does not close a terminal when work is queued during the final workspace lookup", async () => {
    let cleaning = false;
    let queued = false;
    const owner = () =>
      projectThread({
        id: "thr_owner",
        environmentId: "env_one",
        environmentHostId: "host_1",
        environmentPath: "/workspace/one",
        queuedWork: queued ? "waiting" : "none",
      });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: unknown[] }).roots };
        if (method === "scan") return { ports: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner()]) },
        threads: {
          get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        environments: {
          get: async () => {
            if (cleaning) queued = true;
            return { id: "env_one", hostId: "host_1", path: "/workspace/one", status: "ready" } as Environment;
          },
        },
        terminals: {
          list: async () => ({
            sessions: [
              {
                ...terminalSession({ id: "term_owner", environmentId: "env_one", lastUserInputAt: 5 }),
                threadId: "thr_owner",
              },
            ],
          }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const preview = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      token: string;
      threads: unknown[];
    };
    expect(preview.threads).toHaveLength(1);
    cleaning = true;
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(queued).toBe(true);
    expect(result).toMatchObject({ closedTerminals: 0, skipped: [expect.objectContaining({ resource: "terminal" })] });
    expect(harness.inspection.sdk.callsTo("terminals.close")).toEqual([]);
  });

  it("keeps preview inspection failures in the final cleanup result", async () => {
    const owner = projectThread({
      id: "thr_owner",
      environmentId: "env_one",
      environmentHostId: "host_1",
      environmentPath: "/workspace/one",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: unknown[] }).roots };
        if (method === "scan") throw new Error("Port scan unavailable");
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner]) },
        threads: {
          get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_one" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        environments: {
          get: async () =>
            ({ id: "env_one", hostId: "host_1", path: "/workspace/one", status: "ready" }) as Environment,
        },
        terminals: {
          list: async () => ({
            sessions: [
              {
                ...terminalSession({ id: "term_owner", environmentId: "env_one", lastUserInputAt: 5 }),
                threadId: "thr_owner",
              },
            ],
          }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const preview = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      token: string;
      skipped: Array<{ resource: string }>;
    };
    expect(preview.skipped).toEqual([expect.objectContaining({ resource: "port" })]);
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({
      closedTerminals: 1,
      skipped: [
        expect.objectContaining({ resource: "port", message: expect.stringContaining("Port scan unavailable") }),
      ],
    });
  });

  it("does not close a terminal left in an earlier shared workspace", async () => {
    const owner = projectThread({
      id: "thr_owner",
      environmentId: "env_private",
      environmentHostId: "host_1",
      environmentPath: "/workspace/private",
    });
    const sibling = projectThread({
      id: "thr_active",
      environmentId: "env_shared",
      environmentHostId: "host_1",
      environmentPath: "/workspace/shared",
      status: "active",
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "resolveRoots") return { roots: (input as { roots: unknown[] }).roots };
        if (method === "scan") return { ports: [] };
        throw new Error(`Unexpected host call: ${method}`);
      },
      sdk: {
        projects: { list: async () => projectsWith([owner, sibling]) },
        threads: {
          get: async () => makeThreadResponse({ id: "thr_owner", environmentId: "env_private" }),
          unpin: async () => makeThreadResponse({ id: "thr_owner" }),
          stop: async () => ({ ok: true as const }),
        },
        environments: {
          get: async () =>
            ({ id: "env_private", hostId: "host_1", path: "/workspace/private", status: "ready" }) as Environment,
        },
        terminals: {
          list: async () => ({
            sessions: [
              {
                ...terminalSession({ id: "term_old", environmentId: "env_shared", lastUserInputAt: 5 }),
                threadId: "thr_owner",
              },
              {
                ...terminalSession({ id: "term_current", environmentId: "env_private", lastUserInputAt: 5 }),
                threadId: "thr_owner",
              },
            ],
          }),
          close: async ({ terminalId }) => terminalSession({ id: terminalId, status: "exited" }),
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    await harness.behavior.callRpc("settle", { threadId: "thr_owner" });
    const closesBefore = harness.inspection.sdk.callsTo("terminals.close").length;
    const preview = (await harness.behavior.callRpc("previewSettledCleanup", { threadIds: ["thr_owner"] })) as {
      token: string;
      threads: unknown[];
    };
    expect(preview.threads).toEqual([expect.objectContaining({ threadId: "thr_owner", terminalCount: 1 })]);
    const result = await harness.behavior.callRpc("cleanSettled", { token: preview.token });
    expect(result).toMatchObject({ closedTerminals: 1, failed: [] });
    expect(harness.inspection.sdk.callsTo("terminals.close").slice(closesBefore)).toEqual([
      [{ terminalId: "term_current", mode: "force" }],
    ]);
  });
});
