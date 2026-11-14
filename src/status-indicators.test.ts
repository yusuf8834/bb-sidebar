// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { isKnownIndicator, KNOWN_INDICATORS } from "./child-status";
import { StatusGlyph } from "./StatusGlyph";
import { statusToneClass } from "./StatusSlot";

installTestPluginRuntime();
afterEach(cleanup);

// Fails typecheck when the pinned SDK names an indicator the sidebar does not
// list, so a bump of the pin cannot drop a status unnoticed.
type Unlisted = Exclude<PluginSidebarThreadIndicator, (typeof KNOWN_INDICATORS)[number]>;
const everyIndicatorListed: [Unlisted] extends [never] ? true : Unlisted = true;

/** A kind bb could ship after this build. */
const futureKind = "future-kind" as PluginSidebarThreadIndicator;

const glyphFor = (indicator: PluginSidebarThreadIndicator, label: string | null = "Status") =>
  render(createElement(StatusGlyph, { indicator, label })).container;

describe("indicators", () => {
  it("lists every indicator the pinned SDK names", () => {
    expect(everyIndicatorListed).toBe(true);
    expect(new Set(KNOWN_INDICATORS).size).toBe(KNOWN_INDICATORS.length);
  });

  it.each(KNOWN_INDICATORS.filter((indicator) => indicator !== "none"))("draws a glyph for %s", (indicator) => {
    expect(glyphFor(indicator).firstElementChild).not.toBeNull();
  });

  it("draws nothing for none", () => {
    expect(glyphFor("none").firstElementChild).toBeNull();
  });

  it.each(["queued-failed", "queued-waiting"] as const)("draws bb's own glyph for %s", (indicator) => {
    const container = glyphFor(indicator, "A queued message");
    expect(container.querySelector(`[data-thread-status-glyph="${indicator}"]`)).not.toBeNull();
    expect(container.querySelector('[aria-label="A queued message"]')).not.toBeNull();
  });

  it("draws bb's glyph, held still, for a kind this build does not know", () => {
    const container = glyphFor(futureKind, "Thread is doing something new");
    expect(container.querySelector('[data-thread-status-glyph="future-kind"]')).not.toBeNull();
    expect(container.querySelector(".bb-sidebar-still")).not.toBeNull();
    expect(container.querySelector('[role="img"][aria-label="Thread is doing something new"]')).not.toBeNull();
  });

  it("knows the listed kinds and not a future one", () => {
    expect(KNOWN_INDICATORS.every(isKnownIndicator)).toBe(true);
    expect(isKnownIndicator(futureKind)).toBe(false);
  });

  it("tones a failed send as an error and a waiting one as a draft", () => {
    expect(statusToneClass("queued-failed")).toBe(statusToneClass("unread-error"));
    expect(statusToneClass("queued-waiting")).toBe(statusToneClass("draft"));
    expect(statusToneClass(futureKind)).toBe(statusToneClass("none"));
  });

  it("tones a background command apart from live agent work and from idle", () => {
    expect(statusToneClass("background-command")).toBe("text-[color:var(--bb-sidebar-tone-command)]");
    expect(statusToneClass("background-command")).not.toBe(statusToneClass("runtime"));
    expect(statusToneClass("background-command")).not.toBe(statusToneClass("none"));
    for (const kind of ["workflow", "background-agent", "plan-mode"] as const) {
      expect(statusToneClass(kind)).toBe(statusToneClass("runtime"));
    }
  });

  it("draws the background command glyph in the command tone", () => {
    const container = glyphFor("background-command", "Background command running");
    const glyph = container.querySelector('[aria-label="Background command running"]');
    expect(glyph?.closest('[class*="tone-command"]')).not.toBeNull();
    expect(container.querySelector('[class*="tone-working"]')).toBeNull();
  });
});
