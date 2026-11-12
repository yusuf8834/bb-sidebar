// Sets the bb pins in package.json and guards the result.
//
// The edit is textual and touches only values inside the top-level
// "devDependencies" object, so formatting elsewhere stays byte-for-byte
// (`bb plugin types` itself would reformat the file).
//
//   node scripts/bb-compat/pins.mjs set --resolved resolved.json
//   node scripts/bb-compat/pins.mjs guard --base-ref HEAD --resolved resolved.json
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertPackageName, assertPinRange, assertSemver, parseArgs, runOk } from "./lib.mjs";

const SDK = "@get-bb/plugin-sdk";
const ALLOWED_FILES = ["package.json", "package-lock.json"];
const REGISTRY = "https://registry.npmjs.org/";

/** [start, end) of the value of a top-level key in JSON text, or null. */
export function topLevelValueSpan(text, key) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      if (depth === 1) {
        const name = JSON.parse(text.slice(i, end));
        let j = end;
        while (/\s/.test(text[j])) j++;
        if (text[j] === ":" && name === key) {
          j++;
          while (/\s/.test(text[j])) j++;
          return [j, valueEnd(text, j)];
        }
      }
      i = end;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    i++;
  }
  return null;
}

function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  throw new Error("Unterminated string in JSON");
}

function valueEnd(text, start) {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== "{" && text[start] !== "[") {
    const match = /^[^,}\]\s]+/.exec(text.slice(start));
    return start + match[0].length;
  }
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text[i] === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (text[i] === "{" || text[i] === "[") depth++;
    else if (text[i] === "}" || text[i] === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error("Unterminated JSON value");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The pins a resolved bb asks for: bb-app, the SDK, and runtime shims. */
export function pinsFromResolved(resolved) {
  const pins = { "bb-app": assertSemver(resolved.bbApp, "bb-app"), [SDK]: assertSemver(resolved.sdk, "SDK") };
  for (const [name, range] of Object.entries(resolved.shimPins ?? {})) {
    pins[assertPackageName(name)] = assertPinRange(range, name);
  }
  return pins;
}

/** Rewrites existing devDependencies values; never adds or removes a key. */
export function setDevDependencyPins(text, pins) {
  const span = topLevelValueSpan(text, "devDependencies");
  if (!span) throw new Error("package.json has no devDependencies");
  let block = text.slice(span[0], span[1]);
  for (const [name, value] of Object.entries(pins)) {
    const pattern = new RegExp(`(\\n\\s*"${escapeRegExp(name)}"\\s*:\\s*)"[^"\\n]*"`, "g");
    const matches = block.match(pattern) ?? [];
    if (matches.length !== 1) throw new Error(`devDependencies must contain "${name}" exactly once`);
    block = block.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
  }
  return text.slice(0, span[0]) + block + text.slice(span[1]);
}

/**
 * Problems with a package.json edit. Outside devDependencies the text must be
 * byte-for-byte identical; inside, keys and their order must not change, only
 * `allowed` keys may change, and each new value must be a plain version range.
 */
export function guardPackageJson(beforeText, afterText, allowed) {
  const problems = [];
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch (error) {
    return [`package.json does not parse: ${error.message}`];
  }
  const beforeSpan = topLevelValueSpan(beforeText, "devDependencies");
  const afterSpan = topLevelValueSpan(afterText, "devDependencies");
  if (!beforeSpan || !afterSpan) return ["devDependencies is missing"];
  const outside = (text, span) => text.slice(0, span[0]) + text.slice(span[1]);
  if (outside(beforeText, beforeSpan) !== outside(afterText, afterSpan)) {
    const changedKeys = Object.keys({ ...before, ...after }).filter(
      (key) => key !== "devDependencies" && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    problems.push(
      `package.json changed outside devDependencies${changedKeys.length ? `: ${changedKeys.join(", ")}` : " (formatting or key order)"}`,
    );
  }
  const was = before.devDependencies ?? {};
  const now = after.devDependencies ?? {};
  if (JSON.stringify(Object.keys(was)) !== JSON.stringify(Object.keys(now))) {
    problems.push("devDependencies keys were added, removed or reordered");
  }
  for (const [name, value] of Object.entries(now)) {
    if (was[name] === value) continue;
    if (!allowed.includes(name)) problems.push(`devDependencies.${name} changed but bb did not ask for it`);
    try {
      assertPinRange(value, `devDependencies.${name}`);
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}

/** Problems in `git status --porcelain=v1 -z --untracked-files=all` output. */
export function guardChangedFiles(statusZ) {
  const problems = [];
  const entries = statusZ.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (status.includes("R") || status.includes("C")) {
      problems.push(`renamed or copied: ${entries[i + 1]} -> ${path}`);
      i++;
      continue;
    }
    if (!ALLOWED_FILES.includes(path)) problems.push(`changed file not allowed: ${path} (${status.trim()})`);
    else if (status.includes("D")) problems.push(`deleted: ${path}`);
  }
  return problems;
}

/**
 * Problems with the regenerated lockfile: its root must match package.json,
 * nothing else at the root may change, and every package must come from the
 * npm registry with an integrity hash.
 */
export function guardLockfile(beforeText, afterText, packageJsonText) {
  const problems = [];
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch (error) {
    return [`package-lock.json does not parse: ${error.message}`];
  }
  const manifest = JSON.parse(packageJsonText);
  if (after.lockfileVersion !== before.lockfileVersion) problems.push("lockfileVersion changed");
  for (const key of ["name", "version"]) {
    if (after[key] !== before[key]) problems.push(`package-lock.json ${key} changed`);
  }
  const wasRoot = before.packages?.[""] ?? {};
  const root = after.packages?.[""] ?? {};
  const rootKeys = new Set([...Object.keys(wasRoot), ...Object.keys(root)]);
  for (const key of rootKeys) {
    if (key === "devDependencies") continue;
    if (JSON.stringify(wasRoot[key]) !== JSON.stringify(root[key])) problems.push(`lockfile root ${key} changed`);
  }
  if (JSON.stringify(root.devDependencies) !== JSON.stringify(manifest.devDependencies)) {
    problems.push("lockfile root devDependencies do not match package.json");
  }
  for (const [path, entry] of Object.entries(after.packages ?? {})) {
    // Bundled dependencies ship inside their parent's tarball, which is checked.
    if (path === "" || entry.link || entry.inBundle) continue;
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) {
      problems.push(`${path} does not resolve from ${REGISTRY}`);
    } else if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      problems.push(`${path} has no sha512 integrity`);
    }
  }
  return problems;
}

/** Runs every guard against a git base. Returns the list of problems. */
export async function guardWorkingTree({ baseRef, allowed, cwd = process.cwd() }) {
  if (!/^[\w./-]+$/.test(baseRef)) throw new Error(`Unexpected base ref ${JSON.stringify(baseRef)}`);
  const show = async (file) => (await runOk("git", ["show", `${baseRef}:${file}`], { cwd })).stdout;
  const status = await runOk("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  const packageJson = readFileSync(`${cwd}/package.json`, "utf8");
  return [
    ...guardChangedFiles(status.stdout),
    ...guardPackageJson(await show("package.json"), packageJson, allowed),
    ...guardLockfile(await show("package-lock.json"), readFileSync(`${cwd}/package-lock.json`, "utf8"), packageJson),
  ];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const resolved = JSON.parse(readFileSync(args.resolved, "utf8"));
  const pins = pinsFromResolved(resolved);
  if (command === "set") {
    const text = readFileSync("package.json", "utf8");
    writeFileSync("package.json", setDevDependencyPins(text, pins));
    console.log(
      `Set ${Object.entries(pins)
        .map(([name, value]) => `${name}@${value}`)
        .join(", ")}`,
    );
    return;
  }
  if (command === "guard") {
    const problems = await guardWorkingTree({ baseRef: args["base-ref"] ?? "HEAD", allowed: Object.keys(pins) });
    if (problems.length) {
      const shown = problems.slice(0, 30).map((problem) => `- ${problem}`);
      if (problems.length > 30) shown.push(`- and ${problems.length - 30} more`);
      console.error(`Pin guard FAILED:\n${shown.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log("Pin guard passed: only devDependencies pins in package.json and package-lock.json changed.");
    }
    return;
  }
  throw new Error("Usage: pins.mjs set|guard --resolved resolved.json [--base-ref REF]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
