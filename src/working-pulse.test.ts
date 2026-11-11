// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type AnimationEvent } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusGlyph, syncWorkingPulse } from "./StatusGlyph";

afterEach(cleanup);

describe("working pulse", () => {
  it("pulses an HTML wrapper around the working glyph, never the SVG itself", () => {
    const { container } = render(createElement(StatusGlyph, { indicator: "runtime", label: "Working" }));
    const wrapper = container.querySelector(".bb-sidebar-working-pulse");
    expect(wrapper?.tagName).toBe("SPAN");
    expect(wrapper?.querySelector('svg[data-icon="Working"]')).not.toBeNull();
    expect(container.querySelector("svg.bb-sidebar-working-pulse")).toBeNull();
  });

  it("leaves the other glyphs without a pulse", () => {
    const { container } = render(createElement(StatusGlyph, { indicator: "workflow", label: "Workflow" }));
    expect(container.querySelector(".bb-sidebar-working-pulse")).toBeNull();
  });

  it("pins every pulse to the start of the timeline so working rows change together", () => {
    const pulse = { animationName: "bb-sidebar-working-pulse", startTime: 1234 as number | null };
    const other = { animationName: "something-else", startTime: 99 as number | null };
    const target = { getAnimations: () => [pulse, other] } as unknown as HTMLElement;
    syncWorkingPulse({
      animationName: "bb-sidebar-working-pulse",
      currentTarget: target,
    } as AnimationEvent<HTMLElement>);
    expect(pulse.startTime).toBe(0);
    expect(other.startTime).toBe(99);
  });

  it("ignores other animations starting on the wrapper", () => {
    const pulse = { animationName: "bb-sidebar-working-pulse", startTime: 1234 as number | null };
    const target = { getAnimations: () => [pulse] } as unknown as HTMLElement;
    syncWorkingPulse({ animationName: "fade-in", currentTarget: target } as AnimationEvent<HTMLElement>);
    expect(pulse.startTime).toBe(1234);
  });
});
