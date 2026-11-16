import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerLifecycle } from "./server-lifecycle";
import type { SideChatRow } from "./contract";
import { isTurnInFlight, resolveRowShelf, rowParkSignals } from "./lifecycle";
import { SIDE_CHATS_TAG } from "./rpc-tags";

/** The bundled plugin whose side chats are hidden forks of the thread they came from. */
const SIDE_CHAT_PLUGIN_ID = "side-chat";
const PAGE_SIZE = 100;

interface ForkOrigin {
  originKind: string | null;
  originPluginId: string | null;
  sourceThreadId: string | null;
}

function isSideChat(thread: ForkOrigin): thread is ForkOrigin & { sourceThreadId: string } {
  return (
    thread.originKind === "fork" && thread.originPluginId === SIDE_CHAT_PLUGIN_ID && thread.sourceThreadId !== null
  );
}

/**
 * Side chats for the sidebar. bb's own sidebar view leaves hidden threads
 * out, so this lists them: unarchived, written in, and from a source thread
 * that is not settled. Thread events about a side chat reread it; nothing
 * polls.
 */
export function createServerSideChats(ctx: ServerContext, lifecycle: ReturnType<typeof createServerLifecycle>) {
  const { bb } = ctx;
  // Side chats known to have had a turn. Only ids that needed a lookup land here.
  const started = new Set<string>();

  const listHiddenSideChats = async () => {
    const found = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await bb.sdk.threads.list({
        originKind: "fork",
        originPluginId: SIDE_CHAT_PLUGIN_ID,
        includeHidden: true,
        archived: false,
        limit: PAGE_SIZE,
        offset,
      });
      for (const thread of page) {
        // A side chat the user kept is a visible thread bb already lists.
        if (thread.visibility === "hidden" && thread.archivedAt === null && isSideChat(thread)) found.push(thread);
      }
      if (page.length < PAGE_SIZE) break;
    }
    return found;
  };

  /** Source threads that are listed and not settled. */
  const liveSources = async (sourceIds: readonly string[]) => {
    const rows = new Map(lifecycle.readAll().map((row) => [row.threadId, row]));
    const now = Date.now();
    const live = new Set<string>();
    for (let start = 0; start < sourceIds.length; start += PAGE_SIZE) {
      const threadIds = sourceIds.slice(start, start + PAGE_SIZE);
      for (const source of await bb.sdk.threads.list({ threadIds, archived: false })) {
        if (source.archivedAt !== null || source.deletedAt !== null) continue;
        const signals = {
          ...rowParkSignals(source),
          isUnread: source.lastReadAt === null || source.latestAttentionAt > source.lastReadAt,
          latestAttentionAt: source.latestAttentionAt,
        };
        if (resolveRowShelf(rows.get(source.id), signals, now, source.pinnedAt !== null) !== "settled") {
          live.add(source.id);
        }
      }
    }
    return live;
  };

  /**
   * Whether the user has written in a side chat. A finished turn moves its
   * attention past its creation, which costs nothing to read. Only a first
   * turn still running needs bb's event log, once.
   */
  const hasStarted = async (thread: { id: string; createdAt: number; latestAttentionAt: number; status: string }) => {
    if (thread.latestAttentionAt > thread.createdAt || started.has(thread.id)) return true;
    if (!isTurnInFlight(thread.status as Parameters<typeof isTurnInFlight>[0])) return false;
    const events = await bb.sdk.threads.events.list({ threadId: thread.id, types: ["turn/started"], limit: "1" });
    if (events.length > 0) started.add(thread.id);
    return events.length > 0;
  };

  const listSideChats = async (): Promise<SideChatRow[]> => {
    const sideChats = await listHiddenSideChats();
    const sources = await liveSources([...new Set(sideChats.map((thread) => thread.sourceThreadId))]);
    const rows: SideChatRow[] = [];
    for (const thread of sideChats) {
      if (!sources.has(thread.sourceThreadId) || !(await hasStarted(thread))) continue;
      rows.push({
        id: thread.id,
        projectId: thread.projectId,
        sourceThreadId: thread.sourceThreadId,
        providerId: thread.providerId,
        title: thread.title,
        titleFallback: thread.titleFallback,
        status: thread.status,
        runtimeStatus: thread.runtime.displayStatus,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        lastReadAt: thread.lastReadAt,
        latestAttentionAt: thread.latestAttentionAt,
      });
    }
    return rows;
  };

  const refresh = ({ thread }: { thread: ForkOrigin & { id: string } }) => {
    if (isSideChat(thread)) bb.rpc.experimental_invalidate([SIDE_CHATS_TAG]);
  };
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
  ] as const) {
    bb.events.on(event, refresh);
  }
  bb.events.on("thread.deleted", (payload) => {
    started.delete(payload.thread.id);
    refresh(payload);
  });

  return {
    async listSideChats() {
      return { sideChats: await listSideChats() };
    },
  } satisfies Pick<ServerHandlers, "listSideChats">;
}
