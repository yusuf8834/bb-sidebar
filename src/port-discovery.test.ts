import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createPortDiscovery } from "./port-discovery";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["list"]>>[number];

describe("sidebar port discovery", () => {
  it("scans each host, shares concurrent results, and drops failed hosts on refresh", async () => {
    let offline = false;
    const scan = vi.fn(async ({ hostId }: { hostId: string }) => {
      if (offline) throw new Error("Host offline");
      return {
        ports: [
          {
            environmentId: hostId === "host_a" ? "env_a" : "env_b",
            port: 3000,
            processName: "node",
            pid: 1234,
            address: "127.0.0.1",
            source: "process",
            ownerThreadId: "a",
          },
          { environmentId: "unrequested", port: 9999 },
        ],
      };
    });
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: {
        threads: {
          list: async () => [
            makeThreadResponse({ id: "a", environmentId: "env_a" }),
            makeThreadResponse({ id: "a2", environmentId: "env_a" }),
            makeThreadResponse({ id: "b", environmentId: "env_b" }),
          ],
        },
        environments: {
          list: async () =>
            ["env_a", "env_b"].map(
              (id) =>
                ({
                  id,
                  status: "ready",
                  path: `/workspace/${id}`,
                  hostId: id === "env_a" ? "host_a" : "host_b",
                }) as Environment,
            ),
        },
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const discover = createPortDiscovery(bb);
      const [first, second] = await Promise.all([discover(), discover()]);
      expect(first).toEqual(second);
      expect(first.groups.map((group) => group.environmentId).sort()).toEqual(["env_a", "env_b"]);
      expect(first.groups.find((group) => group.environmentId === "env_a")?.ports[0]).toEqual({
        port: 3000,
        processName: "node",
        pid: 1234,
        address: "127.0.0.1",
        source: "process",
        ownerThreadId: "a",
      });
      expect(first.groups.find((group) => group.environmentId === "env_b")?.ports[0].ownerThreadId).toBeUndefined();
      expect(scan).toHaveBeenCalledTimes(2);
      await discover();
      expect(scan).toHaveBeenCalledTimes(2);
      discover.invalidate();
      await discover();
      expect(scan).toHaveBeenCalledTimes(4);
      scan.mockClear();
      offline = true;
      clock.mockReturnValue(131_000);
      expect(await discover()).toEqual({ groups: [] });
      expect(scan).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(162_000);
      await discover();
      expect(scan).toHaveBeenCalledTimes(4);
      clock.mockReturnValue(193_000);
      await discover();
      expect(scan).toHaveBeenCalledTimes(4); // Second failure backs off for a minute.
      offline = false;
      clock.mockReturnValue(224_000);
      expect((await discover()).groups).toHaveLength(2);
      expect(scan).toHaveBeenCalledTimes(6);
      clock.mockReturnValue(255_000);
      await discover();
      expect(scan).toHaveBeenCalledTimes(8); // Recovery resets backoff.
    } finally {
      clock.mockRestore();
      await harness.lifecycle.dispose();
    }
  });

  it("bounds host requests and picks up moved environments on the next scan", async () => {
    let hostActive = 0;
    let maxHosts = 0;
    let moved = false;
    const environments = vi.fn(async () =>
      Array.from(
        { length: 20 },
        (_, i) =>
          ({
            id: `env_${i}`,
            status: "ready",
            path: moved && i === 19 ? "/moved" : `/workspace/env_${i}`,
            hostId: `env_${i}`,
          }) as Environment,
      ),
    );
    const scan = vi.fn(async () => {
      maxHosts = Math.max(maxHosts, ++hostActive);
      await new Promise((resolve) => setTimeout(resolve, 1));
      hostActive--;
      return { ports: [] };
    });
    const list = vi.fn(async () =>
      Array.from({ length: 20 }, (_, i) => makeThreadResponse({ id: `thr_${i}`, environmentId: `env_${i}` })),
    );
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: { threads: { list }, environments: { list: environments } },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const discover = createPortDiscovery(bb);
      await discover();
      expect(maxHosts).toBe(4);
      clock.mockReturnValue(10_000);
      await discover();
      expect(list).toHaveBeenCalledTimes(1);
      expect(environments).toHaveBeenCalledTimes(1);
      expect(scan).toHaveBeenCalledTimes(20);
      moved = true;
      clock.mockReturnValue(31_000);
      await discover();
      expect(environments).toHaveBeenCalledTimes(2);
      expect(scan).toHaveBeenCalledTimes(40);
      expect(harness.inspection.experimental_hostRpcCalls.at(-1)?.input).toEqual({
        roots: [{ environmentId: "env_19", path: "/moved" }],
      });
    } finally {
      clock.mockRestore();
      await harness.lifecycle.dispose();
    }
  });

  it("reads every environment's status in one paged list instead of one get each", async () => {
    const count = 600;
    const threads = vi.fn(async ({ offset = 0, limit = 500 }: { offset?: number; limit?: number } = {}) =>
      Array.from({ length: count }, (_, i) => makeThreadResponse({ id: `thr_${i}`, environmentId: `env_${i}` })).slice(
        offset,
        offset + limit,
      ),
    );
    const environments = vi.fn(async ({ offset = 0, limit = 500 }: { offset?: number; limit?: number } = {}) =>
      Array.from(
        { length: count },
        (_, i) => ({ id: `env_${i}`, status: "ready", path: `/workspace/env_${i}`, hostId: "host_1" }) as Environment,
      ).slice(offset, offset + limit),
    );
    const get = vi.fn();
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: async () => ({ ports: [] }),
      sdk: { threads: { list: threads }, environments: { list: environments, get } },
    });
    try {
      await createPortDiscovery(bb)();
      expect(threads).toHaveBeenCalledTimes(2);
      expect(environments).toHaveBeenCalledTimes(2);
      expect(environments.mock.calls.map(([args]) => ({ ...args, signal: undefined }))).toEqual([
        { status: "ready", limit: 500, offset: 0, signal: undefined },
        { status: "ready", limit: 500, offset: 500, signal: undefined },
      ]);
      expect(get).not.toHaveBeenCalled();
      expect((harness.inspection.experimental_hostRpcCalls[0]?.input as { roots: unknown[] }).roots).toHaveLength(
        count,
      );
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("skips environments that are not ready, have no path, or belong to no unarchived thread", async () => {
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: async () => ({ ports: [] }),
      sdk: {
        threads: {
          list: async () =>
            // Thread rows keep a stale path while the workspace is torn down.
            ["env_ready", "env_teardown", "env_no_path", "env_second"].map((environmentId) => ({
              ...makeThreadResponse({ id: `thr_${environmentId}`, environmentId }),
              environmentHostId: "host_1",
              environmentPath: `/stale/${environmentId}`,
            })),
        },
        environments: {
          // Ignores the status filter, as a host might, so the client-side check is exercised too.
          list: async () =>
            [
              { id: "env_second", status: "ready", path: "/workspace/second", hostId: "host_1" },
              { id: "env_ready", status: "ready", path: "/workspace/ready", hostId: "host_1" },
              { id: "env_teardown", status: "error", path: "/workspace/teardown", hostId: "host_1" },
              { id: "env_no_path", status: "ready", path: null, hostId: "host_1" },
              { id: "env_archived", status: "ready", path: "/workspace/archived", hostId: "host_1" },
            ] as Environment[],
        },
      },
    });
    try {
      await createPortDiscovery(bb)();
      expect(harness.inspection.experimental_hostRpcCalls.map((call) => call.input)).toEqual([
        // Roots keep thread-list order, which settles ties between environments at the same path.
        {
          roots: [
            { environmentId: "env_ready", path: "/workspace/ready" },
            { environmentId: "env_second", path: "/workspace/second" },
          ],
        },
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("makes no environment call when no thread has an environment", async () => {
    const environments = vi.fn(async () => [] as Environment[]);
    const { bb, harness } = createFakePluginHost({
      sdk: { threads: { list: async () => [makeThreadResponse({ id: "a" })] }, environments: { list: environments } },
    });
    try {
      expect(await createPortDiscovery(bb)()).toEqual({ groups: [] });
      expect(environments).not.toHaveBeenCalled();
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
