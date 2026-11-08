import { copyFileSync } from "node:fs";
import { act } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { afterEach, vi } from "vitest";
import { toast } from "sonner";
import plugin from "./server";
import { bbSidebarRpcContract } from "./contract";
import { createFakePluginHost, projectThread, projectsWith, standardProject } from "./test-server";
import { inbox, sidebarSettings, listProps, defaultProviders } from "./test-inbox";
import { deferred } from "./test-fixtures";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
});

/** Keep the SDK's validation and JSON wire drivers across the explicit host/app bridge. */
export async function createWired(
  initial: PluginSidebarThread[],
  options: { fixture?: string; rpcGate?: Promise<void>; terminals?: boolean } = {},
) {
  let threads = [...initial];
  let terminalOpen = options.terminals ?? false;
  const treeIds = (threadId: string) => {
    const ids = new Set([threadId]);
    for (const id of ids) {
      for (const item of threads) if (item.parentThreadId === id) ids.add(item.id);
    }
    return ids;
  };
  const response = (threadId: string) => {
    const item = threads.find((item) => item.id === threadId);
    if (!item) throw new Error(`Unknown thread ${threadId}`);
    return makeThreadResponse({
      id: item.id,
      title: item.title,
      projectId: item.projectId,
      parentThreadId: item.parentThreadId,
      pinnedAt: item.pinnedAt,
      archivedAt: item.archivedAt,
      lastReadAt: item.lastReadAt,
    });
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    sdk: {
      plugins: { getSettings: async () => ({ values: {}, pluginId: "bb-sidebar" }) },
      projects: {
        get: async () => standardProject(),
        list: async () =>
          projectsWith(
            threads.map((item) =>
              projectThread({
                id: item.id,
                title: item.title,
                parentThreadId: item.parentThreadId,
                pinnedAt: item.pinnedAt,
                pinSortKey: item.pinSortKey,
                updatedAt: item.updatedAt,
              }),
            ),
          ),
      },
      threads: {
        get: async ({ threadId }) => response(threadId),
        pin: async ({ threadId }) => {
          threads = threads.map((item) =>
            item.id === threadId ? { ...item, isPinned: true, pinnedAt: Date.now(), pinSortKey: "UU" } : item,
          );
          return response(threadId);
        },
        unpin: async ({ threadId }) => {
          threads = threads.map((item) =>
            item.id === threadId ? { ...item, isPinned: false, pinnedAt: null, pinSortKey: null } : item,
          );
          return response(threadId);
        },
        update: async (args) => {
          threads = threads.map((item) =>
            item.id === args.threadId
              ? {
                  ...item,
                  ...("title" in args ? { title: args.title ?? null } : {}),
                  ...("parentThreadId" in args ? { parentThreadId: args.parentThreadId ?? null } : {}),
                }
              : item,
          );
          return response(args.threadId);
        },
        markRead: async ({ threadId }) => {
          threads = threads.map((item) =>
            item.id === threadId ? { ...item, isUnread: false, lastReadAt: Date.now() } : item,
          );
          return response(threadId);
        },
        markUnread: async ({ threadId }) => {
          threads = threads.map((item) =>
            item.id === threadId ? { ...item, isUnread: true, lastReadAt: null } : item,
          );
          return response(threadId);
        },
        archive: async ({ threadId }) => {
          const ids = treeIds(threadId);
          threads = threads.map((item) =>
            ids.has(item.id) ? { ...item, isArchived: true, archivedAt: Date.now() } : item,
          );
          return { ok: true, archivedThreadIds: [...ids] };
        },
        unarchive: async ({ threadId }) => {
          threads = threads.map((item) =>
            item.id === threadId ? { ...item, isArchived: false, archivedAt: null } : item,
          );
          return { ok: true };
        },
        delete: async ({ threadId, childThreadsConfirmed }) => {
          const ids = treeIds(threadId);
          if (ids.size > 1 && !childThreadsConfirmed) throw new Error("Child threads must be confirmed");
          threads = threads.filter((item) => !ids.has(item.id));
          return { ok: true };
        },
        experimental_listCascade: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({
            threadId,
            cascadeThreadIds: [...treeIds(threadId)].filter((id) => id !== threadId),
          })),
        }),
        defaultExecutionOptions: async () => null,
      },
      terminals: {
        list: async () => ({
          sessions: terminalOpen
            ? [
                {
                  id: "terminal_1",
                  threadId: initial[0]!.id,
                  environmentId: null,
                  hostId: "host_1",
                  status: "running",
                  lastUserInputAt: Date.now(),
                  closeReason: null,
                  cols: 80,
                  rows: 24,
                  createdAt: 1,
                  updatedAt: 1,
                  exitCode: null,
                  initialCwd: "/workspace/sidebar",
                  title: "zsh",
                },
              ]
            : [],
        }),
        close: async () => {
          terminalOpen = false;
        },
      },
    },
  });
  const db = bb.storage.database();
  if (options.fixture) {
    const filename = db.name;
    db.close();
    copyFileSync(options.fixture, filename);
  }
  const slots = new Set<ReturnType<typeof renderSlot>>();
  const archiveRequests: Array<{ threadId: string; confirm: () => Promise<void>; cancel: () => void }> = [];
  let delivered = 0;
  // Publications stay in the fake host's normalized ledger. Explicit flush is
  // the transport pump, so events can also be driven without an app RPC call.
  async function flush() {
    while (delivered < harness.inspection.realtimeSignals.length) {
      const signal = harness.inspection.realtimeSignals[delivered++]!;
      for (const slot of slots) await slot.behavior.emitRealtime(signal.channel, signal.payload);
    }
  }
  function rpcHandlers(replies: Array<{ method: string; result: unknown }>) {
    return Object.fromEntries(
      Object.keys(bbSidebarRpcContract).map((method) => [
        method,
        async (input: unknown) => {
          await options.rpcGate;
          const result = await harness.behavior.callRpc(method, input);
          replies.push({ method, result });
          return result;
        },
      ]),
    );
  }
  const sidebarState = () => ({
    status: "ready" as const,
    threads,
    projects: [{ id: "proj_1", name: "Sidebar", isPersonal: false, href: "", settingsHref: "" }],
  });
  await plugin(bb);
  disposers.push(async () => {
    for (const request of archiveRequests) request.cancel();
    for (const slot of slots) slot.lifecycle.unmount();
    slots.clear();
    await harness.lifecycle.dispose();
  });
  function mount(kind: "inbox" | "settings" = "inbox") {
    const rpcReplies: Array<{ method: string; result: unknown }> = [];
    const rpc = rpcHandlers(rpcReplies);
    const slot =
      kind === "inbox"
        ? renderSlot(inbox, listProps, {
            rpc,
            sidebarThreads: sidebarState(),
            providers: { status: "ready", providers: defaultProviders },
            sdk: {
              threads: {
                get: (args) => bb.sdk.threads.get(args),
                update: (args) => bb.sdk.threads.update(args),
                pin: (args) => bb.sdk.threads.pin(args),
                unpin: (args) => bb.sdk.threads.unpin(args),
                markRead: (args) => bb.sdk.threads.markRead(args),
                markUnread: (args) => bb.sdk.threads.markUnread(args),
                archive: (args) => bb.sdk.threads.archive(args),
                unarchive: (args) => bb.sdk.threads.unarchive(args),
                experimental_listCascade: (args) => bb.sdk.threads.experimental_listCascade(args),
              },
            },
            // Confirmation and the Undo toast below are harness-produced, not host UI.
            // The real checks assert server-side archive/unarchive calls and state.
            archiveThread: async (threadId, sdk) => {
              const done = deferred<void>();
              archiveRequests.push({
                threadId,
                cancel: () => done.resolve(),
                confirm: async () => {
                  const result = await sdk.threads.archive({ threadId });
                  toast.success("Thread archived", {
                    action: {
                      label: "Undo",
                      onClick: () =>
                        Promise.all(result.archivedThreadIds.map((id) => sdk.threads.unarchive({ threadId: id }))),
                    },
                  });
                  done.resolve();
                },
              });
              await done.promise;
            },
          })
        : renderSlot(sidebarSettings, {}, { rpc });
    slots.add(slot);
    return Object.assign(slot, { rpcReplies });
  }
  return {
    bb,
    harness,
    mount,
    archiveRequests,
    flush,
    db: bb.storage.database(),
    async call(method: string, input: unknown = {}) {
      let result: unknown;
      await act(async () => {
        result = await harness.behavior.callRpc(method, input);
      });
      await flush();
      return result;
    },
    async event(name: "thread.active" | "thread.deleted", threadId: string) {
      await act(async () => {
        await harness.behavior.emitThreadEvent(name, { thread: response(threadId) });
        if (name === "thread.deleted") {
          threads = threads.filter((item) => item.id !== threadId);
        }
      });
      await flush();
    },
    unmount(slot: ReturnType<typeof renderSlot>) {
      slots.delete(slot);
      slot.lifecycle.unmount();
    },
    async advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await flush();
    },
  };
}
