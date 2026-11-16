import { describe, expect, it } from "vitest";
import type { SideChatRow } from "./contract";
import { threadDisplayTitle, threadTitleHasMentions } from "./inbox";
import { sideChatTitle, withSideChats } from "./side-chats";
import { sidebarThread } from "./test-fixtures";

const main = sidebarThread({ id: "main", title: "Main thread", displayTitle: "Main thread" });

function row(overrides: Partial<SideChatRow> = {}): SideChatRow {
  return {
    id: "side",
    projectId: "proj_1",
    sourceThreadId: "main",
    providerId: "codex",
    title: null,
    titleFallback: "Replying to this earlier message in the conversation: Why the cache?",
    status: "idle",
    runtimeStatus: "idle",
    createdAt: 10,
    updatedAt: 20,
    lastReadAt: 20,
    latestAttentionAt: 20,
    ...overrides,
  };
}

describe("side chats as children", () => {
  it("adds a side chat under the thread it came from, named for rows", () => {
    const [, child] = withSideChats([main], [row()]);
    expect(child).toMatchObject({
      id: "side",
      parentThreadId: "main",
      title: "Side chat - Why the cache?",
      href: "/projects/proj_1/threads/side",
      isHidden: true,
      isUnread: false,
      indicator: "none",
    });
    // Rows draw the plain title, not bb's own title with the old text.
    expect(threadDisplayTitle(child!)).toBe("Side chat - Why the cache?");
    expect(threadTitleHasMentions(child!)).toBe(false);
  });

  it("shows a running side chat as working and a finished one as unread", () => {
    expect(withSideChats([main], [row({ status: "active" })])[1]?.indicator).toBe("runtime");
    expect(withSideChats([main], [row({ latestAttentionAt: 30 })])[1]?.isUnread).toBe(true);
  });

  it.each([
    ["its own title", { title: "Cache design" }, "Side chat - Cache design"],
    ["its title without the fork suffix", { title: "Cache design (fork)" }, "Side chat - Cache design"],
    ["a fallback without the reply prefix", { titleFallback: "Look at this" }, "Side chat - Look at this"],
    [
      "the seed's own line break",
      { titleFallback: "Replying to this earlier message in the conversation:\n\nLook" },
      "Side chat - Look",
    ],
    ["its id", { titleFallback: null }, "Side chat - side"],
    ["a renamed title that already has the prefix", { title: "Side chat - Mine" }, "Side chat - Mine"],
  ])("names a side chat from %s", (_case, overrides, name) => {
    expect(sideChatTitle(row(overrides))).toBe(name);
  });

  it("leaves out side chats bb lists, or whose source is not listed or archived", () => {
    const threads = [main, sidebarThread({ id: "kept" }), sidebarThread({ id: "old", isArchived: true })];
    const rows = [row({ id: "kept" }), row({ id: "orphan", sourceThreadId: "gone" }), row({ sourceThreadId: "old" })];
    expect(withSideChats(threads, rows)).toBe(threads);
  });
});
