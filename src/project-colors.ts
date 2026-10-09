import type { CSSProperties } from "react";

export const PROJECT_COLORS_CHANNEL = "project-colors";

function hashId(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** A stable color from the project's identity, without a fixed palette. */
export function automaticProjectColor(projectId: string, attempt = 0): string {
  const hash = hashId(projectId);
  return hslToHex(
    ((hash / 2 ** 32) * 360 + attempt * 137.507764) % 360,
    0.48 + ((hash >>> 8) % 20) / 100,
    0.46 + (hash % 14) / 100,
  );
}

export function projectColorsById(
  projectIds: readonly string[],
  overrides: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const used = new Set(Object.values(overrides).map((color) => color.toLowerCase()));
  const colors = new Map<string, string>();
  for (const id of [...new Set(projectIds)].sort()) {
    if (overrides[id]) {
      colors.set(id, overrides[id]!);
      continue;
    }
    let attempt = 0;
    let color = automaticProjectColor(id);
    while (used.has(color)) color = automaticProjectColor(id, ++attempt);
    used.add(color);
    colors.set(id, color);
  }
  return colors;
}

function luminance(rgb: readonly number[]): number {
  const linear = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

/** Preserve the chosen hue while making project labels readable in both themes. */
function textColor(color: string, darkTheme: boolean): string {
  const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const background = darkTheme ? luminance([32, 32, 32]) : luminance([245, 245, 245]);
  for (let step = 0; step <= 20; step++) {
    const adjusted = rgb.map((value) => Math.round(value + ((darkTheme ? 255 : 0) - value) * step / 20));
    const l = luminance(adjusted);
    if ((Math.max(l, background) + 0.05) / (Math.min(l, background) + 0.05) >= 4.5) {
      return `#${adjusted.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return darkTheme ? "#ffffff" : "#000000";
}

export function projectColorStyle(color: string): CSSProperties {
  return {
    "--bb-sidebar-project": color,
    "--bb-sidebar-project-text-light": textColor(color, false),
    "--bb-sidebar-project-text-dark": textColor(color, true),
  } as CSSProperties;
}
