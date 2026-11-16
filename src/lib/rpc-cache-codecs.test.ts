import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_SETTINGS } from "../sidebar-settings-values";
import { decodeInboxOrder } from "./inbox-order-codec";
import { decodeLifecycleRows } from "./lifecycle-cache-codec";
import { decodeSettingsCache } from "./settings-cache-codec";

const oldSettings = {
  snoozePresets: "1h",
  inactiveThreadsEnabled: false,
  inactiveAfterHours: 12,
  showRunningChildrenWhenCollapsed: false,
  autoSettleInactive: false,
  autoSettleAfterDays: 7,
  autoSettleOnMerge: false,
};
const row = {
  threadId: "a",
  parkedAt: 10,
  settledAt: null,
  settledOverride: "active" as const,
  snoozedUntil: null,
  snoozedAt: null,
};

describe("settings cache codec", () => {
  it("round trips the current settings and drops unknown keys", () => {
    expect(decodeSettingsCache(DEFAULT_SIDEBAR_SETTINGS)).toEqual(DEFAULT_SIDEBAR_SETTINGS);
    expect(decodeSettingsCache({ ...DEFAULT_SIDEBAR_SETTINGS, archivedShelfEnabled: true })).toEqual(
      DEFAULT_SIDEBAR_SETTINGS,
    );
  });
  it("fills newer settings in the older accepted shape", () => {
    expect(decodeSettingsCache(oldSettings)).toEqual({ ...DEFAULT_SIDEBAR_SETTINGS, ...oldSettings });
  });
  it("rejects missing and wrongly typed required fields", () => {
    for (const input of [null, undefined, {}, [], "settings"]) expect(decodeSettingsCache(input)).toBeNull();
    for (const key of Object.keys(oldSettings)) {
      expect(decodeSettingsCache({ ...oldSettings, [key]: null })).toBeNull();
      expect(decodeSettingsCache({ ...oldSettings, [key]: undefined })).toBeNull();
    }
  });
  it("retains permissive numeric checks and optional-setting fallbacks", () => {
    // The old reader accepted numbers without range or finite checks.
    expect(decodeSettingsCache({ ...oldSettings, inactiveAfterHours: -1, autoSettleAfterDays: Infinity })).toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...oldSettings,
      inactiveAfterHours: -1,
      autoSettleAfterDays: Infinity,
    });
    expect(
      decodeSettingsCache({
        ...oldSettings,
        childSortField: "unknown",
        childIconStyle: 42,
        compactWorkingThreads: "true",
        compactProjectIconOnly: "true",
        workingShelf: 1,
        projectColorDisplay: "unknown",
      }),
    ).toEqual({ ...DEFAULT_SIDEBAR_SETTINGS, ...oldSettings });
  });
  it("keeps side chats as children on for a cache saved before the switch", () => {
    expect(decodeSettingsCache(oldSettings)?.showSideChatsAsChildren).toBe(true);
    expect(decodeSettingsCache({ ...oldSettings, showSideChatsAsChildren: "false" })?.showSideChatsAsChildren).toBe(
      true,
    );
    expect(decodeSettingsCache({ ...oldSettings, showSideChatsAsChildren: false })?.showSideChatsAsChildren).toBe(
      false,
    );
  });
  it("retains the icon-only project preference", () => {
    expect(decodeSettingsCache({ ...oldSettings, compactProjectIconOnly: true })).toEqual({
      ...DEFAULT_SIDEBAR_SETTINGS,
      ...oldSettings,
      compactProjectIconOnly: true,
    });
  });
});

describe("settings cache thread display", () => {
  it("derives thread display from a cache saved before it existed", () => {
    expect(decodeSettingsCache({ ...oldSettings, compactWorkingThreads: true })).toMatchObject({
      threadDisplay: "compact-working",
      compactWorkingThreads: true,
    });
    expect(decodeSettingsCache({ ...oldSettings, threadDisplay: "full", compactWorkingThreads: true })).toMatchObject({
      threadDisplay: "full",
      compactWorkingThreads: false,
    });
  });
});

describe("lifecycle cache codec", () => {
  it("round trips valid rows and drops unknown fields", () => {
    expect(decodeLifecycleRows([row])).toEqual(new Map([["a", row]]));
    expect(decodeLifecycleRows([{ ...row, unknown: true }])).toEqual(new Map([["a", row]]));
    expect(decodeLifecycleRows([])).toEqual(new Map());
  });
  it("fills the optional fields absent in older rows", () => {
    expect(decodeLifecycleRows([{ threadId: "a", settledAt: null, snoozedUntil: null, snoozedAt: null }])).toEqual(
      new Map([["a", { ...row, parkedAt: null, settledOverride: null }]]),
    );
  });
  it("rejects missing required fields and wrong types", () => {
    for (const input of [null, undefined, {}, "rows", [null]]) expect(decodeLifecycleRows(input)).toBeNull();
    for (const key of ["threadId", "settledAt", "snoozedUntil", "snoozedAt"]) {
      expect(decodeLifecycleRows([{ ...row, [key]: undefined }])).toBeNull();
    }
    for (const key of ["parkedAt", "settledAt", "snoozedUntil", "snoozedAt"]) {
      for (const value of ["1", Infinity, NaN]) expect(decodeLifecycleRows([{ ...row, [key]: value }])).toBeNull();
    }
    expect(decodeLifecycleRows([{ ...row, settledOverride: "parked" }])).toBeNull();
  });
  it("uses the last duplicate row and keeps the 500 most recent rows", () => {
    expect(decodeLifecycleRows([row, { ...row, parkedAt: 20 }])?.get("a")?.parkedAt).toBe(20);
    const rows = Array.from({ length: 501 }, (_, i) => ({ ...row, threadId: String(i), parkedAt: i }));
    const decoded = decodeLifecycleRows(rows)!;
    expect(decoded.size).toBe(500);
    expect(decoded.has("0")).toBe(false);
    expect(decoded.has("500")).toBe(true);
  });
});

describe("inbox order codec", () => {
  it("accepts current and older arrays, deduplicating in insertion order", () => {
    expect(decodeInboxOrder(["b", "a"])).toEqual(["b", "a"]);
    expect(decodeInboxOrder(["b", "a", "b", ""])).toEqual(["b", "a", ""]);
    expect(decodeInboxOrder([])).toEqual([]);
  });
  it("rejects missing or wrong types without guessing IDs", () => {
    for (const input of [null, undefined, {}, "a", ["a", 1], [null]]) expect(decodeInboxOrder(input)).toBeNull();
  });
  it("drops non-index properties on arrays", () => {
    expect(decodeInboxOrder(Object.assign(["a"], { unknown: true }))).toEqual(["a"]);
  });
});
