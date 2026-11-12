import { describe, expect, it } from "vitest";
import { withDraftIndicator } from "./StatusSlot";

describe("withDraftIndicator", () => {
  it("leaves the indicator alone without a draft", () => {
    expect(withDraftIndicator("none", false)).toBe("none");
    expect(withDraftIndicator("runtime", false)).toBe("runtime");
  });

  it("marks a quiet thread as a draft and a busy one as working with a draft", () => {
    expect(withDraftIndicator("none", true)).toBe("draft");
    for (const busy of ["runtime", "workflow", "background-agent", "background-command", "plan-mode"] as const) {
      expect(withDraftIndicator(busy, true)).toBe("working-draft");
    }
  });

  // bb's order: failures, raised hands, unread results and queued messages
  // all outrank an idle draft.
  it("keeps statuses that outrank a draft", () => {
    for (const kept of [
      "unread-error",
      "waiting-for-input",
      "unread-success",
      "queued-failed",
      "queued-waiting",
    ] as const) {
      expect(withDraftIndicator(kept, true)).toBe(kept);
    }
  });
});
