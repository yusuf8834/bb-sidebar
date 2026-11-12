// Runs check steps one after another, keeps each step's log, and records
// pass/fail, test counts and the first error lines for the reports.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cleanEnv, run, stripAnsi } from "./lib.mjs";

const SAFE_WORD = /^[\w@./:=-]+$/;

/** Splits a plain `a && b && c` npm script into argv lists; anything else throws. */
export function splitCheckScript(script) {
  return script.split("&&").map((part) => {
    const argv = part.trim().split(/\s+/);
    if (!argv[0] || argv.some((word) => !SAFE_WORD.test(word))) {
      throw new Error(`Cannot run check step without a shell: ${JSON.stringify(part.trim())}`);
    }
    return argv;
  });
}

const LABELS = {
  "npm run lint": "Lint",
  "npm run format:check": "Format",
  "npm run knip": "Knip",
  "npm run typecheck": "Typecheck",
  "npm test": "Unit tests",
  "npm run test:scripts": "Script tests",
  "npm run build": "Plugin build",
  "node scripts/check-app-bundle.mjs": "Bundle guard",
  "npm run e2e:smoke": "Browser smoke",
  "npx --no-install bb plugin types --check": "SDK surface check",
};

function step(argv, options = {}) {
  const command = argv.join(" ");
  return { name: LABELS[command] ?? command, argv, ...options };
}

/** The daily channel steps. The floor skips typecheck: it only has to run. */
export function channelSteps(channel) {
  return [
    ...(channel === "floor" ? [] : [step(["npm", "run", "typecheck"])]),
    step(["npm", "test"]),
    step(["npm", "run", "build"]),
    step(["node", "scripts/check-app-bundle.mjs"], { needs: "Plugin build" }),
    step(["npm", "run", "e2e:smoke"]),
  ];
}

/** The bump steps: every part of `npm run check`, the SDK check, and the smoke. */
export function bumpSteps(packageJson) {
  return [
    ...splitCheckScript(packageJson.scripts.check).map((argv) =>
      step(argv, argv.join(" ") === "node scripts/check-app-bundle.mjs" ? { needs: "Plugin build" } : {}),
    ),
    step(["npx", "--no-install", "bb", "plugin", "types", "--check"]),
    step(["npm", "run", "e2e:smoke"]),
  ];
}

/**
 * Test counts from Vitest's summary ("Tests  2 failed | 1187 passed (1189)")
 * or node:test's ("ℹ tests 35", "ℹ pass 35", ...).
 */
export function parseTestCounts(output) {
  const lines = stripAnsi(output).split("\n");
  const line = lines.findLast((candidate) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(candidate));
  if (!line) return nodeTestCounts(lines);
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return {
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped") + count("todo"),
    total: Number(/\((\d+)\)\s*$/.exec(line)[1]),
  };
}

function nodeTestCounts(lines) {
  const count = (word) => {
    const line = lines.findLast((candidate) => new RegExp(`^ℹ ${word} \\d+$`).test(candidate.trim()));
    return line === undefined ? null : Number(line.trim().split(" ")[2]);
  };
  const total = count("tests");
  if (total === null) return null;
  return {
    passed: count("pass") ?? 0,
    failed: count("fail") ?? 0,
    skipped: (count("skipped") ?? 0) + (count("todo") ?? 0),
    total,
  };
}

const ERROR_LINE =
  /\berror\b|\bfail(?:ed|ure)?\b|✗|×|AssertionError|TypeError|ReferenceError|SyntaxError|Cannot find|is not assignable|has no exported member|does not exist on type|ERR!/i;

/** The first lines that look like errors, or the last lines when none do. */
export function firstErrorLines(output, limit = 15) {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const errors = lines.filter((line) => ERROR_LINE.test(line) && !/\b0 (?:errors?|failed)\b/i.test(line));
  const chosen = errors.length ? errors.slice(0, limit) : lines.slice(-limit);
  return chosen.map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
}

/**
 * Wraps command output so GitHub Actions does not act on any `::command::`
 * lines inside it (the output comes from dependencies and tests).
 */
export function quoted(text) {
  const token = randomUUID();
  return `::stop-commands::${token}\n${text}\n::${token}::`;
}

/**
 * Runs the steps in order. A step whose `needs` failed is skipped; the others
 * still run, so one report shows every failure. Child processes get only
 * PATH and HOME (as `env -i PATH="$PATH" HOME="$HOME"` would).
 */
export async function runSteps(steps, { cwd = process.cwd(), logDir, runner = run, log = console.log } = {}) {
  mkdirSync(logDir, { recursive: true });
  const results = [];
  for (const [index, current] of steps.entries()) {
    const command = current.argv.join(" ");
    const blocked = current.needs && results.find((result) => result.name === current.needs)?.status !== "pass";
    if (blocked) {
      results.push({ name: current.name, command, status: "skipped", reason: `${current.needs} did not pass` });
      log(`- ${current.name}: skipped (${current.needs} did not pass)`);
      continue;
    }
    log(`::group::${current.name}: ${command}`);
    const started = Date.now();
    const outcome = await runner(current.argv[0], current.argv.slice(1), {
      cwd,
      env: cleanEnv(),
      timeoutMs: current.timeoutMs ?? 20 * 60_000,
    });
    const output = `${outcome.stdout}\n${outcome.stderr}`;
    const logFile = join(logDir, `${String(index + 1).padStart(2, "0")}-${current.name.replace(/\W+/g, "-")}.log`);
    writeFileSync(logFile, `$ ${command}\n${output}`);
    log(quoted(output.trim()));
    log("::endgroup::");
    const status = outcome.code === 0 ? "pass" : "fail";
    const result = { name: current.name, command, status, exitCode: outcome.code, durationMs: Date.now() - started };
    const tests = parseTestCounts(output);
    if (tests) result.tests = tests;
    if (status === "fail") result.errors = firstErrorLines(output);
    results.push(result);
    log(`- ${current.name}: ${status}${tests ? ` (${tests.passed}/${tests.total} tests passed)` : ""}`);
  }
  return results;
}
