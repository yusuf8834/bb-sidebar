import {
  canPark,
  resolveRowShelf,
  resolveShelf,
  type ThreadActivitySignals,
  type ThreadLifecycleRow,
} from "./lifecycle";
import { shelfRowIds } from "./inbox";

export const MIN_AUTO_ARCHIVE_AFTER_DAYS = 1;
export const MAX_AUTO_ARCHIVE_AFTER_DAYS = 365;
export const DEFAULT_AUTO_ARCHIVE_AFTER_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1_000;

export function isValidAutoArchiveAfterDays(days: number): boolean {
  return Number.isInteger(days) && days >= MIN_AUTO_ARCHIVE_AFTER_DAYS && days <= MAX_AUTO_ARCHIVE_AFTER_DAYS;
}

/** The fields of a bb thread-list row that the archive rule reads. */
interface ArchiveThread {
  id: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId?: string | null;
  sourceThreadId?: string | null;
  visibility: string;
  pinnedAt: number | null;
  latestAttentionAt: number;
  environmentId: string | null;
}

/**
 * Every thread bb archives along with `rootId`: its children, its lifecycle
 * dependents and its hidden source threads (side chats, forks), recursively.
 * This mirrors bb's own archive cascade, so the rule can check every thread
 * the archive would take, not only the ones the sidebar draws.
 */
function archiveCascadeIds(threads: readonly ArchiveThread[], rootId: string): string[] {
  const dependents = new Map<string, string[]>();
  const add = (ownerId: string | null | undefined, id: string) => {
    if (!ownerId) return;
    const list = dependents.get(ownerId) ?? [];
    list.push(id);
    dependents.set(ownerId, list);
  };
  for (const thread of threads) {
    add(thread.parentThreadId, thread.id);
    add(thread.lifecycleOwnerThreadId, thread.id);
    if (thread.visibility === "hidden") add(thread.sourceThreadId, thread.id);
  }
  const result = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(dependents.get(id) ?? []));
  }
  return [...result];
}

/** A row that says nothing about its thread: no settle, park, snooze or override. */
function isEmptyRow(row: ThreadLifecycleRow | undefined): boolean {
  return (
    row === undefined ||
    (row.settledAt === null && row.settledOverride == null && row.parkedAt == null && row.snoozedUntil === null)
  );
}

/**
 * Whether bb may archive `rootId` and everything archived with it, and the
 * newest settle among them. Null keeps the tree.
 *
 * The root must be a top-level sidebar row on the Settled shelf. Every
 * thread the archive would take must be unpinned, idle (`canPark`) and
 * settled: by its own row, or, with no row of its own, quiet since the root
 * settled (the child the sidebar files inside its settled parent). A thread
 * the user woke, snoozed, parked or moved to Active keeps the whole tree.
 */
export function settledArchiveTree<T extends ArchiveThread>(
  threads: readonly T[],
  rows: ReadonlyMap<string, ThreadLifecycleRow>,
  rootId: string,
  signalsOf: (thread: T) => ThreadActivitySignals,
  now: number,
): { settledAt: number; threadIds: string[] } | null {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const root = byId.get(rootId);
  if (!root || root.visibility !== "visible" || shelfRowIds(threads).get(rootId) !== rootId) return null;
  const rootRow = rows.get(rootId);
  if (
    rootRow?.settledAt == null ||
    resolveRowShelf(rootRow, signalsOf(root), now, root.pinnedAt !== null) !== "settled"
  ) {
    return null;
  }
  let settledAt = rootRow.settledAt;
  const threadIds = archiveCascadeIds(threads, rootId);
  for (const id of threadIds) {
    const thread = byId.get(id)!;
    const signals = signalsOf(thread);
    if (thread.pinnedAt !== null || !canPark(signals)) return null;
    if (id === rootId) continue;
    const row = rows.get(id);
    if (row?.settledAt != null && resolveShelf(row, signals, now) === "settled") {
      settledAt = Math.max(settledAt, row.settledAt);
    } else if (!isEmptyRow(row) || thread.latestAttentionAt > rootRow.settledAt) {
      return null;
    }
  }
  return { settledAt, threadIds };
}

/** The bb Git plugin's `status` row for one environment, as far as the rule reads it. */
export type WorkspaceStatusRow =
  | {
      outcome: "available";
      workspace: { workingTree: { hasUncommittedChanges: boolean; state: string } };
    }
  | { outcome: string };

/**
 * Only a workspace bb reports as a clean Git checkout is safe to retire:
 * bb removes a worktree with `--force` once the archive's grace window
 * passes, and uncommitted changes are not recoverable. Commits are kept on
 * their branch. Anything bb cannot vouch for (no answer, not a Git
 * workspace, a failed read) keeps the thread.
 */
export function isWorkspaceSafeToRetire(row: WorkspaceStatusRow | undefined): boolean {
  if (row?.outcome !== "available" || !("workspace" in row)) return false;
  const { hasUncommittedChanges, state } = row.workspace.workingTree;
  return !hasUncommittedChanges && (state === "clean" || state === "committed_unmerged");
}
