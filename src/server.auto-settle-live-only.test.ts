import { describe, expect, it, vi } from "vitest";
import plugin from "./server";
import {
  availablePullRequest,
  createFakePluginHost,
  deferred,
  disposers,
  projectThread,
  projectsWith,
  pullRequestStatus,
  type LifecycleListResult,
  type ProjectThread,
} from "./test-server";

const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old, status: "idle" as const };

type Row =
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string }
  | ReturnType<typeof availablePullRequest>;

// Ordinary passes re-decide live threads only. The first pass after a start
// and the pass after a rule change re-check settled threads too.
async function load(threads: ProjectThread[], row: (environmentId: string) => Row | Promise<Row>) {
  const batches: string[][] = [];
  let failLookup = false;
  let failList = false;
  const callRpc = pullRequestStatus(row, batches);
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      projects: {
        list: async () => {
          if (failList) throw new Error("projects unavailable");
          return projectsWith(threads);
        },
      },
      plugins: {
        callRpc: async (input) => {
          if (failLookup) {
            failLookup = false;
            batches.push(["failed"]);
            throw new Error("PR Status unavailable");
          }
          return callRpc(input);
        },
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
  const changeRules = async (autoSettleAfterDays: number) => {
    const settings = (await harness.behavior.callRpc("getSidebarSettings", {})) as Record<string, unknown>;
    await harness.behavior.callRpc("updateSidebarSettings", { ...settings, autoSettleAfterDays });
  };
  return {
    batches,
    bb,
    changeRules,
    evaluate,
    failNextLookup: () => {
      failLookup = true;
    },
    failLists: (fail: boolean) => {
      failList = fail;
    },
    settledIds,
  };
}

describe("automatic settle leaves settled threads alone", () => {
  it("looks up only live threads on an ordinary pass, even in a shared workspace", async () => {
    let state: "merged" | "open" = "merged";
    const threads = [
      projectThread({ id: "settled_shared", environmentId: "env_shared", ...quiet }),
      projectThread({ id: "live_shared", environmentId: "env_shared", ...quiet, updatedAt: Date.now() }),
      projectThread({ id: "settled_solo", environmentId: "env_solo", ...quiet }),
    ];
    const policy = await load(threads, () => availablePullRequest(state, new Date(old).toISOString()));
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["settled_shared", "settled_solo"] });
    expect(policy.batches).toEqual([["env_shared", "env_solo"]]);

    // An open PR would return both settled threads under a full re-check.
    state = "open";
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: [] });
    // The shared workspace is still read for its live thread, but that row
    // does not decide the settled thread beside it.
    expect(policy.batches).toEqual([["env_shared", "env_solo"], ["env_shared"]]);
    await expect(policy.settledIds()).resolves.toEqual(["settled_shared", "settled_solo"]);
  });

  it("settles a quiet parent over a settled child whose PR reopened", async () => {
    let state: "merged" | "open" = "merged";
    const threads = [
      projectThread({ id: "parent", ...quiet, pinnedAt: 1 }),
      projectThread({ id: "child", parentThreadId: "parent", environmentId: "env_child", ...quiet }),
    ];
    const policy = await load(threads, () => availablePullRequest(state, new Date(old).toISOString()));
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["child"] });
    threads[0]!.pinnedAt = null;
    state = "open";
    // The settled child is not looked up again, so the whole tree counts as settled.
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["parent"] });
    expect(policy.batches).toEqual([["env_child"]]);
    await expect(policy.settledIds()).resolves.toEqual(["child", "parent"]);
  });

  it.each([
    ["pinned", { pinnedAt: 1 }],
    ["working", { status: "active" as const }],
    ["waiting on a question", { hasPendingInteraction: true }],
    ["holding queued work", { queuedWork: "waiting" as const }],
  ])("returns a settled thread that is %s without a lookup", async (_, change) => {
    const threads = [projectThread({ id: "thr", environmentId: "env_thr", ...quiet })];
    const policy = await load(threads, () => ({ outcome: "absent" }));
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["thr"] });
    Object.assign(threads[0]!, change);
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["thr"] });
    await expect(policy.settledIds()).resolves.toEqual([]);
    expect(policy.batches).toEqual([["env_thr"]]);
  });

  it("re-checks a thread settled before the server started on its first pass", async () => {
    const threads = [projectThread({ id: "thr", environmentId: "env_thr", ...quiet })];
    const policy = await load(threads, () => availablePullRequest("open"));
    const insert = () =>
      policy.bb.storage
        .database()
        .prepare(`INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override) VALUES (?, ?, NULL)`)
        .run("thr", old + 1_000);
    insert();
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["thr"] });
    expect(policy.batches).toEqual([["env_thr"]]);

    insert();
    await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: [] });
    expect(policy.batches).toEqual([["env_thr"]]);
    await expect(policy.settledIds()).resolves.toEqual(["thr"]);
  });

  describe("keeps the re-check after a rule change until one completes", () => {
    const setup = async (row: (environmentId: string) => Row | Promise<Row> = () => ({ outcome: "absent" })) => {
      const threads = [projectThread({ id: "thr", environmentId: "env_thr", ...quiet })];
      const policy = await load(threads, row);
      await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["thr"] });
      await policy.evaluate();
      expect(policy.batches).toEqual([["env_thr"]]);
      return policy;
    };
    // Each full pass reads the settled thread's workspace; ordinary ones do not.
    const expectOrdinaryFromNowOn = async (policy: Awaited<ReturnType<typeof setup>>) => {
      const count = policy.batches.length;
      await policy.evaluate();
      await policy.evaluate();
      expect(policy.batches).toHaveLength(count);
      await expect(policy.settledIds()).resolves.toEqual(["thr"]);
    };

    it("after a pass that throws", async () => {
      const policy = await setup();
      policy.failLists(true);
      await policy.changeRules(2);
      await expect(policy.evaluate()).rejects.toThrow("projects unavailable");
      policy.failLists(false);
      await policy.evaluate();
      await vi.waitFor(() => expect(policy.batches).toEqual([["env_thr"], ["env_thr"]]));
      await expectOrdinaryFromNowOn(policy);
    });

    it("after a pass whose PR lookup failed", async () => {
      const policy = await setup();
      policy.failNextLookup();
      await policy.changeRules(2);
      await policy.evaluate();
      await vi.waitFor(() => expect(policy.batches).toEqual([["env_thr"], ["failed"], ["env_thr"]]));
      await expectOrdinaryFromNowOn(policy);
    });

    it("for each thread whose PR row had no answer, and only for those", async () => {
      let unavailable = false;
      const threads = [
        projectThread({ id: "thr_a", environmentId: "env_a", ...quiet }),
        projectThread({ id: "thr_b", environmentId: "env_b", ...quiet }),
      ];
      const policy = await load(threads, (environmentId) =>
        unavailable && environmentId === "env_a"
          ? { outcome: "unavailable", message: "host_1 is offline" }
          : { outcome: "absent" },
      );
      await expect(policy.evaluate()).resolves.toEqual({ changedThreadIds: ["thr_a", "thr_b"] });
      unavailable = true;
      await policy.changeRules(2);
      await policy.evaluate();
      await vi.waitFor(() => expect(policy.batches).toEqual([["env_a", "env_b"], ["env_a", "env_b"], ["env_a"]]));
      // Once env_a answers, nothing is looked up again.
      unavailable = false;
      await policy.evaluate();
      await policy.evaluate();
      expect(policy.batches.slice(2).every((keys) => keys.length === 1 && keys[0] === "env_a")).toBe(true);
      const answered = policy.batches.length;
      await policy.evaluate();
      await policy.evaluate();
      expect(policy.batches).toHaveLength(answered);
      await expect(policy.settledIds()).resolves.toEqual(["thr_a", "thr_b"]);
    });

    it("after a pass the next rule change superseded", async () => {
      let gate: ReturnType<typeof deferred<void>> | null = null;
      const entered = deferred<void>();
      const policy = await setup(async () => {
        if (gate) {
          const held = gate;
          gate = null;
          entered.resolve();
          await held.promise;
        }
        return { outcome: "absent" };
      });
      const release = deferred<void>();
      gate = release;
      await policy.changeRules(2);
      const superseded = policy.evaluate();
      await entered.promise;
      await policy.changeRules(3);
      release.resolve();
      await superseded;
      await vi.waitFor(() => expect(policy.batches).toEqual([["env_thr"], ["env_thr"], ["env_thr"]]));
      await expectOrdinaryFromNowOn(policy);
    });
  });
});
