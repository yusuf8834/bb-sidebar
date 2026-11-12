// The writing half: compatibility issues and the bump pull request.
// Dry run is the default; only `--live` writes. Every write goes through
// `github.write`, which in a dry run prints what it would do instead.
//
//   node scripts/bb-compat/publish.mjs issues --results-dir DIR --run-url URL [--live]
//   node scripts/bb-compat/publish.mjs pr --bundle DIR --run-url URL [--live]
//
// Imports only Node built-ins and sibling scripts that do, so the jobs that
// hold write tokens run no installed package code.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPackageName, assertPinRange, assertSemver, cleanEnv, parseArgs, run, runOk } from "./lib.mjs";
import { guardWorkingTree, pinsFromResolved } from "./pins.mjs";
import {
  bumpBranch,
  bumpCommitMessage,
  ISSUE_GROUPS,
  issueContent,
  missingResult,
  passingComment,
  prContent,
  summaryMarkdown,
} from "./report.mjs";

export const BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };

/**
 * The only path to GitHub. `read` always runs; `write` runs only when live.
 * `runner` is injectable so tests can record calls without a network.
 */
export function createGitHub({ live, runner = run, log = console.log, env = ghEnv() }) {
  const bodyDir = mkdtempSync(join(tmpdir(), "bb-compat-body-"));
  let bodies = 0;
  const call = async (command, args) => {
    const result = await runner(command, args, { env });
    if (result.code !== 0)
      throw new Error(`${command} ${args[0]} ${args[1] ?? ""} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };
  return {
    live,
    bodyFile(text) {
      const path = join(bodyDir, `body-${++bodies}.md`);
      writeFileSync(path, text);
      return path;
    },
    read: (command, args) => call(command, args),
    async write(command, args, what, body) {
      if (!live) {
        log(
          `[dry run] would ${what}: ${command} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`,
        );
        if (body) log(`[dry run] body:\n${body}\n[dry run] end of body`);
        return null;
      }
      log(`${what}: ${command} ${args[0]} ${args[1] ?? ""}`);
      return call(command, args);
    },
  };
}

function ghEnv() {
  const repo = process.env.GH_REPO;
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`Unexpected GH_REPO ${JSON.stringify(repo)}`);
  const extra = {};
  if (process.env.GH_TOKEN) extra.GH_TOKEN = process.env.GH_TOKEN;
  if (repo) extra.GH_REPO = repo;
  return cleanEnv(extra);
}

const CHANNELS = ["floor", "stable", "nightly"];

/**
 * The artifact came from a job that ran the new bb, so the values that reach
 * titles are checked again here; a result that fails counts as failed.
 */
function checkedResult(result) {
  try {
    for (const value of [result.bbApp, result.sdk, result.pinned?.bbApp, result.pinned?.sdk]) {
      if (value !== undefined) assertSemver(value);
    }
    for (const [name, range] of Object.entries(result.shimPins ?? {})) {
      assertPackageName(name);
      assertPinRange(range);
    }
    if (!Array.isArray(result.steps) || !result.steps.length) throw new Error("no steps");
    for (const step of result.steps) {
      if (!/^[\w :.-]{1,60}$/.test(String(step.name)) || !["pass", "fail", "skipped"].includes(step.status)) {
        throw new Error(`unexpected step ${JSON.stringify(step.name)}`);
      }
    }
    return { ...result, ok: result.steps.every((step) => step.status === "pass") };
  } catch (error) {
    const invalid = missingResult(result.channel);
    invalid.steps[0].errors = [`results.json failed validation: ${error.message.slice(0, 200)}`];
    return invalid;
  }
}

/** Reads every results.json under dir; channels with none count as failed. */
export function loadChannelResults(dir) {
  const found = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "results.json") {
        const result = JSON.parse(readFileSync(path, "utf8"));
        if (result.kind === "channel" && CHANNELS.includes(result.channel))
          found[result.channel] = checkedResult(result);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return CHANNELS.map((channel) => found[channel] ?? missingResult(channel));
}

/** Opens, updates or closes one issue per group, found by its label. */
export async function publishIssues(github, results, { runUrl }) {
  for (const [group, config] of Object.entries(ISSUE_GROUPS)) {
    const listed = await github.read("gh", [
      "issue",
      "list",
      "--label",
      config.label,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "20",
    ]);
    const open = JSON.parse(listed)
      .map((issue) => issue.number)
      .sort((a, b) => a - b)[0];
    const content = issueContent(group, results, { runUrl });
    if (content.failing && open) {
      await github.write(
        "gh",
        ["issue", "edit", String(open), "--title", content.title, "--body-file", github.bodyFile(content.body)],
        `update issue #${open}`,
        content.body,
      );
    } else if (content.failing) {
      await github.write(
        "gh",
        ["label", "create", config.label, "--color", config.color, "--description", config.description, "--force"],
        `ensure label ${config.label}`,
      );
      await github.write(
        "gh",
        [
          "issue",
          "create",
          "--title",
          content.title,
          "--label",
          config.label,
          "--body-file",
          github.bodyFile(content.body),
        ],
        "open an issue",
        content.body,
      );
    } else if (open) {
      const comment = passingComment(group, results, { runUrl });
      await github.write(
        "gh",
        ["issue", "comment", String(open), "--body-file", github.bodyFile(comment)],
        `comment on issue #${open}`,
        comment,
      );
      await github.write("gh", ["issue", "close", String(open)], `close issue #${open}`);
    } else {
      console.log(`${group}: passing, no open ${config.label} issue; nothing to do.`);
    }
  }
}

async function git(args) {
  return (await runOk("git", args)).stdout.trim();
}

/**
 * Commits the prepared files on a bump branch and opens or updates its pull
 * request. Pushes only to refs/heads/bb-bump/bb-app-X.Y.Z, never over commits
 * a person added, and never to main.
 */
export async function publishPullRequest(github, bundle, { runUrl }) {
  const result = JSON.parse(readFileSync(join(bundle, "results.json"), "utf8"));
  const resolved = JSON.parse(readFileSync(join(bundle, "resolved.json"), "utf8"));
  if (resolved.bbApp !== result.bbApp || resolved.sdk !== result.sdk)
    throw new Error("results.json and resolved.json disagree");
  const branch = bumpBranch(result.bbApp);
  if (!/^bb-bump\/bb-app-\d+\.\d+\.\d+$/.test(branch)) throw new Error(`Refusing branch ${branch}`);

  for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(bundle, "files", file), file);
  const problems = await guardWorkingTree({ baseRef: "HEAD", allowed: Object.keys(pinsFromResolved(resolved)) });
  if (problems.length)
    throw new Error(`Pin guard FAILED; nothing pushed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  console.log("Pin guard passed again before the push.");

  const prs = JSON.parse(
    await github.read("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      "main",
      "--state",
      "all",
      "--json",
      "number,state,isDraft,url",
      "--limit",
      "20",
    ]),
  );
  const openPr = prs.find((pr) => pr.state === "OPEN");
  if (!openPr && prs.some((pr) => pr.state === "CLOSED")) {
    console.log(
      `A pull request for ${branch} was closed without merging; not reopening it. Delete the branch to allow a new one.`,
    );
    return result;
  }

  const base = await git(["rev-parse", "HEAD"]);
  const message = bumpCommitMessage(result);
  await runOk("git", ["add", "package.json", "package-lock.json"]);
  await runOk("git", [
    "-c",
    `user.name=${BOT.name}`,
    "-c",
    `user.email=${BOT.email}`,
    "commit",
    "--quiet",
    "-m",
    message.title,
    "-m",
    message.body,
  ]);
  const tree = await git(["rev-parse", "HEAD^{tree}"]);

  const remote = (await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).split(/\s/)[0] || "";
  let note = "";
  let push = true;
  if (remote) {
    await runOk("git", [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    const authors = (await git(["log", "--format=%ae", `${base}..refs/remotes/origin/${branch}`]))
      .split("\n")
      .filter(Boolean);
    const sameChange =
      (await git(["rev-parse", `refs/remotes/origin/${branch}^{tree}`])) === tree &&
      (await git(["rev-parse", `refs/remotes/origin/${branch}^`])) === base;
    if (authors.some((author) => author !== BOT.email)) {
      push = false;
      note = `The branch has commits from a person, so the bot did not push over them. These results are for the bot's own pins on main ${base.slice(0, 12)}, not for the branch head.`;
    } else if (sameChange) {
      push = false;
    }
  }
  if (push) {
    // The lease makes the push fail if the branch moved since ls-remote.
    await github.write(
      "git",
      ["push", `--force-with-lease=refs/heads/${branch}:${remote}`, "origin", `HEAD:refs/heads/${branch}`],
      `push ${branch}`,
    );
  } else console.log(`Not pushing ${branch}: ${note || "it already holds this change on this main."}`);

  const content = prContent(result, { runUrl, note });
  if (openPr) {
    await github.write(
      "gh",
      ["pr", "edit", String(openPr.number), "--title", content.title, "--body-file", github.bodyFile(content.body)],
      `update pull request #${openPr.number}`,
      content.body,
    );
    if (content.draft && !openPr.isDraft)
      await github.write(
        "gh",
        ["pr", "ready", String(openPr.number), "--undo"],
        `turn #${openPr.number} back into a draft`,
      );
    if (!content.draft && openPr.isDraft)
      await github.write("gh", ["pr", "ready", String(openPr.number)], `mark #${openPr.number} ready for review`);
  } else {
    const args = [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      content.title,
      "--body-file",
      github.bodyFile(content.body),
    ];
    if (content.draft) args.push("--draft");
    await github.write("gh", args, `open a ${content.draft ? "draft " : ""}pull request`, content.body);
  }
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const runUrl = args["run-url"];
  if (
    typeof runUrl !== "string" ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(runUrl)
  ) {
    throw new Error(`--run-url must be a GitHub Actions run URL, got ${JSON.stringify(runUrl)}`);
  }
  // A live run from another ref would publish that ref's code and pins.
  if (args.live === true && process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error(`--live runs only on refs/heads/main, not ${JSON.stringify(process.env.GITHUB_REF ?? "(unset)")}`);
  }
  const github = createGitHub({ live: args.live === true });
  console.log(
    github.live
      ? "Live run: issues, branches and pull requests will be written."
      : "Dry run: nothing will be written to GitHub.",
  );
  if (command === "issues") {
    const results = loadChannelResults(args["results-dir"]);
    const summary = summaryMarkdown(results, { runUrl });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    else console.log(summary);
    await publishIssues(github, results, { runUrl });
    return;
  }
  if (command === "pr") {
    const result = await publishPullRequest(github, args.bundle, { runUrl });
    const content = prContent(result, { runUrl });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${content.body}\n`);
    if (!result.ok) {
      console.log(`::error::bb ${result.bbApp} fails the sidebar checks; the pull request is a draft.`);
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("Usage: publish.mjs issues|pr ...");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
