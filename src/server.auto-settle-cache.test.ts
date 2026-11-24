import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";
import {
  availablePullRequest,
  createFakePluginHost,
  disposers,
  legacySettings,
  projectThread,
  projectsWith,
  pullRequestStatus,
  type LifecycleListResult,
  type ProjectThread,
} from "./test-server";

const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 10, 24, 1, 30);

type Row =
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string }
  | ReturnType<typeof availablePullRequest>;

afterEach(() => vi.useRealTimers());

async function setup(
  threads: ProjectThread[],
  row: (environmentId: string) => Row | Promise<Row>,
  rules = { autoSettleInactive: true, autoSettleOnMerge: true },
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const batches: string[][] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith(threads) },
      plugins: {
        callRpc: pullRequestStatus(row, batches),
        getSettings: legacySettings(rules),
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  return {
    batches,
    runScheduled: () => harness.behavior.runSchedule("auto-settle"),
    evaluateNow: () => harness.behavior.callRpc("evaluateAutoSettle", {}) as Promise<{ changedThreadIds: string[] }>,
    advance: (ms: number) => vi.setSystemTime(Date.now() + ms),
    settledIds: async () =>
      ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows
        .filter((lifecycle) => lifecycle.settledAt !== null)
        .map((lifecycle) => lifecycle.threadId),
  };
}

describe("scheduled auto-settle PR lookup caching and pacing", () => {
  it("reuses cached PR outcomes within TTL and invalidates immediately on new thread activity", async () => {
    const recent = NOW - 60 * MINUTE;
    const threads = [
      projectThread({ id: "thr_absent", environmentId: "env_absent", createdAt: recent, updatedAt: recent }),
      projectThread({ id: "thr_open", environmentId: "env_open", createdAt: recent, updatedAt: recent }),
      projectThread({ id: "thr_unavail", environmentId: "env_unavail", createdAt: recent, updatedAt: recent }),
    ];
    const policy = await setup(threads, (envId) => {
      if (envId === "env_open") return availablePullRequest("open", new Date(recent).toISOString());
      if (envId === "env_unavail") return { outcome: "unavailable", message: "rate limited" };
      return { outcome: "absent" };
    });

    await policy.runScheduled();
    expect(policy.batches).toEqual([["env_absent", "env_open", "env_unavail"]]);

    // Five minutes later: all three remain fresh in cache, zero RPCs.
    policy.advance(5 * MINUTE);
    await policy.runScheduled();
    expect(policy.batches).toHaveLength(1);

    // Fifteen minutes after the first check: open & unavailable expire, absent stays cached for 60m.
    policy.advance(10 * MINUTE);
    await policy.runScheduled();
    expect(policy.batches).toEqual([
      ["env_absent", "env_open", "env_unavail"],
      ["env_open", "env_unavail"],
    ]);

    // New thread activity invalidates env_absent immediately on the next pass.
    threads[0]!.updatedAt = Date.now();
    policy.advance(5 * MINUTE);
    await policy.runScheduled();
    expect(policy.batches[2]).toEqual(["env_absent"]);

    // After 60 minutes without activity, env_absent refreshes on its TTL.
    policy.advance(60 * MINUTE);
    await policy.runScheduled();
    expect(policy.batches[3]).toEqual(["env_open", "env_unavail", "env_absent"]);
  });

  it("caps scheduled uncached lookups at 60 environments per pass and drains oldest first", async () => {
    const old = NOW - 4 * DAY;
    const threads = Array.from({ length: 75 }, (_, i) =>
      projectThread({
        id: `thr_${i}`,
        environmentId: `env_${i}`,
        createdAt: old,
        updatedAt: old,
        latestAttentionAt: old,
      }),
    );
    const policy = await setup(threads, () => ({ outcome: "absent" }));

    await policy.runScheduled();
    expect(policy.batches.map((b) => b.length)).toEqual([60]);
    await expect(policy.settledIds()).resolves.toHaveLength(60);

    // Next 5-minute pass picks up the remaining 15 live environments.
    policy.advance(5 * MINUTE);
    await policy.runScheduled();
    expect(policy.batches.map((b) => b.length)).toEqual([60, 15]);
    await expect(policy.settledIds()).resolves.toHaveLength(75);
  });

  it("skips PR lookups for live threads younger than afterDays when onMerge is off", async () => {
    const recent = NOW - DAY;
    const old = NOW - 4 * DAY;
    const threads = [
      projectThread({ id: "thr_young", environmentId: "env_young", createdAt: recent, updatedAt: recent }),
      projectThread({ id: "thr_old", environmentId: "env_old", createdAt: old, updatedAt: old }),
    ];
    const policy = await setup(threads, () => ({ outcome: "absent" }), {
      autoSettleInactive: true,
      autoSettleOnMerge: false,
    });

    await policy.runScheduled();
    expect(policy.batches).toEqual([["env_old"]]);
    await expect(policy.settledIds()).resolves.toEqual(["thr_old"]);
  });
});
