import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server";
import { SIDE_CHATS_TAG } from "./rpc-tags";
import { createFakePluginHost, disposers, projectThread, type ProjectThread } from "./test-server";

type ListArgs = Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0];

function sideChat(overrides: Partial<ProjectThread> & { id: string }): ProjectThread {
  return projectThread({
    originKind: "fork",
    originPluginId: "side-chat",
    sourceThreadId: "main",
    visibility: "hidden",
    titleFallback: "Replying to this earlier message in the conversation: Why?",
    createdAt: 10,
    latestAttentionAt: 20,
    lastReadAt: 20,
    ...overrides,
  });
}

async function setup(threads: ProjectThread[]) {
  const listed: ListArgs[] = [];
  const list = vi.fn(async (args: ListArgs) => {
    listed.push(args);
    const matches = threads.filter(
      (thread) =>
        (args?.includeHidden || thread.visibility === "visible") &&
        (!args?.originPluginId || thread.originPluginId === args.originPluginId) &&
        (!args?.threadIds || args.threadIds.includes(thread.id)),
    );
    const offset = args?.offset ?? 0;
    return matches.slice(offset, offset + (args?.limit ?? 100));
  });
  const events = vi.fn(async ({ threadId }: { threadId: string }) =>
    threadId === "running" ? [{ type: "turn/started" }] : [],
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: { threads: { list } as never },
  });
  harness.inspection.sdk.stub("threads.events.list", events as never);
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  const read = async () =>
    ((await harness.behavior.callRpc("listSideChats", {})) as { sideChats: { id: string }[] }).sideChats.map(
      (row) => row.id,
    );
  return { bb, harness, events, listed, read };
}

describe("side chats", () => {
  it("lists side chats someone wrote in, from sources that are not settled", async () => {
    const { bb, events, read } = await setup([
      projectThread({ id: "main" }),
      projectThread({ id: "quiet", latestAttentionAt: 1 }),
      sideChat({ id: "answered" }),
      sideChat({ id: "empty", latestAttentionAt: 10 }),
      sideChat({ id: "running", latestAttentionAt: 10, status: "active" }),
      sideChat({ id: "opening", latestAttentionAt: 10, status: "starting" }),
      sideChat({ id: "kept", visibility: "visible" }),
      sideChat({ id: "orphan", sourceThreadId: "gone" }),
      sideChat({ id: "under-settled", sourceThreadId: "quiet" }),
      projectThread({ id: "other-fork", originKind: "fork", originPluginId: "other", visibility: "hidden" }),
    ]);
    bb.storage
      .database()
      .prepare(
        `INSERT INTO thread_lifecycle (thread_id, settled_at, settled_override, snoozed_until, snoozed_at, parked_at)
         VALUES ('quiet', 5, NULL, NULL, NULL, NULL)`,
      )
      .run();
    expect(await read()).toEqual(["answered", "running"]);
    // Only first turns still running need the event log, and once is enough.
    expect(events.mock.calls.map(([input]) => input.threadId)).toEqual(["running", "opening"]);
    await read();
    expect(events.mock.calls.map(([input]) => input.threadId)).toEqual(["running", "opening", "opening"]);
  });

  it("names the row's source and status from bb's thread", async () => {
    const { harness } = await setup([projectThread({ id: "main" }), sideChat({ id: "answered", title: "T" })]);
    await expect(harness.behavior.callRpc("listSideChats", {})).resolves.toEqual({
      sideChats: [
        expect.objectContaining({
          id: "answered",
          sourceThreadId: "main",
          title: "T",
          status: "idle",
          runtimeStatus: "idle",
          latestAttentionAt: 20,
        }),
      ],
    });
  });

  it("rereads only when a side chat changes", async () => {
    const { harness } = await setup([projectThread({ id: "main" })]);
    const before = harness.inspection.experimental_rpcInvalidations.length;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: projectThread({ id: "main" }) as never,
      lastAssistantText: null,
    });
    expect(harness.inspection.experimental_rpcInvalidations.length).toBe(before);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: sideChat({ id: "answered" }) as never,
      lastAssistantText: null,
    });
    expect(harness.inspection.experimental_rpcInvalidations.slice(before)).toContainEqual([SIDE_CHATS_TAG]);
  });
});
