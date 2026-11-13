import { describe, expect, it } from "vitest";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import { resolveThreadStatus } from "./bb-sdk";
import { childStatusKind, childSubtree, isKnownIndicator, threadAsksForInput } from "./child-status";
import { isThreadWorking } from "./lifecycle";
import { threadRowStatus, threadShortStatus, threadWithDraft } from "./StatusSlot";
import { idleSidebarThreadFields } from "./test-fixtures";
import { isThreadWorkingForDisplay, isWorkingTree } from "./working-tree";

/**
 * Every combination of the fields bb's status rule reads, run through the
 * sidebar's rules from before it used bb's resolver (frozen below) and
 * through today's code. The table of differences is the whole of the
 * behaviour change: a thread that is not running yet or whose machine is
 * disconnected stops counting as working for display, and another plugin's
 * running status starts to. Anything else fails the test.
 */

// The sidebar's rules before bb's resolver, frozen as the baseline.
const OLD = {
  isWorkingIndicator(indicator: PluginSidebarThreadIndicator): boolean {
    return ["runtime", "workflow", "background-agent", "background-command", "plan-mode", "working-draft"].includes(
      indicator,
    );
  },
  childStatusKind(thread: PluginSidebarThread): string | null {
    if (thread.indicator === "unread-error" || thread.queuedWork === "failed") return "failed";
    if (threadAsksForInput(thread)) return "needs-you";
    if (thread.indicator === "unread-success") return "done";
    if (OLD.isWorkingIndicator(thread.indicator)) return "working";
    return null;
  },
  isWorkingTree(
    thread: PluginSidebarThread,
    childThreads: readonly PluginSidebarThread[],
    childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  ): boolean {
    if (
      thread.hasPendingInteraction ||
      thread.indicator === "waiting-for-input" ||
      thread.indicator === "unread-error" ||
      thread.queuedWork === "failed"
    ) {
      return false;
    }
    const descendants = childSubtree(childThreads, childrenByParent);
    if (descendants.some(threadAsksForInput)) return false;
    if (threadShortStatus(thread)?.showsDuration === true || isThreadWorking(thread)) return true;
    return descendants.some(
      (child) =>
        OLD.childStatusKind(child) === "working" ||
        (child.indicator !== "unread-error" && child.queuedWork !== "failed" && isThreadWorking(child)),
    );
  },
  rowStatus(thread: PluginSidebarThread, rowStatus: PluginSidebarThreadRowStatus | null, limited: boolean) {
    if (
      !rowStatus ||
      limited ||
      thread.hasPendingInteraction ||
      thread.queuedWork === "failed" ||
      ["runtime", "unread-error", "waiting-for-input"].includes(thread.indicator)
    )
      return null;
    return rowStatus;
  },
  slot(
    listed: PluginSidebarThread,
    hasDraft: boolean,
    rowStatus: PluginSidebarThreadRowStatus | null,
    limited: boolean,
  ): string {
    const drafted = OLD.withDraft(listed);
    const folded = hasDraft ? { ...listed, indicator: drafted.indicator, indicatorLabel: drafted.label } : listed;
    return drawSlot(folded as PluginSidebarThread, OLD.rowStatus(listed, rowStatus, limited), limited);
  },
  withDraft(thread: PluginSidebarThread): { indicator: string; label: string | null } {
    if (OLD.isWorkingIndicator(thread.indicator))
      return { indicator: "working-draft", label: "Thread working with unsubmitted draft" };
    if (thread.indicator === "none") return { indicator: "draft", label: "Thread has unsubmitted draft" };
    return { indicator: thread.indicator, label: thread.indicatorLabel };
  },
};

/**
 * What the row's status slot draws, as StatusOrTime does: the provider-limit
 * warning, another plugin's status, the sidebar's short status (with the
 * glyph a compact row adds to a running one), bb's glyph for a kind this
 * build does not know, or the age.
 */
function drawSlot(
  folded: PluginSidebarThread,
  shownRowStatus: PluginSidebarThreadRowStatus | null,
  limited: boolean,
): string {
  if (limited && !folded.hasPendingInteraction && folded.indicator !== "runtime") return "provider limit";
  if (shownRowStatus) return `plugin status: ${shownRowStatus.label}`;
  const status = threadShortStatus(folded);
  if (status === null) return isKnownIndicator(folded.indicator) ? "age" : `bb's glyph: ${folded.indicatorLabel}`;
  return status.showsDuration ? `${status.label} [${folded.indicator} glyph]` : status.label;
}

function slot(
  listed: PluginSidebarThread,
  hasDraft: boolean,
  rowStatus: PluginSidebarThreadRowStatus | null,
  limited: boolean,
): string {
  return drawSlot(threadWithDraft(listed, hasDraft), threadRowStatus(listed, rowStatus, limited, hasDraft), limited);
}

/** The sidebar's own priorities, which sit above bb's indicator. */
const SIDEBAR_PRIORITIES = ["Needs you", "Send failed", "Queued", "provider limit"];

function slotReason(listed: PluginSidebarThread, hasDraft: boolean, before: string, after: string): string {
  if (SIDEBAR_PRIORITIES.some((words) => before.startsWith(words) || after.startsWith(words)))
    return "unexpected: one of the sidebar's own priorities changed";
  if (!hasDraft) return "unexpected";
  if (listed.indicator === "runtime" && after.startsWith("plugin status"))
    return "owner: bb shows another plugin's status over a working draft";
  if (
    (listed.indicator === "unread-success" || listed.indicator === "queued-failed") &&
    after.includes("working-draft")
  )
    return "owner: bb's working-draft over an unread result";
  return "unexpected";
}

const STATUSES = ["pending", "idle", "starting", "active", "stopping", "error"] as const;
const RUNTIME_STATUSES = [...STATUSES, "provisioning", "waiting-for-host"] as const;
/**
 * The pairs bb 0.49.0 emits: its server sets `runtimeStatus` to `status`,
 * or to "waiting-for-host" for an active thread whose host is disconnected.
 * The type allows the rest, so they are enumerated too, in their own group.
 */
const emitted = (status: string, runtimeStatus: string) =>
  runtimeStatus === status || (status === "active" && runtimeStatus === "waiting-for-host");

const ROW_STATUSES: Record<string, PluginSidebarThreadRowStatus | null> = {
  none: null,
  default: { icon: "Bell", label: "Plugin status" },
  running: { icon: "Loading", label: "Waiting for CI", tone: "running" },
  error: { icon: "Alert", label: "Plugin failed", tone: "error" },
  success: { icon: "Check", label: "Plugin done", tone: "success" },
};

function* threads(): Generator<PluginSidebarThread> {
  for (const status of STATUSES)
    for (const runtimeStatus of RUNTIME_STATUSES)
      for (let counts = 0; counts < 16; counts++)
        for (const hasPendingInteraction of [false, true])
          for (const isUnread of [false, true])
            for (const queuedWork of ["none", "waiting", "failed"] as const)
              for (const parentThreadId of [null, "parent"]) {
                const fields = {
                  ...idleSidebarThreadFields,
                  id: "thread",
                  status,
                  runtimeStatus,
                  queuedWork,
                  hasPendingInteraction,
                  isUnread,
                  parentThreadId,
                  activity: {
                    workflows: counts & 1,
                    backgroundAgents: (counts >> 1) & 1,
                    backgroundCommands: (counts >> 2) & 1,
                    planMode: (counts >> 3) & 1,
                  },
                } as PluginSidebarThread;
                // bb's host computes the listed indicator with this resolver.
                const { indicator, label } = resolveThreadStatus({
                  thread: fields,
                  hiddenThreads: [],
                  hasUnsubmittedDraft: false,
                  rowStatus: null,
                });
                yield { ...fields, indicator, indicatorLabel: label };
              }
}

const idleParent = {
  ...idleSidebarThreadFields,
  id: "parent",
  parentThreadId: null,
  hasPendingInteraction: false,
  isUnread: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
  indicator: "none",
  indicatorLabel: null,
} as PluginSidebarThread;

/** Why a difference is allowed, or "unexpected". */
function reason(thread: PluginSidebarThread, rowStatus: string, before: unknown, after: unknown): string {
  const counts = Object.values(thread.activity).some((count) => count > 0);
  if (rowStatus === "running" && (before === false || before === null) && (after === true || after === "working"))
    return "D2: another plugin's running status counts as working";
  if (
    before === true &&
    after === false &&
    !counts &&
    (thread.runtimeStatus === "pending" || thread.runtimeStatus === "waiting-for-host")
  )
    return `D2: runtimeStatus ${thread.runtimeStatus} no longer counts as working`;
  if (
    before === true &&
    after === false &&
    !counts &&
    !emitted(thread.status, thread.runtimeStatus) &&
    (thread.runtimeStatus === "idle" || thread.runtimeStatus === "error")
  )
    return `an in-flight status over runtimeStatus ${thread.runtimeStatus}, which bb never emits`;
  return "unexpected";
}

function differences() {
  const table = new Map<string, number>();
  const add = (pair: string, check: string, why: string, before: unknown, after: unknown) => {
    const key = `${pair} | ${check} | ${why} | ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
    table.set(key, (table.get(key) ?? 0) + 1);
  };
  for (const thread of threads()) {
    const pair = emitted(thread.status, thread.runtimeStatus) ? "emitted" : "never emitted";
    const level = thread.parentThreadId === null ? "top-level" : "child";
    for (const [rowName, rowStatus] of Object.entries(ROW_STATUSES)) {
      const rows = new Map(rowStatus ? [[thread.id, rowStatus]] : []);
      const working = (candidate: PluginSidebarThread) =>
        isThreadWorkingForDisplay(candidate, rows.get(candidate.id) ?? null);
      const compare = (check: string, before: unknown, after: unknown) => {
        if (JSON.stringify(before) !== JSON.stringify(after))
          add(pair, `${check} (${level})`, reason(thread, rowName, before, after), before, after);
      };
      compare(
        "display working",
        OLD.isWorkingTree(thread, [], new Map()),
        isWorkingTree(thread, [], new Map(), working),
      );
      if (thread.parentThreadId !== null) {
        compare(
          "idle parent of this child working",
          OLD.isWorkingTree(idleParent, [thread], new Map()),
          isWorkingTree(idleParent, [thread], new Map(), working),
        );
        compare("child status kind", OLD.childStatusKind(thread), childStatusKind(thread, working));
      }
    }
    // What the row's status slot shows (as StatusOrTime draws it), with and
    // without a draft. An indicator this build does not know cannot be built
    // here: in bb the resolver that set it is the one the sidebar calls, so
    // draft-status.test.ts covers that case instead.
    // The folded indicator and its label, which the hover card draws.
    const before = OLD.withDraft(thread);
    const drafted = threadWithDraft(thread, true);
    const after = { indicator: drafted.indicator, label: drafted.indicatorLabel };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const owner =
        (thread.indicator === "unread-success" || thread.indicator === "queued-failed") &&
        after.indicator === "working-draft";
      add(
        pair,
        `draft indicator (${level}, listed ${thread.indicator})`,
        owner ? "owner: bb's working-draft over an unread result or a failed send" : "unexpected",
        before.indicator,
        after.indicator,
      );
    }
    for (const hasDraft of [false, true])
      for (const rowStatus of Object.values(ROW_STATUSES))
        for (const limited of [false, true]) {
          const before = OLD.slot(thread, hasDraft, rowStatus, limited);
          const after = slot(thread, hasDraft, rowStatus, limited);
          if (before === after) continue;
          add(
            pair,
            `row (${level}, listed ${thread.indicator})`,
            slotReason(thread, hasDraft, before, after),
            before,
            after,
          );
        }
  }
  return Object.fromEntries([...table].sort());
}

describe("display status against the rules before bb's resolver", () => {
  it("differs only where the change means to", () => {
    // "pair": whether bb 0.49.0 emits the status and runtimeStatus pair.
    // "owner": cases where the sidebar now shows what bb's resolver does with
    // a draft: another plugin's status over a working draft, and
    // "working-draft" over an unread result on a thread with a background
    // agent or command. A failed send there still reads "Send failed".
    expect(differences()).toEqual({
      'emitted | child status kind (child) | D2: another plugin\'s running status counts as working | null -> "working"': 16,
      "emitted | display working (child) | D2: another plugin's running status counts as working | false -> true": 8,
      "emitted | display working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 16,
      "emitted | display working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 16,
      "emitted | display working (top-level) | D2: another plugin's running status counts as working | false -> true": 6,
      "emitted | display working (top-level) | D2: runtimeStatus pending no longer counts as working | true -> false": 16,
      "emitted | display working (top-level) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 16,
      'emitted | draft indicator (child, listed queued-failed) | owner: bb\'s working-draft over an unread result or a failed send | "queued-failed" -> "working-draft"': 24,
      'emitted | draft indicator (top-level, listed queued-failed) | owner: bb\'s working-draft over an unread result or a failed send | "queued-failed" -> "working-draft"': 21,
      'emitted | draft indicator (top-level, listed unread-success) | owner: bb\'s working-draft over an unread result or a failed send | "unread-success" -> "working-draft"': 6,
      "emitted | idle parent of this child working (child) | D2: another plugin's running status counts as working | false -> true": 8,
      "emitted | idle parent of this child working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 16,
      "emitted | idle parent of this child working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 16,
      'emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin done"': 96,
      'emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin failed"': 96,
      'emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin status"': 96,
      'emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Waiting for CI"': 96,
      'emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin done"': 96,
      'emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin failed"': 96,
      'emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin status"': 96,
      'emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Waiting for CI"': 96,
      'emitted | row (top-level, listed unread-success) | owner: bb\'s working-draft over an unread result | "Unread" -> "Drafting [working-draft glyph]"': 6,
      'never emitted | child status kind (child) | D2: another plugin\'s running status counts as working | null -> "working"': 80,
      "never emitted | display working (child) | D2: another plugin's running status counts as working | false -> true": 24,
      "never emitted | display working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 48,
      "never emitted | display working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 48,
      "never emitted | display working (child) | an in-flight status over runtimeStatus error, which bb never emits | true -> false": 64,
      "never emitted | display working (child) | an in-flight status over runtimeStatus idle, which bb never emits | true -> false": 64,
      "never emitted | display working (top-level) | D2: another plugin's running status counts as working | false -> true": 18,
      "never emitted | display working (top-level) | D2: runtimeStatus pending no longer counts as working | true -> false": 48,
      "never emitted | display working (top-level) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 48,
      "never emitted | display working (top-level) | an in-flight status over runtimeStatus error, which bb never emits | true -> false": 64,
      "never emitted | display working (top-level) | an in-flight status over runtimeStatus idle, which bb never emits | true -> false": 64,
      'never emitted | draft indicator (child, listed queued-failed) | owner: bb\'s working-draft over an unread result or a failed send | "queued-failed" -> "working-draft"': 120,
      'never emitted | draft indicator (top-level, listed queued-failed) | owner: bb\'s working-draft over an unread result or a failed send | "queued-failed" -> "working-draft"': 111,
      'never emitted | draft indicator (top-level, listed unread-success) | owner: bb\'s working-draft over an unread result or a failed send | "unread-success" -> "working-draft"': 18,
      "never emitted | idle parent of this child working (child) | D2: another plugin's running status counts as working | false -> true": 24,
      "never emitted | idle parent of this child working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 48,
      "never emitted | idle parent of this child working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 48,
      "never emitted | idle parent of this child working (child) | an in-flight status over runtimeStatus error, which bb never emits | true -> false": 64,
      "never emitted | idle parent of this child working (child) | an in-flight status over runtimeStatus idle, which bb never emits | true -> false": 64,
      'never emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin done"': 672,
      'never emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin failed"': 672,
      'never emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin status"': 672,
      'never emitted | row (child, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Waiting for CI"': 672,
      'never emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin done"': 608,
      'never emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin failed"': 608,
      'never emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Plugin status"': 608,
      'never emitted | row (top-level, listed runtime) | owner: bb shows another plugin\'s status over a working draft | "Drafting [working-draft glyph]" -> "plugin status: Waiting for CI"': 608,
      'never emitted | row (top-level, listed unread-success) | owner: bb\'s working-draft over an unread result | "Unread" -> "Drafting [working-draft glyph]"': 18,
    });
  });
});
