import { expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createThreadPullRequests } from "./thread-pull-requests";

type Sdk = BbPluginApi["sdk"];

function created(seq: number, number: number) {
  return {
    seq,
    type: "item/completed",
    data: {
      item: {
        type: "commandExecution",
        command: "gh pr create --fill",
        aggregatedOutput: `https://github.com/o/r/pull/${number}`,
      },
    },
  };
}

it("scans new events only and caches merged PR status", async () => {
  let events = [created(1, 10), created(2, 11)];
  // Pages like bb's API: at most `limit` events, which it caps at 100.
  const list = vi.fn(async ({ afterSeq, limit }: { afterSeq?: string; limit: string }) => {
    if (Number(limit) > 100) throw new Error("Thread event limit cannot exceed 100");
    return events.filter((event) => event.seq > Number(afterSeq ?? 0)).slice(0, Number(limit));
  });
  const call = vi.fn(async ({ input }: { input: unknown }) => ({
    pullRequests: (input as { urls: string[] }).urls.map((url) => ({
      url,
      number: Number(url.split("/").at(-1)),
      title: `PR ${url.split("/").at(-1)}`,
      state: url.endsWith("/10") ? "merged" : "open",
    })),
  }));
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: call,
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_a", environmentId: "env_a" }),
        events: { list } as unknown as Sdk["threads"]["events"],
      },
      environments: {
        get: async () => ({ id: "env_a", hostId: "host_a" }) as Awaited<ReturnType<Sdk["environments"]["get"]>>,
      },
    },
  });
  try {
    const pullRequests = createThreadPullRequests(bb);
    await expect(pullRequests.getThreadPullRequests({ threadId: "thr_a" })).resolves.toEqual({
      pullRequests: [
        { url: "https://github.com/o/r/pull/11", number: 11, title: "PR 11", state: "open" },
        { url: "https://github.com/o/r/pull/10", number: 10, title: "PR 10", state: "merged" },
      ],
    });
    events = [...events, created(3, 12)];
    const second = await pullRequests.getThreadPullRequests({ threadId: "thr_a" });
    expect(second.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([12, 11, 10]);
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ afterSeq: "2", types: ["item/completed"] });
    // #11 is still fresh and #10 is merged, so only the new PR is looked up.
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({
      hostId: "host_a",
      method: "pullRequests",
      input: { urls: ["https://github.com/o/r/pull/12"] },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("lists PR numbers without status when the host lookup fails", async () => {
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: async () => {
      throw new Error("gh: not found");
    },
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_a", environmentId: "env_a" }),
        events: { list: async () => [created(1, 5)] } as unknown as Sdk["threads"]["events"],
      },
      environments: {
        get: async () => ({ id: "env_a", hostId: "host_a" }) as Awaited<ReturnType<Sdk["environments"]["get"]>>,
      },
    },
  });
  try {
    await expect(createThreadPullRequests(bb).getThreadPullRequests({ threadId: "thr_a" })).resolves.toEqual({
      pullRequests: [{ url: "https://github.com/o/r/pull/5", number: 5, title: null, state: null }],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

function sharedHost(eventsByThread: Record<string, ReturnType<typeof created>[]>) {
  const list = vi.fn(async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) =>
    (eventsByThread[threadId] ?? []).filter((event) => event.seq > Number(afterSeq ?? 0)),
  );
  const host = createFakePluginHost({
    experimental_callHostRpc: async ({ input }: { input: unknown }) => ({
      pullRequests: (input as { urls: string[] }).urls.map((url) => ({
        url,
        number: Number(url.split("/").at(-1)),
        title: null,
        state: "merged",
      })),
    }),
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env_a" }),
        events: { list } as unknown as Sdk["threads"]["events"],
      },
      environments: {
        get: async () => ({ id: "env_a", hostId: "host_a" }) as Awaited<ReturnType<Sdk["environments"]["get"]>>,
      },
    },
  });
  const lookups = () =>
    host.harness.inspection.experimental_hostRpcCalls.map((call) => (call.input as { urls: string[] }).urls);
  return { ...host, list, lookups };
}

it("forgets a deleted thread's scan and the statuses only it used", async () => {
  const { bb, harness, list, lookups } = sharedHost({
    thr_a: [created(1, 10), created(2, 11)],
    thr_b: [created(1, 10)],
  });
  try {
    const pullRequests = createThreadPullRequests(bb);
    await pullRequests.getThreadPullRequests({ threadId: "thr_a" });
    await pullRequests.getThreadPullRequests({ threadId: "thr_b" });
    expect(lookups()).toEqual([["https://github.com/o/r/pull/10", "https://github.com/o/r/pull/11"]]);
    pullRequests.forgetThread("thr_a");
    // thr_b keeps its scan and the merged status it shares with thr_a.
    await pullRequests.getThreadPullRequests({ threadId: "thr_b" });
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ threadId: "thr_b", afterSeq: "1" });
    expect(lookups()).toHaveLength(1);
    // thr_a starts over, and only the status no other thread used is gone.
    await pullRequests.getThreadPullRequests({ threadId: "thr_a" });
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ threadId: "thr_a" });
    expect(list.mock.calls.at(-1)?.[0]).not.toHaveProperty("afterSeq");
    expect(lookups().at(-1)).toEqual(["https://github.com/o/r/pull/11"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("does not let a scan in flight bring back a forgotten thread", async () => {
  const { bb, harness, list, lookups } = sharedHost({ thr_a: [created(1, 10)] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listed = list.getMockImplementation()!;
  list.mockImplementationOnce(async (args) => {
    await gate;
    return listed(args);
  });
  try {
    const pullRequests = createThreadPullRequests(bb);
    const first = pullRequests.getThreadPullRequests({ threadId: "thr_a" });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    pullRequests.forgetThread("thr_a");
    release();
    // The caller still gets the PR number; the status for a deleted thread is not kept.
    await expect(first).resolves.toMatchObject({ pullRequests: [{ number: 10, state: null }] });
    await pullRequests.getThreadPullRequests({ threadId: "thr_a" });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).not.toHaveProperty("afterSeq");
    // A merged status would be cached for good, so a second lookup means none was kept.
    expect(lookups()).toEqual([["https://github.com/o/r/pull/10"], ["https://github.com/o/r/pull/10"]]);
  } finally {
    await harness.lifecycle.dispose();
  }
});
