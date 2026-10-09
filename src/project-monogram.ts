/** Tile colours in src/theme.css: `.bb-sidebar-monogram-0` through `-7`. */
export const MONOGRAM_COLOR_COUNT = 8;

/**
 * Leading words that many project names share. Skipped while another word
 * follows, so `bb-sidebar` and `bb-plugin-tasks` read as S and T rather than
 * a column of identical Bs.
 */
const GENERIC_WORDS = new Set(["bb", "plugin", "the", "my"]);

function words(name: string): string[] {
  // An npm scope or a path prefix says where the project lives, not what it is.
  const base = name.trim().replace(/^@[^/]+\//u, "").split("/").at(-1) ?? "";
  return base
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The one letter that stands for a project without an icon. */
export function projectMonogramLetter(name: string): string {
  const all = words(name);
  const first =
    all.find((word, index) => index === all.length - 1 || !GENERIC_WORDS.has(word.toLowerCase())) ??
    "";
  return first ? [...first][0]!.toLocaleUpperCase() : "#";
}

/**
 * A stable tile colour for a project, from its name: the same project gets
 * the same colour on every machine and after every reload.
 */
export function projectMonogramColor(name: string): number {
  // FNV-1a: tiny, and spreads similar names across the palette.
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLocaleLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MONOGRAM_COLOR_COUNT;
}

/** The accent hue class for a project; pair it with `bb-sidebar-project-stripe` or `-name`. */
export function projectColorClass(name: string): string {
  return `bb-sidebar-project-${projectMonogramColor(name)}`;
}
