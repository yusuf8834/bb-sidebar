import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  projectThread,
  projectsWith,
  pullRequestStatus,
  type LifecycleListResult,
  type ProjectThread,
} from "./test-server";

const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old, status: "idle" as const };

type Rules = { autoSettleInactive: boolean; autoSettleOnMerge: boolean };

// With both rules off and nothing the policy settled, a pass can change
// nothing, so it skips listing every thread. Counts full thread listings.
async function load(threads: ProjectThread[], rules?: Rules) {
  let lists = 0;
  const missing = new Set<string>();
  const listed = () => threads.filter((thread) => !missing.has(thread.id));
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: { list: async () => projectsWith(listed()) },
      threads: {
        list: async (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => {
          if (args?.threadIds) return listed().filter((thread) => args.threadIds!.includes(thread.id));
          lists += 1;
          const offset = args?.offset ?? 0;
          return listed().slice(offset, offset + (args?.limit ?? 100));
        },
      },
      plugins: {
        callRpc: pullRequestStatus(() => ({ outcome: "absent" })),
        // Legacy settings imported on first start set the rules without a pass.
        ...(rules && {
          getSettings: async () => ({ ok: true as const, schema: {}, values: { ...rules } }),
        }),
      },
    },
  });
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const evaluate = () => harness.behavior.callRpc("evaluateAutoSettle", {}) as Promise<{ changedThreadIds: string[] }>;
  const settledIds = async () =>
    ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows
      .filter((lifecycle) => lifecycle.settledAt !== null)
      .map((lifecycle) => lifecycle.threadId);
  // Starts its own full pass in the background; `evaluate` then joins it.
  const changeRules = async (next: Rules) => {
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, ...next });
  };
  return { bb, changeRules, evaluate, lists: () => lists, missing, settledIds };
}

const off = { autoSettleInactive: false, autoSettleOnMerge: false };

describe("automatic settle with both rules off", () => {
  it("lists threads on the first pass only", async () => {
    const policy = await load([projectThread({ id: "thr", environmentId: "env_thr", ...quiet })], off);
    // A thread the user settled is not the policy's to change.
    policy.bb.storage
      .database()
      .prepare(`INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override) VALUES (?, ?, 'settled')`)
      .run("thr", old + 1_000);
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: [] });
    expect(policy.lists()).toBe(1);
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: [] });
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: [] });
    expect(policy.lists()).toBe(1);
    await expect(policy.settledIds()).resolves.toEqual(["thr"]);
  });

  it.each([
    ["inactivity", { autoSettleInactive: true, autoSettleOnMerge: false }],
    ["merged PR", { autoSettleInactive: false, autoSettleOnMerge: true }],
  ])("still lists on an ordinary pass with the %s rule on", async (_, rules) => {
    const policy = await load([projectThread({ id: "thr", environmentId: "env_thr", updatedAt: Date.now() })], rules);
    await policy.evaluate();
    await policy.evaluate();
    await policy.evaluate();
    expect(policy.lists()).toBe(3);
  });

  it("runs one full pass after the rules are turned off, then skips", async () => {
    const policy = await load([projectThread({ id: "thr", environmentId: "env_thr", updatedAt: Date.now() })]);
    await policy.evaluate();
    await policy.evaluate();
    expect(policy.lists()).toBe(2);
    await policy.changeRules(off);
    await policy.evaluate();
    expect(policy.lists()).toBe(3);
    await policy.evaluate();
    await policy.evaluate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(policy.lists()).toBe(3);
  });

  it.each([
    ["pinned", { pinnedAt: 1 }],
    ["working", { status: "active" as const }],
  ])("returns a policy-settled thread missing from the re-check once it is back %s", async (_, change) => {
    const threads = [projectThread({ id: "thr", environmentId: "env_thr", ...quiet })];
    const policy = await load(threads);
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["thr"] });
    // The re-check after the rules go off cannot see the thread, so its row
    // survives.
    policy.missing.add("thr");
    await policy.changeRules(off);
    await policy.evaluate();
    await expect(policy.settledIds()).resolves.toEqual(["thr"]);
    policy.missing.delete("thr");
    Object.assign(threads[0]!, change);
    await policy.evaluate();
    await vi.waitFor(async () => expect(await policy.settledIds()).toEqual([]));
  });
});
