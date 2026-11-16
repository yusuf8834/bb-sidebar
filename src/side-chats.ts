import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { SideChatRow } from "./contract";
import { isTurnInFlight } from "./lifecycle";

const SIDE_CHAT_PREFIX = "Side chat - ";
const FORK_SUFFIX = " (fork)";
// The Side chat plugin seeds the fork with this line and a blank line after it.
const REPLY_FALLBACK_PREFIX = "Replying to this earlier message in the conversation:";

/** "Side chat - " and the side chat's own title, else the message it replies to. */
export function sideChatTitle(row: Pick<SideChatRow, "id" | "title" | "titleFallback">): string {
  const title = row.title?.trim() ?? "";
  // A title saved from the rename field already carries the prefix.
  if (title.startsWith(SIDE_CHAT_PREFIX)) return title;
  const fallback = row.titleFallback?.trim() ?? "";
  const name =
    (title.endsWith(FORK_SUFFIX) ? title.slice(0, -FORK_SUFFIX.length).trim() : title) ||
    (fallback.startsWith(REPLY_FALLBACK_PREFIX) ? fallback.slice(REPLY_FALLBACK_PREFIX.length).trim() : fallback) ||
    row.id;
  return `${SIDE_CHAT_PREFIX}${name}`;
}

function sideChatThread(row: SideChatRow): PluginSidebarThread {
  const title = sideChatTitle(row);
  const status = row.status as PluginSidebarThread["status"];
  return {
    id: row.id,
    projectId: row.projectId,
    // Rows draw `title`; a matching `displayTitle` keeps bb's own title out.
    title,
    titleFallback: row.titleFallback,
    displayTitle: title,
    parentThreadId: row.sourceThreadId,
    lifecycleOwnerThreadId: row.sourceThreadId,
    parentNotifications: "auto",
    sourceThreadId: row.sourceThreadId,
    sectionId: null,
    originKind: "fork",
    originPluginId: "side-chat",
    providerId: row.providerId,
    status,
    runtimeStatus: row.runtimeStatus as PluginSidebarThread["runtimeStatus"],
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: isTurnInFlight(status) ? "runtime" : "none",
    indicatorLabel: null,
    isUnread: row.lastReadAt === null || row.latestAttentionAt > row.lastReadAt,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: row.projectId === "proj_personal" ? `/threads/${row.id}` : `/projects/${row.projectId}/threads/${row.id}`,
    isHidden: true,
    environment: null,
    host: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastReadAt: row.lastReadAt,
    latestAttentionAt: row.latestAttentionAt,
  };
}

/**
 * bb's thread list with side chats added as children of the thread they
 * came from. A side chat whose source is not listed, or that bb already
 * lists, is left out.
 */
export function withSideChats(
  threads: readonly PluginSidebarThread[],
  rows: readonly SideChatRow[],
): readonly PluginSidebarThread[] {
  const listed = new Map(threads.map((thread) => [thread.id, thread]));
  const added = rows.filter((row) => !listed.has(row.id) && listed.get(row.sourceThreadId)?.isArchived === false);
  return added.length === 0 ? threads : [...threads, ...added.map(sideChatThread)];
}
