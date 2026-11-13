import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { threadWithDraft } from "./StatusSlot";
import { idleSidebarThreadFields, runtimeStatusFor } from "./test-fixtures";

const counts = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 };

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    runtimeStatus: runtimeStatusFor(overrides),
    id: "thr_1",
    parentThreadId: null,
    hasPendingInteraction: false,
    isUnread: false,
    activity: counts,
    indicator: "none",
    indicatorLabel: null,
    ...overrides,
  } as PluginSidebarThread;
}
const busy: Record<string, Partial<PluginSidebarThread>> = {
  runtime: { indicator: "runtime" },
  workflow: { indicator: "workflow", activity: { ...counts, workflows: 1 } },
  "background-agent": { indicator: "background-agent", activity: { ...counts, backgroundAgents: 1 } },
  "background-command": { indicator: "background-command", activity: { ...counts, backgroundCommands: 1 } },
  "plan-mode": { indicator: "plan-mode", activity: { ...counts, planMode: 1 } },
};
// Each status with the fields bb derives it from.
const kept: Record<string, Partial<PluginSidebarThread>> = {
  "unread-error": { indicator: "unread-error", isUnread: true, status: "error" },
  "waiting-for-input": { indicator: "waiting-for-input", hasPendingInteraction: true },
  "unread-success": { indicator: "unread-success", isUnread: true },
  "queued-failed": { indicator: "queued-failed", queuedWork: "failed" },
  "queued-waiting": { indicator: "queued-waiting", queuedWork: "waiting" },
};

describe("threadWithDraft", () => {
  it("leaves the thread alone without a draft", () => {
    for (const fields of [{}, busy.runtime]) {
      const listed = thread(fields);
      expect(threadWithDraft(listed, false)).toBe(listed);
    }
  });

  it("marks a quiet thread as a draft and a busy one as working with a draft, in bb's words", () => {
    expect(threadWithDraft(thread(), true)).toMatchObject({
      indicator: "draft",
      indicatorLabel: "Thread has unsubmitted draft",
    });
    for (const fields of Object.values(busy)) {
      expect(threadWithDraft(thread(fields), true)).toMatchObject({
        indicator: "working-draft",
        indicatorLabel: "Thread working with unsubmitted draft",
      });
    }
  });

  // bb's order: failures, raised hands, unread results and queued messages
  // all outrank an idle draft.
  it("keeps statuses that outrank a draft", () => {
    for (const fields of Object.values(kept)) {
      const listed = thread(fields);
      expect(threadWithDraft(listed, true)).toBe(listed);
    }
  });

  it("takes bb's result for an indicator this build does not know", () => {
    const listed = thread({ indicator: "future-kind" as PluginSidebarThread["indicator"], indicatorLabel: "New" });
    expect(threadWithDraft(listed, true)).toMatchObject({
      indicator: "draft",
      indicatorLabel: "Thread has unsubmitted draft",
    });
  });

  // The sidebar words a waiting message itself, and only that wording can
  // stand for a kind it does not know.
  it("keeps an unknown indicator with a waiting message, so the row still reads Queued", () => {
    const listed = thread({
      indicator: "future-kind" as PluginSidebarThread["indicator"],
      indicatorLabel: "New",
      queuedWork: "waiting",
      runtimeStatus: "active",
    });
    expect(threadWithDraft(listed, true)).toBe(listed);
  });

  // bb's order puts a draft on a working thread above an unread result and a
  // failed send; the row still reads "Send failed" from `queuedWork`.
  it("shows working with a draft over an unread result or a failed send on a thread with background work", () => {
    for (const fields of [kept["unread-success"], kept["queued-failed"]]) {
      const listed = thread({ ...fields, activity: { ...counts, backgroundAgents: 1 } });
      expect(threadWithDraft(listed, true)).toMatchObject({ indicator: "working-draft" });
    }
  });
});
