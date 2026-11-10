import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No endless animation on anything that stays on screen.
 *
 * In Chromium any running animation redraws the window at the display's
 * refresh rate, whatever its size. While a thread worked, the sidebar's
 * spinning and shining glyphs kept bb's renderer, GPU process and WindowServer
 * near a full core on a 120 Hz Mac; slower or stepped motion still cost a
 * third of that (see StatusGlyph and get-bb/bb#7233). So a looping utility or
 * an `infinite` keyframe may only sit on a spinner for an operation that ends
 * in seconds, or on a hover, and each one is listed below with its reason.
 * Anything new fails here until it is either made finite or listed.
 */

const ROOT = join(import.meta.dirname, "..");

/** Every shipped source file: src/**, minus tests, plus the app entry. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) continue;
    if (/\.(tsx?|css)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const SOURCES = [join(ROOT, "app.tsx"), ...sourceFiles(join(ROOT, "src"))];

/** Tailwind's looping utilities, bb's shine, and CSS `infinite`. */
const LOOPING = /\banimate-(?:spin|pulse|ping|bounce|shine[\w-]*)\b|\binfinite\b/g;

/** Uses that end on their own, with the count expected in each file. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "src/ThreadTitle.tsx": { count: 1, reason: "spinner while a title is generated" },
  "src/ThreadInboxEmptyStates.tsx": { count: 1, reason: '"Loading threads…" while the list first loads' },
  "src/settings-ui.tsx": { count: 1, reason: "spinner while a setting saves" },
  "src/RateLimitRecovery.tsx": { count: 1, reason: "spinner while a retry is in flight" },
  "src/OpenPorts.tsx": { count: 1, reason: "spinner while a port stops" },
  "src/settle-button.css": { count: 1, reason: "star shimmer only while the settle button is hovered or focused" },
};

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

describe("motion", () => {
  it("has no endless animation outside the listed short-lived spinners", () => {
    const found: Record<string, number> = {};
    for (const path of SOURCES) {
      const count = withoutComments(readFileSync(path, "utf8")).match(LOOPING)?.length ?? 0;
      if (count > 0) found[path.slice(ROOT.length + 1)] = count;
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([path, { count }]) => [path, count]));
    expect(found).toEqual(expected);
  });
});
