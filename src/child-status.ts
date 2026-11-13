import type { PluginSidebarThread, PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk/app";

/**
 * What a parent card says about its subtree when the list is collapsed.
 *
 * One kind per thread, most urgent first: a failure beats a raised hand,
 * which beats finished work you have not read, which beats live work. The
 * same order picks the glyph the badge draws when children disagree.
 */
export type ChildStatusKind = "failed" | "needs-you" | "done" | "working";

const CHILD_STATUS_KINDS: readonly ChildStatusKind[] = ["failed", "needs-you", "done", "working"];

interface ChildStatusSummary {
  failed: number;
  needsYou: number;
  done: number;
  working: number;
  /** The most urgent kind present, or null when every child is idle and read. */
  dominant: ChildStatusKind | null;
}

/**
 * Every indicator this sidebar draws itself. bb adds kinds faster than the
 * plugin ships: a kind missing here is drawn with bb's own glyph and label
 * (see StatusGlyph and StatusOrTime), so users never lose a status bb shows.
 * A test fails the build when the pinned SDK names a kind this list lacks.
 */
export const KNOWN_INDICATORS = [
  "background-agent",
  "background-command",
  "draft",
  "none",
  "plan-mode",
  "queued-failed",
  "queued-waiting",
  "runtime",
  "unread-error",
  "unread-success",
  "waiting-for-input",
  "workflow",
  "working-draft",
] as const satisfies readonly PluginSidebarThreadIndicator[];

const knownIndicators: ReadonlySet<string> = new Set(KNOWN_INDICATORS);

/** Whether this sidebar has its own glyph and wording for the indicator. */
export function isKnownIndicator(indicator: PluginSidebarThreadIndicator): boolean {
  return knownIndicators.has(indicator);
}

/**
 * The `default` branch of a switch over every indicator. Its `never`
 * parameter fails typecheck when a new SDK kind has no case; at runtime it
 * hands back the unknown kind, which callers pass to bb to draw.
 */
export function unhandledIndicator(indicator: never): PluginSidebarThreadIndicator {
  return indicator;
}

/**
 * Whether a thread is working, for display. App code passes
 * isThreadWorkingForDisplay from working-tree.ts with each thread's own row
 * status; this shared module cannot call bb's status resolver itself.
 */
export type ThreadWorking = (thread: PluginSidebarThread) => boolean;

export function childStatusKind(thread: PluginSidebarThread, isWorking: ThreadWorking): ChildStatusKind | null {
  if (thread.indicator === "unread-error" || thread.queuedWork === "failed") return "failed";
  if (threadAsksForInput(thread)) return "needs-you";
  if (thread.indicator === "unread-success") return "done";
  if (isWorking(thread)) return "working";
  return null;
}

export function childStatusSummary(
  threads: readonly PluginSidebarThread[],
  isWorking: ThreadWorking,
): ChildStatusSummary {
  const summary: ChildStatusSummary = {
    failed: 0,
    needsYou: 0,
    done: 0,
    working: 0,
    dominant: null,
  };
  for (const thread of threads) {
    if (thread.isArchived) continue;
    switch (childStatusKind(thread, isWorking)) {
      case "failed":
        summary.failed += 1;
        break;
      case "needs-you":
        summary.needsYou += 1;
        break;
      case "done":
        summary.done += 1;
        break;
      case "working":
        summary.working += 1;
        break;
      default:
        break;
    }
  }
  summary.dominant = CHILD_STATUS_KINDS.find((kind) => childStatusCount(summary, kind) > 0) ?? null;
  return summary;
}

function childStatusCount(summary: ChildStatusSummary, kind: ChildStatusKind): number {
  switch (kind) {
    case "failed":
      return summary.failed;
    case "needs-you":
      return summary.needsYou;
    case "done":
      return summary.done;
    case "working":
      return summary.working;
  }
}

/**
 * The counts as tooltip text, e.g. ", 1 failed, 2 need you". Empty when
 * nothing in the subtree needs a word.
 */
export function childStatusPhrase(summary: ChildStatusSummary): string {
  const parts: string[] = [];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.needsYou > 0) parts.push(`${summary.needsYou} need you`);
  if (summary.done > 0) parts.push(`${summary.done} done`);
  if (summary.working > 0) parts.push(`${summary.working} working`);
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

/** The indicator whose glyph and tone stand for a kind. */
export function childStatusIndicator(kind: ChildStatusKind): PluginSidebarThreadIndicator {
  switch (kind) {
    case "failed":
      return "unread-error";
    case "needs-you":
      return "waiting-for-input";
    case "done":
      return "unread-success";
    case "working":
      return "runtime";
  }
}

/** Whether a thread is blocked on the user: a question, an approval, or a prompt. */
export function threadAsksForInput(thread: PluginSidebarThread): boolean {
  return thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
}

/**
 * Every thread with a descendant that waits on the user. A child's question
 * is shown under its parent rather than in its own row, so the parent's
 * placement has to answer for it: such a tree belongs in Active, and wakes
 * from a snooze, just as it would if the parent itself had asked.
 *
 * Walks up from each asking thread; archived ancestors and cycles stop it.
 */
export function threadsWithAskingDescendants(threads: readonly PluginSidebarThread[]): ReadonlySet<string> {
  return ancestorsOfAskingThreads(threads, threadAsksForInput);
}

/**
 * The same walk over any thread shape, given what counts as asking. The
 * server's thread lists have no row indicator, so `bb sidebar list` asks with
 * `hasPendingInteraction` alone.
 */
export function ancestorsOfAskingThreads<
  T extends { readonly id: string; readonly parentThreadId: string | null; readonly isArchived?: boolean },
>(threads: readonly T[], asks: (thread: T) => boolean): ReadonlySet<string> {
  const result = new Set<string>();
  let byId: ReadonlyMap<string, T> | undefined;
  for (const thread of threads) {
    if (thread.isArchived || thread.parentThreadId === null || !asks(thread)) continue;
    byId ??= new Map(threads.map((candidate) => [candidate.id, candidate]));
    const visited = new Set([thread.id]);
    let parent = byId.get(thread.parentThreadId);
    while (parent && !parent.isArchived && !visited.has(parent.id)) {
      visited.add(parent.id);
      result.add(parent.id);
      parent = parent.parentThreadId === null ? undefined : byId.get(parent.parentThreadId);
    }
  }
  return result;
}

/** Visible descendants in sibling order; archived branches and cycles stop. */
export function childSubtree(
  children: readonly PluginSidebarThread[],
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
): PluginSidebarThread[] {
  const result: PluginSidebarThread[] = [];
  const visited = new Set<string>();
  const visit = (siblings: readonly PluginSidebarThread[]) => {
    for (const child of siblings) {
      if (child.isArchived || visited.has(child.id)) continue;
      visited.add(child.id);
      result.push(child);
      visit(childrenByParent.get(child.id) ?? []);
    }
  };
  visit(children);
  return result;
}
