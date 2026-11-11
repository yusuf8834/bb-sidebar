import { normalizeProjectIconPath } from "./project-icons";

export const PROJECT_ICON_SEARCH_QUERIES = ["icon", "logo"] as const;

const PROJECT_MANIFEST_MAX_BYTES = 1_000_000;

const IGNORED_DIRECTORIES = ["node_modules", ".git", "dist", "build", "coverage"];

const DISCOVERABLE_NAME_RE =
  /^(?:favicon|icon|logo|apple-touch-icon)(?:[-_.](?:\d+(?:x\d+)?|dark|light|maskable|monochrome|precomposed))*\.(?:svg|png|webp|jpe?g|ico)$/i;

export function isDiscoverableProjectIcon(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  if (parts.slice(0, -1).some((part) => IGNORED_DIRECTORIES.includes(part))) return false;
  return DISCOVERABLE_NAME_RE.test(parts.at(-1) ?? "");
}

function projectIconScore(path: string): number {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  const depth = lower.split("/").length - 1;
  let score = 0;

  if (name.startsWith("favicon.")) score += 900;
  else if (name.startsWith("icon.")) score += 850;
  else if (name.startsWith("apple-touch-icon.")) score += 825;
  else if (name.startsWith("logo.")) score += 800;
  else if (name.includes("icon")) score += 650;
  else if (name.includes("logo")) score += 600;

  if (lower.startsWith("public/")) score += 120;
  else if (lower.startsWith("app/") || lower.startsWith("src/app/")) score += 100;
  else if (depth === 0) score += 90;

  if (lower.endsWith(".svg")) score += 60;
  else if (lower.endsWith(".png")) score += 50;
  else if (lower.endsWith(".webp")) score += 40;
  else if (lower.endsWith(".ico")) score += 30;

  if (/(dark|light|maskable|monochrome)/.test(name)) score -= 80;
  return score - depth * 5;
}

export function rankDiscoveredProjectIcons(paths: Iterable<string>): string[] {
  const candidates = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeProjectIconPath(path);
    if (normalized && isDiscoverableProjectIcon(normalized)) candidates.add(normalized);
  }
  return [...candidates].sort(
    (left, right) => projectIconScore(right) - projectIconScore(left) || left.localeCompare(right),
  );
}

export function manifestProjectIconPath(file: { content: string; contentEncoding: string; sizeBytes: number }) {
  if (file.contentEncoding !== "utf8" || file.sizeBytes > PROJECT_MANIFEST_MAX_BYTES) return null;
  let manifest: { bb?: { branding?: { icon?: unknown; logo?: { light?: unknown } } } } | null;
  try {
    manifest = JSON.parse(file.content);
  } catch {
    return null;
  }
  const branding = manifest?.bb?.branding;
  const icon = typeof branding?.icon === "string" ? normalizeProjectIconPath(branding.icon) : null;
  if (icon) return icon;
  return typeof branding?.logo?.light === "string" ? normalizeProjectIconPath(branding.logo.light) : null;
}
