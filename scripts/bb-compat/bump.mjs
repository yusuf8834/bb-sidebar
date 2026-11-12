// The read-only half of the bump pull request. Runs with a read-only token.
//
//   node scripts/bb-compat/bump.mjs plan --out "$RUNNER_TEMP/bump"     # is bb-app@latest newer than the pin?
//   node scripts/bb-compat/bump.mjs prepare --out "$RUNNER_TEMP/bump"  # set pins, lockfile, guard, run every check
//
// `plan` writes <out>/resolved.json and, on GitHub, the `needed` and `version`
// step outputs. `prepare` exits 1 only when it cannot produce a guarded
// change; failing checks are recorded in <out>/results.json for the PR.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bumpSteps, quoted, runSteps } from "./checks.mjs";
import { assertStableSemver, compareStable, parseArgs, run } from "./lib.mjs";
import { guardWorkingTree, pinsFromResolved, setDevDependencyPins } from "./pins.mjs";
import { resolveChannel } from "./resolve-bb.mjs";
import { compareSdkVersions, renderMarkdown, surfaceProblems } from "./sdk-surface.mjs";

/** Whether a resolved stable bb is newer than the pinned bb-app. */
export function bumpNeeded(resolved) {
  const pinned = assertStableSemver(resolved.pinned?.bbApp, "pinned bb-app");
  return compareStable(assertStableSemver(resolved.bbApp, "bb-app@latest"), pinned) > 0;
}

function setOutput(values) {
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[\w.+-]+$/.test(String(value))) throw new Error(`Refusing output ${key}=${JSON.stringify(value)}`);
    return `${key}=${value}\n`;
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join(""));
}

async function plan(out) {
  const resolved = await resolveChannel("stable", readFileSync("package.json", "utf8"));
  const needed = bumpNeeded(resolved);
  writeFileSync(join(out, "resolved.json"), `${JSON.stringify(resolved, null, 2)}\n`);
  setOutput({ needed, version: resolved.bbApp });
  console.log(
    needed
      ? `bb-app ${resolved.bbApp} (SDK ${resolved.sdk}) is newer than the pinned ${resolved.pinned.bbApp}; a bump is needed.`
      : `Pinned bb-app ${resolved.pinned.bbApp} is current with bb-app@latest ${resolved.bbApp}; nothing to do.`,
  );
}

async function npm(args, label) {
  console.log(`$ npm ${args.join(" ")}`);
  const result = await run("npm", args, { timeoutMs: 15 * 60_000 });
  console.log(quoted(`${result.stdout}\n${result.stderr}`.trim()));
  if (result.code !== 0) throw new Error(`${label} failed (npm exited ${result.code})`);
}

async function prepare(out) {
  const resolved = JSON.parse(readFileSync(join(out, "resolved.json"), "utf8"));
  if (!bumpNeeded(resolved)) throw new Error("prepare ran but no bump is needed");
  const pins = pinsFromResolved(resolved);
  writeFileSync("package.json", setDevDependencyPins(readFileSync("package.json", "utf8"), pins));
  // Update the existing lockfile in place, then install exactly what it says.
  await npm(["install", "--no-audit", "--no-fund"], "Lockfile update");
  await npm(["ci", "--no-audit", "--no-fund"], "Clean install from the new lockfile");
  const problems = await guardWorkingTree({ baseRef: "HEAD", allowed: Object.keys(pins) });
  if (problems.length) {
    console.error(`Pin guard FAILED; nothing will be pushed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Pin guard passed.");

  const results = {
    kind: "bump",
    bbApp: resolved.bbApp,
    sdk: resolved.sdk,
    pinned: resolved.pinned,
    shimPins: resolved.shimPins,
    warnings: resolved.warnings ?? [],
    steps: [],
  };
  try {
    const diff = await compareSdkVersions(resolved.pinned.sdk, resolved.sdk);
    results.surface = {
      from: resolved.pinned.sdk,
      to: resolved.sdk,
      markdown: renderMarkdown(diff, { from: resolved.pinned.sdk, to: resolved.sdk }),
    };
    const incomplete = surfaceProblems(diff);
    if (incomplete.length) results.warnings.push(`SDK surface report incomplete: ${incomplete.join("; ")}`);
  } catch (error) {
    results.warnings.push(`SDK surface report failed: ${error.message.split("\n")[0]}`);
  }
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  results.steps = await runSteps(bumpSteps(packageJson), { logDir: join(out, "logs") });
  results.ok = results.steps.every((step) => step.status === "pass");
  results.finishedAt = new Date().toISOString();
  mkdirSync(join(out, "files"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) copyFileSync(file, join(out, "files", file));
  writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  for (const step of results.steps) console.log(`${step.status.padEnd(7)} ${step.name}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const out = resolve(args.out ?? "");
  // The guard rejects any new file in the repository, so results live outside it.
  if (!args.out || !relative(process.cwd(), out).startsWith(".."))
    throw new Error("--out must be outside the repository");
  mkdirSync(out, { recursive: true });
  if (command === "plan") await plan(out);
  else if (command === "prepare") await prepare(out);
  else throw new Error("Usage: bump.mjs plan|prepare --out DIR");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
