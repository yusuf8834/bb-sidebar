import { describe, expect, it } from "vitest";
import {
  autoSettleNeedsPullRequest,
  decideAutoSettle,
  decideAutoSettledThread,
  isAutoSettled,
  parseAutoSettleAfterDays,
  type AutoSettleLifecycleState,
  type AutoSettleThread,
} from "./auto-settle";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 10 * DAY;

function lifecycle(overrides: Partial<AutoSettleLifecycleState> = {}): AutoSettleLifecycleState {
  return {
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    ...overrides,
  };
}

const idleActivity = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
};

const quietThread: AutoSettleThread = {
  activity: idleActivity,
  createdAt: DAY,
  hasPendingInteraction: false,
  latestAttentionAt: 6 * DAY,
  pinnedAt: null,
  queuedWork: "none",
  status: "idle",
  updatedAt: 6 * DAY,
};

const settings = { afterDays: 3, onMerge: true };

describe("automatic settle policy", () => {
  it("looks up pull requests only for threads the policy can change", () => {
    expect(autoSettleNeedsPullRequest(null, quietThread)).toBe(true);
    expect(
      autoSettleNeedsPullRequest(null, {
        ...quietThread,
        status: "active",
      }),
    ).toBe(false);
    expect(autoSettleNeedsPullRequest(null, { ...quietThread, pinnedAt: NOW })).toBe(false);
    expect(autoSettleNeedsPullRequest(lifecycle({ settledOverride: "active" }), quietThread)).toBe(false);
    expect(autoSettleNeedsPullRequest(lifecycle({ snoozedUntil: NOW + DAY }), quietThread)).toBe(false);
  });

  it("tells a policy settle from the user's", () => {
    expect(isAutoSettled(null)).toBe(false);
    expect(isAutoSettled(lifecycle({ settledAt: NOW }))).toBe(true);
    expect(isAutoSettled(lifecycle({ settledAt: NOW, settledOverride: "settled" }))).toBe(false);
    expect(isAutoSettled(lifecycle({ snoozedUntil: NOW + DAY }))).toBe(false);
  });

  it("returns a policy-settled thread without a PR only when it is out of policy reach", () => {
    const settled = lifecycle({ settledAt: NOW });
    expect(decideAutoSettledThread(settled, quietThread)).toBe("keep");
    // Newer activity alone does not reopen it; bb's activity event does.
    expect(decideAutoSettledThread(settled, { ...quietThread, updatedAt: NOW })).toBe("keep");
    expect(decideAutoSettledThread(settled, { ...quietThread, pinnedAt: NOW })).toBe("unsettle");
    expect(decideAutoSettledThread(settled, { ...quietThread, status: "active" })).toBe("unsettle");
    expect(decideAutoSettledThread(settled, { ...quietThread, hasPendingInteraction: true })).toBe("unsettle");
    expect(decideAutoSettledThread(settled, { ...quietThread, queuedWork: "waiting" })).toBe("unsettle");
    expect(decideAutoSettledThread(lifecycle({ settledAt: NOW, parkedAt: NOW }), quietThread)).toBe("unsettle");
    expect(decideAutoSettledThread(lifecycle({ settledAt: NOW, snoozedUntil: NOW + DAY }), quietThread)).toBe(
      "unsettle",
    );
  });

  it("keeps a pending thread available", () => {
    expect(
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: { outcome: "absent" },
        settings,
        thread: { ...quietThread, status: "pending" },
      }),
    ).toBe("keep");
  });

  it.each<[string, Partial<AutoSettleThread>]>([
    ["a pending interaction", { hasPendingInteraction: true }],
    ["queued messages", { queuedWork: "waiting" }],
    ["a failed queued message", { queuedWork: "failed" }],
    ["a workflow", { activity: { ...idleActivity, activeWorkflowCount: 1 } }],
    ["a background agent", { activity: { ...idleActivity, activeBackgroundAgentCount: 1 } }],
    ["a background command", { activity: { ...idleActivity, activeBackgroundCommandCount: 1 } }],
    ["plan mode", { activity: { ...idleActivity, activePlanModeCount: 1 } }],
    ["a goal", { activity: { ...idleActivity, activeGoalCount: 1 } }],
  ])("never settles an idle thread with %s, and returns one it settled", (_, overrides) => {
    const thread = { ...quietThread, ...overrides };
    const merged = {
      outcome: "available" as const,
      state: "merged" as const,
      updatedAt: new Date(NOW).toISOString(),
    };

    expect(autoSettleNeedsPullRequest(null, thread)).toBe(false);
    for (const pullRequest of [{ outcome: "absent" as const }, merged]) {
      expect(decideAutoSettle({ lifecycle: null, now: NOW, pullRequest, settings, thread })).toBe("keep");
    }
    expect(
      decideAutoSettle({
        lifecycle: lifecycle({ settledAt: NOW - DAY }),
        now: NOW,
        pullRequest: { outcome: "absent" },
        settings,
        thread,
      }),
    ).toBe("unsettle");
  });

  it("accepts only configured inactivity thresholds from 1 through 90", () => {
    expect(parseAutoSettleAfterDays(true, "3")).toBe(3);
    expect(parseAutoSettleAfterDays(false, "3")).toBeNull();
    expect(parseAutoSettleAfterDays(true, "0")).toBeNull();
    expect(parseAutoSettleAfterDays(true, "3.5")).toBeNull();
    expect(parseAutoSettleAfterDays(true, "91")).toBeNull();
  });

  it("settles an inactive thread and reverses it after fresh activity", () => {
    expect(
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: { outcome: "absent" },
        settings,
        thread: quietThread,
      }),
    ).toBe("settle");
    expect(
      decideAutoSettle({
        lifecycle: lifecycle({ settledAt: NOW - DAY }),
        now: NOW,
        pullRequest: { outcome: "absent" },
        settings,
        thread: { ...quietThread, updatedAt: NOW },
      }),
    ).toBe("unsettle");
  });

  it("keeps open and draft pull requests active", () => {
    for (const state of ["open", "draft"] as const) {
      expect(
        decideAutoSettle({
          lifecycle: null,
          now: NOW,
          pullRequest: {
            outcome: "available",
            state,
            updatedAt: new Date(NOW).toISOString(),
          },
          settings,
          thread: quietThread,
        }),
      ).toBe("keep");
    }
  });

  it.each(["merged", "closed"] as const)("settles a %s PR only when finished PRs are enabled", (state) => {
    const updatedAt = new Date(NOW).toISOString();
    const decide = (onMerge: boolean) =>
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: { outcome: "available", state, updatedAt },
        settings: { afterDays: null, onMerge },
        thread: quietThread,
      });
    expect(decide(true)).toBe("settle");
    expect(decide(false)).toBe("keep");
  });

  it("does not re-settle when activity postdates the terminal PR", () => {
    expect(
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: {
          outcome: "available",
          state: "merged",
          updatedAt: new Date(7 * DAY).toISOString(),
        },
        settings: { afterDays: null, onMerge: true },
        thread: { ...quietThread, updatedAt: 8 * DAY },
      }),
    ).toBe("keep");
  });

  it("keeps the current state when a terminal PR timestamp is malformed", () => {
    expect(
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: {
          outcome: "available",
          state: "closed",
          updatedAt: "not-a-timestamp",
        },
        settings: { afterDays: 1, onMerge: true },
        thread: quietThread,
      }),
    ).toBe("keep");
    expect(
      decideAutoSettle({
        lifecycle: lifecycle({ settledAt: NOW - DAY }),
        now: NOW,
        pullRequest: {
          outcome: "available",
          state: "closed",
          updatedAt: "not-a-timestamp",
        },
        settings: { afterDays: 1, onMerge: true },
        thread: quietThread,
      }),
    ).toBe("keep");
  });

  it("never changes explicit overrides, pinned rows, or unknown PR state", () => {
    expect(
      decideAutoSettle({
        lifecycle: lifecycle({ settledOverride: "active" }),
        now: NOW,
        pullRequest: { outcome: "absent" },
        settings,
        thread: quietThread,
      }),
    ).toBe("keep");
    expect(
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: { outcome: "absent" },
        settings,
        thread: { ...quietThread, pinnedAt: NOW },
      }),
    ).toBe("keep");
    expect(
      decideAutoSettle({
        lifecycle: null,
        now: NOW,
        pullRequest: { outcome: "unknown" },
        settings,
        thread: quietThread,
      }),
    ).toBe("keep");
  });
});

it("never automatically settles parked work or requests its PR", () => {
  const parked = lifecycle({ parkedAt: DAY });
  expect(autoSettleNeedsPullRequest(parked, quietThread)).toBe(false);
  for (const pullRequest of [
    { outcome: "absent" as const },
    { outcome: "available" as const, state: "merged" as const, updatedAt: new Date(NOW).toISOString() },
  ]) {
    expect(decideAutoSettle({ lifecycle: parked, now: NOW, pullRequest, settings, thread: quietThread })).toBe("keep");
  }
});
