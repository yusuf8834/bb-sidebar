import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bumpSteps, channelSteps, firstErrorLines, parseTestCounts, runSteps, splitCheckScript } from "./checks.mjs";
import {
  BODY_LIMIT,
  bumpBranch,
  issueContent,
  missingResult,
  passingComment,
  prContent,
  summaryMarkdown,
} from "./report.mjs";

const runUrl = "https://github.com/o/r/actions/runs/1";
const pass = (name, extra = {}) => ({ name, command: name, status: "pass", ...extra });
const fail = (name, errors) => ({ name, command: name, status: "fail", errors });
const channel = (name, bbApp, sdk, steps) => ({
  kind: "channel",
  channel: name,
  bbApp,
  sdk,
  pinned: { bbApp: "0.49.0", sdk: "0.6.132" },
  shimPins: {},
  warnings: [],
  steps,
  ok: steps.every((step) => step.status === "pass"),
});

test("vitest counts and the first error lines come out of real output", () => {
  assert.deepEqual(
    parseTestCounts(
      "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m1189 passed\u001b[39m\u001b[22m\u001b[90m (1189)\u001b[39m\n",
    ),
    {
      passed: 1189,
      failed: 0,
      skipped: 0,
      total: 1189,
    },
  );
  assert.deepEqual(
    parseTestCounts(
      " Test Files  1 failed | 133 passed (134)\n      Tests  2 failed | 1186 passed | 1 skipped (1189)\n",
    ),
    {
      passed: 1186,
      failed: 2,
      skipped: 1,
      total: 1189,
    },
  );
  assert.equal(parseTestCounts("no summary"), null);
  const tsc =
    "> tsc --noEmit\n\nsrc/lifecycle.ts(12,3): error TS2339: Property 'goals' does not exist on type 'PluginSidebarThreadActivity'.\n";
  assert.deepEqual(firstErrorLines(tsc), [
    "src/lifecycle.ts(12,3): error TS2339: Property 'goals' does not exist on type 'PluginSidebarThreadActivity'.",
  ]);
  assert.deepEqual(firstErrorLines("a\nb\nc", 2), ["b", "c"]);
});

test("the bump runs every part of npm run check, the SDK check and the smoke", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const steps = bumpSteps(packageJson);
  assert.deepEqual(
    steps.map((step) => step.argv.join(" ")),
    [...packageJson.scripts.check.split(" && "), "npx --no-install bb plugin types --check", "npm run e2e:smoke"],
  );
  assert.ok(steps.some((step) => step.name === "Typecheck"));
  assert.throws(() => splitCheckScript("npm test; curl evil | sh"), /without a shell/);
  assert.throws(() => splitCheckScript("npm test && $(id)"), /without a shell/);
  assert.deepEqual(
    channelSteps("floor").map((step) => step.name),
    ["Unit tests", "Plugin build", "Bundle guard", "Browser smoke"],
  );
  assert.equal(channelSteps("stable")[0].name, "Typecheck");
});

test("steps run with only PATH and HOME, keep going after a failure, and skip dependents", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args.join(" ") === "run build") return { code: 1, stdout: "", stderr: "error: build broke" };
    return { code: 0, stdout: "Tests  3 passed (3)", stderr: "" };
  };
  process.env.GH_TOKEN_FOR_TEST = "secret";
  const results = await runSteps(channelSteps("stable"), {
    logDir: `${process.env.TMPDIR ?? "/tmp"}/bb-compat-steps-test`,
    runner,
    log: () => {},
  });
  delete process.env.GH_TOKEN_FOR_TEST;
  assert.deepEqual(
    results.map((result) => [result.name, result.status]),
    [
      ["Typecheck", "pass"],
      ["Unit tests", "pass"],
      ["Plugin build", "fail"],
      ["Bundle guard", "skipped"],
      ["Browser smoke", "pass"],
    ],
  );
  assert.deepEqual(results[2].errors, ["error: build broke"]);
  assert.equal(results[1].tests.total, 3);
  for (const call of calls) assert.deepEqual(Object.keys(call.env).sort(), ["HOME", "PATH"]);
});

test("one issue for floor and stable, titled with the failing channels", () => {
  const results = [
    channel("floor", "0.49.0", "0.6.132", [
      pass("Unit tests", { tests: { passed: 5, failed: 0, skipped: 0, total: 5 } }),
    ]),
    channel("stable", "0.50.0", "0.6.150", [fail("Typecheck", ["src/a.ts(1,1): error TS2305: x"]), pass("Unit tests")]),
    channel("nightly", "0.50.1-nightly.1", "0.6.151", [pass("Unit tests")]),
  ];
  const main = issueContent("main", results, { runUrl, now: new Date("2026-11-12T10:00:00Z") });
  assert.equal(main.failing, true);
  assert.equal(main.title, "bb compatibility check failing: stable bb 0.50.0 (SDK 0.6.150)");
  assert.match(main.body, /^<!-- bb-compat:main -->/);
  assert.match(main.body, /Latest failing run: https:\/\/github\.com\/o\/r\/actions\/runs\/1 \(2026-11-12 10:00 UTC\)/);
  assert.match(main.body, /\*\*Typecheck\*\* failed .*\n\n```text\nsrc\/a\.ts\(1,1\): error TS2305: x\n```/);
  assert.match(main.body, /### floor: bb-app 0\.49\.0, SDK 0\.6\.132 \(passing\)/);
  assert.doesNotMatch(main.body, /nightly/);
  assert.equal(issueContent("nightly", results, { runUrl }).failing, false);
  assert.match(
    passingComment("main", results, { runUrl }),
    /^Passing again in https:.*floor bb-app 0\.49\.0, SDK 0\.6\.132; stable/,
  );
});

test("the nightly issue says it is a warning, and a missing job counts as failing", () => {
  const nightly = channel("nightly", "0.50.1-nightly.1", "0.6.151", [fail("Unit tests", ["FAIL src/x.test.ts"])]);
  const content = issueContent("nightly", [nightly], { runUrl });
  assert.equal(content.title, "Warning: unreleased bb nightly 0.50.1-nightly.1 (SDK 0.6.151) fails the sidebar checks");
  assert.match(content.body, /has not been released/);
  const missing = issueContent("main", [missingResult("floor"), missingResult("stable")], { runUrl });
  assert.equal(missing.title, "bb compatibility check failing: floor (no result), stable (no result)");
  assert.match(missing.body, /the job ended before writing them/);
});

test("the summary lists versions, and bodies stay under GitHub's limit", () => {
  const huge = channel("stable", "0.50.0", "0.6.150", [fail("Unit tests", ["x".repeat(400)])]);
  huge.surface = { markdown: "y".repeat(100_000) };
  const summary = summaryMarkdown([huge], { runUrl });
  assert.match(summary, /\| stable \| 0\.50\.0 \| 0\.6\.150 \| \*\*FAIL\*\* \|/);
  assert.ok(summary.length <= BODY_LIMIT);
  assert.ok(issueContent("main", [huge], { runUrl }).body.length <= BODY_LIMIT);
  assert.ok(prContent({ ...huge, kind: "bump" }, { runUrl }).body.length <= BODY_LIMIT);
});

test("a failing bump is a draft with a do-not-merge title; a passing one is not", () => {
  const steps = [
    pass("Lint"),
    fail("Typecheck", ["src/a.ts(1,1): error TS2339: goals"]),
    pass("Unit tests", { tests: { passed: 9, failed: 0, skipped: 0, total: 9 } }),
  ];
  const bump = {
    kind: "bump",
    bbApp: "0.50.0",
    sdk: "0.6.150",
    pinned: { bbApp: "0.49.0", sdk: "0.6.132" },
    shimPins: { "tailwind-merge": "^3.8.0" },
    steps,
  };
  const failing = prContent(bump, { runUrl });
  assert.equal(failing.title, "[DO NOT MERGE: checks fail] chore: pin bb 0.50.0 and SDK 0.6.150");
  assert.equal(failing.draft, true);
  for (const heading of ["## Why", "## What changed", "## How I verified", "## Merge Danger", "## Checklist"]) {
    assert.ok(failing.body.includes(heading), heading);
  }
  assert.match(failing.body, /`bb-app`: 0\.49\.0 → 0\.50\.0/);
  assert.match(failing.body, /`@get-bb\/plugin-sdk`: 0\.6\.132 → 0\.6\.150/);
  assert.match(failing.body, /\| Unit tests \| pass \| 9\/9 passed \|/);
  assert.match(failing.body, /\*\*Typecheck\*\* failed/);
  assert.match(failing.body, /- \[ \] `npm run check` passes/);
  const passing = prContent({ ...bump, steps: [pass("Lint")] }, { runUrl });
  assert.equal(passing.title, "chore: pin bb 0.50.0 and SDK 0.6.150");
  assert.equal(passing.draft, false);
  assert.equal(bumpBranch("0.50.0"), "bb-bump/bb-app-0.50.0");
  assert.throws(() => bumpBranch("0.50.0-nightly.1"), /stable/);
  assert.throws(() => bumpBranch("main"), /stable/);
});
