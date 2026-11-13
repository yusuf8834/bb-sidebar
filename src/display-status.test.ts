import { describe, expect, it } from "vitest";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import { resolveThreadStatus } from "./bb-sdk";
import { childStatusKind, childSubtree, threadAsksForInput } from "./child-status";
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
  withDraft(thread: PluginSidebarThread): { indicator: string; label: string | null } {
    if (OLD.isWorkingIndicator(thread.indicator))
      return { indicator: "working-draft", label: "Thread working with unsubmitted draft" };
    if (thread.indicator === "none") return { indicator: "draft", label: "Thread has unsubmitted draft" };
    return { indicator: thread.indicator, label: thread.indicatorLabel };
  },
};

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
      for (const limited of [false, true])
        compare(
          `row status shown${limited ? ", provider limit" : ""}`,
          OLD.rowStatus(thread, rowStatus, limited)?.label ?? null,
          threadRowStatus(thread, rowStatus, limited)?.label ?? null,
        );
    }
    const drafted = threadWithDraft(thread, true);
    if (
      JSON.stringify(OLD.withDraft(thread)) !==
      JSON.stringify({ indicator: drafted.indicator, label: drafted.indicatorLabel })
    )
      add(pair, `draft indicator (${level})`, "unexpected", OLD.withDraft(thread), drafted.indicator);
    if (threadWithDraft(thread, false) !== thread) add(pair, "no draft", "unexpected", thread.indicator, null);
  }
  return Object.fromEntries([...table].sort());
}

describe("display status against the rules before bb's resolver", () => {
  it("differs only where the change means to", () => {
    // "pair": whether bb 0.49.0 emits the status and runtimeStatus pair.
    // A working thread with a draft and a plugin status keeps "Drafting",
    // and a draft keeps an unread result or a failed send on a thread with
    // background work: bb's resolver would show the plugin status and
    // "working-draft". Both stay as before (see StatusSlot), so neither is here.
    expect(differences()).toEqual({
      'emitted | child status kind (child) | D2: another plugin\'s running status counts as working | null -> "working"': 16,
      "emitted | display working (child) | D2: another plugin's running status counts as working | false -> true": 8,
      "emitted | display working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 16,
      "emitted | display working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 16,
      "emitted | display working (top-level) | D2: another plugin's running status counts as working | false -> true": 6,
      "emitted | display working (top-level) | D2: runtimeStatus pending no longer counts as working | true -> false": 16,
      "emitted | display working (top-level) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 16,
      "emitted | idle parent of this child working (child) | D2: another plugin's running status counts as working | false -> true": 8,
      "emitted | idle parent of this child working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 16,
      "emitted | idle parent of this child working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 16,
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
      "never emitted | idle parent of this child working (child) | D2: another plugin's running status counts as working | false -> true": 24,
      "never emitted | idle parent of this child working (child) | D2: runtimeStatus pending no longer counts as working | true -> false": 48,
      "never emitted | idle parent of this child working (child) | D2: runtimeStatus waiting-for-host no longer counts as working | true -> false": 48,
      "never emitted | idle parent of this child working (child) | an in-flight status over runtimeStatus error, which bb never emits | true -> false": 64,
      "never emitted | idle parent of this child working (child) | an in-flight status over runtimeStatus idle, which bb never emits | true -> false": 64,
    });
  });
});
