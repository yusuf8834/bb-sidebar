import { describe, expect, it } from "vitest";
import { automaticProjectColor, projectColorsById, projectColorStyle } from "./project-colors";

describe("project colors", () => {
  it("assigns distinct automatic colors beyond the former eight-color palette", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `project-${index}`);
    const colors = projectColorsById(ids, {});
    expect(new Set(colors.values()).size).toBe(ids.length);
    expect(projectColorsById([...ids].reverse(), {})).toEqual(colors);
    for (const id of ids) expect(colors.get(id)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps custom choices and avoids assigning them to another project automatically", () => {
    const color = automaticProjectColor("automatic");
    const colors = projectColorsById(["automatic", "custom"], { custom: color });
    expect(colors.get("custom")).toBe(color);
    expect(colors.get("automatic")).not.toBe(color);
    expect(projectColorsById(["custom"], {}).get("custom")).toBe(automaticProjectColor("custom"));
  });

  it("preserves the exact stripe color and adapts extreme colors for readable labels", () => {
    const white = projectColorStyle("#ffffff") as Record<string, string>;
    const black = projectColorStyle("#000000") as Record<string, string>;
    expect(white["--bb-sidebar-project"]).toBe("#ffffff");
    expect(white["--bb-sidebar-project-text-light"]).not.toBe("#ffffff");
    expect(black["--bb-sidebar-project"]).toBe("#000000");
    expect(black["--bb-sidebar-project-text-dark"]).not.toBe("#000000");
  });
});
