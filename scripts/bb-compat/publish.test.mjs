import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setDevDependencyPins } from "./pins.mjs";
import { BOT, createGitHub, loadChannelResults, publishIssues, publishPullRequest } from "./publish.mjs";

const runUrl = "https://github.com/o/r/actions/runs/1";
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

/** A fake gh/git runner: answers reads from `responses`, records every call. */
function fakeGitHub({ live, responses = {} }) {
  const calls = [];
  const logs = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.slice(0, 2).join(" ")}`;
    return { code: 0, stdout: responses[key] ?? "", stderr: "" };
  };
  const github = createGitHub({ live, runner, log: (line) => logs.push(line), env: {} });
  return { github, calls, logs };
}

const result = (channel, ok) => ({
  kind: "channel",
  channel,
  bbApp: channel === "nightly" ? "0.50.1-nightly.1" : "0.50.0",
  sdk: "0.6.150",
  warnings: [],
  steps: [
    ok
      ? { name: "Unit tests", command: "npm test", status: "pass" }
      : { name: "Unit tests", command: "npm test", status: "fail", errors: ["FAIL x"] },
  ],
  ok,
});
const writes = (calls) =>
  calls.filter((call) => !(call[1] === "issue" && call[2] === "list") && !(call[1] === "pr" && call[2] === "list"));

test("a dry run reads but writes nothing, and prints what it would do", async () => {
  const { github, calls, logs } = fakeGitHub({ live: false, responses: { "gh issue list": "[]" } });
  await publishIssues(github, [result("floor", false), result("stable", true), result("nightly", false)], { runUrl });
  assert.deepEqual(writes(calls), []);
  assert.equal(calls.length, 2);
  assert.ok(logs.some((line) => line.startsWith("[dry run] would open an issue: gh issue create --title")));
  assert.ok(logs.some((line) => line.includes("--label bb-compat-nightly")));
});

test("a failure edits the open issue instead of commenting", async () => {
  const { github, calls } = fakeGitHub({ live: true, responses: { "gh issue list": '[{"number":9},{"number":7}]' } });
  await publishIssues(github, [result("floor", true), result("stable", false), result("nightly", true)], { runUrl });
  const edits = writes(calls);
  // Main group: edit #7 (the oldest). Nightly passes and has the same fake open issue: comment and close.
  assert.deepEqual(edits[0].slice(0, 6), [
    "gh",
    "issue",
    "edit",
    "7",
    "--title",
    "bb compatibility check failing: stable bb 0.50.0 (SDK 0.6.150)",
  ]);
  assert.match(readFileSync(edits[0][7], "utf8"), /^<!-- bb-compat:main -->/);
  assert.deepEqual(
    edits.slice(1).map((call) => call.slice(0, 4)),
    [
      ["gh", "issue", "comment", "7"],
      ["gh", "issue", "close", "7"],
    ],
  );
});

test("a new failure creates the label and one issue; passing with nothing open does nothing", async () => {
  const { github, calls } = fakeGitHub({ live: true, responses: { "gh issue list": "[]" } });
  await publishIssues(github, [result("floor", true), result("stable", true), result("nightly", false)], { runUrl });
  assert.deepEqual(
    writes(calls).map((call) => call.slice(0, 3)),
    [
      ["gh", "label", "create"],
      ["gh", "issue", "create"],
    ],
  );
  const create = writes(calls)[1];
  assert.equal(create[create.indexOf("--label") + 1], "bb-compat-nightly");
  assert.match(create[create.indexOf("--title") + 1], /^Warning: unreleased bb nightly/);
});

test("missing channel results count as failures", () => {
  const dir = temp("bb-compat-results-");
  mkdirSync(join(dir, "bb-compat-stable"));
  writeFileSync(join(dir, "bb-compat-stable", "results.json"), JSON.stringify(result("stable", true)));
  const results = loadChannelResults(dir);
  assert.deepEqual(
    results.map((entry) => [entry.channel, entry.ok, Boolean(entry.missing)]),
    [
      ["floor", false, true],
      ["stable", true, false],
      ["nightly", false, true],
    ],
  );
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A clone of a local bare repo holding the real package.json and lockfile. */
function bumpFixture({ tamper } = {}) {
  const root = temp("bb-compat-pr-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, work);
  const packageJson = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const lock = readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8");
  writeFileSync(join(work, "package.json"), packageJson);
  writeFileSync(join(work, "package-lock.json"), lock);
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--no-verify", "-m", "base");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");

  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "files"), { recursive: true });
  const resolved = { bbApp: "9.9.0", sdk: "9.9.1", shimPins: {}, pinned: { bbApp: "0.49.0", sdk: "0.6.132" } };
  let bumped = setDevDependencyPins(packageJson, { "bb-app": "9.9.0", "@get-bb/plugin-sdk": "9.9.1" });
  if (tamper) bumped = bumped.replace(/("bb": ">=)[^"]+"/, '$19.9.0"');
  const lockJson = JSON.parse(lock);
  lockJson.packages[""].devDependencies = JSON.parse(bumped).devDependencies;
  writeFileSync(join(bundle, "files", "package.json"), bumped);
  writeFileSync(join(bundle, "files", "package-lock.json"), `${JSON.stringify(lockJson, null, 2)}\n`);
  writeFileSync(join(bundle, "resolved.json"), JSON.stringify(resolved));
  const steps = [{ name: "Typecheck", command: "npm run typecheck", status: "fail", errors: ["error TS1"] }];
  writeFileSync(
    join(bundle, "results.json"),
    JSON.stringify({ kind: "bump", ...resolved, steps, ok: false, warnings: [] }),
  );
  return { root, origin, work, bundle };
}

async function inDir(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

test("a dry-run bump commits locally, then only prints the push and the draft pull request", async () => {
  const { work, bundle } = bumpFixture();
  const { github, calls, logs } = fakeGitHub({ live: false, responses: { "gh pr list": "[]" } });
  await inDir(work, () => publishPullRequest(github, bundle, { runUrl }));
  assert.deepEqual(writes(calls), []);
  assert.equal(
    git(work, "log", "-1", "--format=%an <%ae>|%s"),
    `${BOT.name} <${BOT.email}>|chore: pin bb 9.9.0 and SDK 9.9.1`,
  );
  assert.equal(git(work, "diff", "--name-only", "HEAD^", "HEAD"), "package-lock.json\npackage.json");
  assert.ok(
    logs.some((line) =>
      line.includes(
        "would push bb-bump/bb-app-9.9.0: git push --force-with-lease=refs/heads/bb-bump/bb-app-9.9.0: origin HEAD:refs/heads/bb-bump/bb-app-9.9.0",
      ),
    ),
  );
  const create = logs.find((line) => line.startsWith("[dry run] would open a draft pull request"));
  assert.match(
    create,
    /--base main --head bb-bump\/bb-app-9\.9\.0 --title "\[DO NOT MERGE: checks fail\] chore: pin bb 9\.9\.0 and SDK 9\.9\.1"/,
  );
  assert.match(create, /--draft$/);
});

test("a live bump pushes only to its own branch and opens a draft for failing checks", async () => {
  const { work, bundle } = bumpFixture();
  const { github, calls } = fakeGitHub({ live: true, responses: { "gh pr list": "[]" } });
  await inDir(work, () => publishPullRequest(github, bundle, { runUrl }));
  const [push, create] = writes(calls);
  assert.deepEqual(push, [
    "git",
    "push",
    "--force-with-lease=refs/heads/bb-bump/bb-app-9.9.0:",
    "origin",
    "HEAD:refs/heads/bb-bump/bb-app-9.9.0",
  ]);
  assert.deepEqual(create.slice(0, 7), ["gh", "pr", "create", "--base", "main", "--head", "bb-bump/bb-app-9.9.0"]);
  assert.equal(create.at(-1), "--draft");
  assert.ok(
    !writes(calls).some(
      (call) => call.includes("merge") || call.includes("review") || call.includes("HEAD:refs/heads/main"),
    ),
  );
});

test("the bot never pushes over a person's commit, and still updates the open pull request", async () => {
  const { origin, work, bundle, root } = bumpFixture();
  const human = join(root, "human");
  git(root, "clone", "--quiet", origin, human);
  writeFileSync(join(human, "fix.txt"), "a fix\n");
  git(human, "add", ".");
  git(
    human,
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@example.com",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "fix",
  );
  git(human, "push", "--quiet", "origin", "HEAD:refs/heads/bb-bump/bb-app-9.9.0");
  const open = '[{"number":12,"state":"OPEN","isDraft":false,"url":"u"}]';
  const { github, calls } = fakeGitHub({ live: true, responses: { "gh pr list": open } });
  await inDir(work, () => publishPullRequest(github, bundle, { runUrl }));
  const made = writes(calls);
  assert.deepEqual(
    made.map((call) => call.slice(0, 4)),
    [
      ["gh", "pr", "edit", "12"],
      ["gh", "pr", "ready", "12"],
    ],
  );
  assert.equal(made[1][4], "--undo");
  assert.match(readFileSync(made[0][made[0].indexOf("--body-file") + 1], "utf8"), /commits from a person/);
});

test("a tampered bundle fails the guard before anything is committed or pushed", async () => {
  const { work, bundle } = bumpFixture({ tamper: true });
  const before = git(work, "rev-parse", "HEAD");
  const { github, calls } = fakeGitHub({ live: true, responses: { "gh pr list": "[]" } });
  await assert.rejects(
    () => inDir(work, () => publishPullRequest(github, bundle, { runUrl })),
    /changed outside devDependencies: engines/,
  );
  assert.deepEqual(calls, []);
  assert.equal(git(work, "rev-parse", "HEAD"), before);
});
