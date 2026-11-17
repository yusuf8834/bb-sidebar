import { describe, expect, it } from "vitest";
import plugin from "./server";
import {
  createFakePluginHost,
  disposers,
  projectThread,
  projectsWith,
  pullRequestStatus,
  settleQuietThreads,
  type LifecycleListResult,
} from "./test-server";

const old = Date.now() - 4 * 24 * 60 * 60 * 1_000;
const quiet = { createdAt: old, updatedAt: old, latestAttentionAt: old, status: "idle" as const };

describe("automatic settle with GitHub PR Status", () => {
  it.each([
    ["the machine is unavailable", () => ({ outcome: "unavailable" as const, message: "host_1 is offline" })],
    [
      "the plugin is disabled",
      () => {
        throw new Error("Plugin bb--github-pr-status is disabled");
      },
    ],
    ["a row is malformed", () => ({ outcome: "available", pullRequest: { state: "merged" } }) as never],
  ])("keeps quiet workspace threads in place when %s", async (_, row) => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: {
          list: async () =>
            projectsWith([
              projectThread({ id: "thr_workspace", environmentId: "env_1", ...quiet }),
              projectThread({ id: "thr_plain", ...quiet }),
            ]),
        },
        plugins: { callRpc: pullRequestStatus(row), getSettings: settleQuietThreads },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    // A failed lookup is not evidence that no open PR exists, so only the
    // thread without a workspace reaches the inactivity rule.
    await expect(harness.behavior.callRpc("evaluateAutoSettle", {})).resolves.toEqual({
      changedThreadIds: ["thr_plain"],
    });
    const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult;
    expect(rows.map((lifecycle) => lifecycle.threadId)).toEqual(["thr_plain"]);
  });

  it("reads at most 200 environments per call", async () => {
    const batches: string[][] = [];
    const threads = Array.from({ length: 201 }, (_, index) =>
      projectThread({ id: `thr_${index}`, environmentId: `env_${index}`, ...quiet }),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        projects: { list: async () => projectsWith(threads) },
        plugins: {
          callRpc: pullRequestStatus(() => ({ outcome: "absent" }), batches),
          getSettings: settleQuietThreads,
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    const { changedThreadIds } = (await harness.behavior.callRpc("evaluateAutoSettle", {})) as {
      changedThreadIds: string[];
    };
    expect(changedThreadIds).toHaveLength(201);
    expect(batches.map((keys) => keys.length)).toEqual([200, 1]);
    expect(new Set(batches.flat())).toEqual(new Set(threads.map((thread) => thread.environmentId)));
  });
});
