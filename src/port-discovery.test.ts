import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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
    const threads = vi.fn();
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: {
        threads: { list: threads },
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
      const scanned = createPortDiscovery(bb);
      const discover = Object.assign(() => scanned({ environmentIds: ["env_a", "env_b"] }), scanned);
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
      // Passed through: the app marks only a thread that owns a port in its own workspace.
      expect(first.groups.find((group) => group.environmentId === "env_b")?.ports[0].ownerThreadId).toBe("a");
      expect(threads).not.toHaveBeenCalled();
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
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: { environments: { list: environments } },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const scanned = createPortDiscovery(bb);
      const discover = () => scanned({ environmentIds: Array.from({ length: 20 }, (_, i) => `env_${i}`) });
      await discover();
      expect(maxHosts).toBe(4);
      clock.mockReturnValue(10_000);
      await discover();
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

  it("reads every environment's status in one paged list instead of one get each, and lists no threads", async () => {
    const count = 600;
    const threads = vi.fn();
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
      await createPortDiscovery(bb)({ environmentIds: Array.from({ length: count }, (_, i) => `env_${i}`) });
      expect(threads).not.toHaveBeenCalled();
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

  it("skips environments that are not ready, have no path, or were not asked for", async () => {
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: async () => ({ ports: [] }),
      sdk: {
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
      await createPortDiscovery(bb)({ environmentIds: ["env_ready", "env_teardown", "env_no_path", "env_second"] });
      expect(harness.inspection.experimental_hostRpcCalls.map((call) => call.input)).toEqual([
        // Roots keep the requested order, which settles ties between environments at the same path.
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

  it("caches each workspace for 30s, scans only the ones it lacks, and shares a scan in flight", async () => {
    const scan = vi.fn(async ({ input }: { input: unknown }) => ({
      ports: (input as { roots: { environmentId: string }[] }).roots.map((root) => ({
        environmentId: root.environmentId,
        port: 3000,
      })),
    }));
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: {
        environments: {
          list: async () =>
            ["env_a", "env_b", "env_c"].map(
              (id) => ({ id, status: "ready", path: `/workspace/${id}`, hostId: "host_1" }) as Environment,
            ),
        },
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const roots = () =>
      harness.inspection.experimental_hostRpcCalls.map((call) =>
        (call.input as { roots: { environmentId: string }[] }).roots.map((root) => root.environmentId),
      );
    try {
      const discover = createPortDiscovery(bb);
      await discover({ environmentIds: ["env_a", "env_b"] });
      // A hover on one workspace the poll already covers asks the host nothing.
      expect((await discover({ environmentIds: ["env_b"] })).groups).toEqual([
        { environmentId: "env_b", ports: [{ port: 3000 }] },
      ]);
      await Promise.all([discover({ environmentIds: ["env_c"] }), discover({ environmentIds: ["env_c", "env_a"] })]);
      expect(roots()).toEqual([["env_a", "env_b"], ["env_c"]]);
      clock.mockReturnValue(30_000);
      await discover({ environmentIds: ["env_a"] });
      expect(roots().at(-1)).toEqual(["env_a"]);
      discover.invalidate();
      await discover({ environmentIds: ["env_a"] });
      expect(roots()).toHaveLength(4);
    } finally {
      clock.mockRestore();
      await harness.lifecycle.dispose();
    }
  });

  it("answers a scan that an invalidation overtook, but does not reuse it", async () => {
    let release!: () => void;
    const scan = vi.fn(
      () =>
        new Promise<{ ports: { environmentId: string; port: number }[] }>((resolve) => {
          release = () => resolve({ ports: [{ environmentId: "env_a", port: 3000 }] });
        }),
    );
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: {
        environments: {
          list: async () => [{ id: "env_a", status: "ready", path: "/workspace/a", hostId: "host_1" }] as Environment[],
        },
      },
    });
    try {
      const discover = createPortDiscovery(bb);
      const first = discover({ environmentIds: ["env_a"] });
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
      discover.invalidate();
      release();
      expect((await first).groups).toHaveLength(1);
      const second = discover({ environmentIds: ["env_a"] });
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
      release();
      await second;
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps a nested workspace's listeners with it when only the enclosing workspace is asked for", async () => {
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: async () => ({
        ports: [
          { environmentId: "env_live", port: 3000 },
          // The host gives a listener to the deepest root that contains it.
          { environmentId: "env_nested", port: 4000 },
        ],
      }),
      sdk: {
        environments: {
          list: async () =>
            [
              { id: "env_nested", status: "ready", path: "/workspace/app/.worktrees/old", hostId: "host_1" },
              { id: "env_live", status: "ready", path: "/workspace/app/", hostId: "host_1" },
              { id: "env_sibling", status: "ready", path: "/workspace/application", hostId: "host_1" },
              { id: "env_same", status: "ready", path: "/workspace/app", hostId: "host_1" },
              { id: "env_elsewhere", status: "ready", path: "/workspace/app/nested", hostId: "host_2" },
            ] as Environment[],
        },
      },
    });
    try {
      expect(await createPortDiscovery(bb)({ environmentIds: ["env_live"] })).toEqual({
        groups: [{ environmentId: "env_live", ports: [{ port: 3000 }] }],
      });
      expect(harness.inspection.experimental_hostRpcCalls.map((call) => call.input)).toEqual([
        {
          roots: [
            { environmentId: "env_live", path: "/workspace/app/" },
            { environmentId: "env_nested", path: "/workspace/app/.worktrees/old" },
          ],
        },
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects every caller when a shared scan fails, leaving no failure unobserved", async () => {
    const gates: (() => void)[] = [];
    const { bb, harness } = createFakePluginHost({
      sdk: {
        environments: {
          list: () =>
            new Promise<Environment[]>((_, reject) => {
              gates.push(() => reject(new Error("bb restarting")));
            }),
        },
      },
    });
    try {
      const discover = createPortDiscovery(bb);
      const first = discover({ environmentIds: ["env_a"] });
      // Joins the first scan for env_a and starts its own for env_b.
      const second = discover({ environmentIds: ["env_a", "env_b"] });
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[0]!();
      gates[1]!();
      await expect(first).rejects.toThrow("bb restarting");
      await expect(second).rejects.toThrow("bb restarting");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps a failed host's backoff through scans of other hosts", async () => {
    const scan = vi.fn(async ({ hostId }: { hostId: string }) => {
      if (hostId === "host_a") throw new Error("Host offline");
      return { ports: [] };
    });
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: scan,
      sdk: {
        environments: {
          list: async () =>
            [
              { id: "env_a", status: "ready", path: "/workspace/a", hostId: "host_a" },
              { id: "env_b", status: "ready", path: "/workspace/b", hostId: "host_b" },
            ] as Environment[],
        },
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const discover = createPortDiscovery(bb);
      await discover({ environmentIds: ["env_a"] });
      clock.mockReturnValue(1_000);
      await discover({ environmentIds: ["env_b"] });
      clock.mockReturnValue(2_000);
      discover.invalidate();
      await discover({ environmentIds: ["env_a"] });
      expect(scan.mock.calls.map(([call]) => call.hostId)).toEqual(["host_a", "host_b"]);
    } finally {
      clock.mockRestore();
      await harness.lifecycle.dispose();
    }
  });
});
