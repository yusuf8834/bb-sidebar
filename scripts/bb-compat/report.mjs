// Markdown for the job summary, the compatibility issues and the bump pull
// request. Pure functions over the results.json files the jobs write; no
// TypeScript or npm needed, so the jobs that hold write tokens can run it.
import { code, fence, truncate } from "./lib.mjs";

export const BODY_LIMIT = 60_000;
export const ISSUE_GROUPS = {
  main: {
    label: "bb-compat",
    channels: ["floor", "stable"],
    color: "d73a4a",
    description: "Daily bb compatibility check fails",
  },
  nightly: {
    label: "bb-compat-nightly",
    channels: ["nightly"],
    color: "fbca04",
    description: "Warning: an unreleased bb nightly fails the sidebar checks",
  },
};

/** A stand-in for a channel whose job ended before writing results. */
export function missingResult(channel) {
  return {
    kind: "channel",
    channel,
    missing: true,
    ok: false,
    warnings: [],
    steps: [
      {
        name: "Job",
        command: "channel job",
        status: "fail",
        errors: ["No results: the job ended before writing them. See the run log."],
      },
    ],
  };
}

function versions(result) {
  if (!result.bbApp) return "bb not resolved";
  return `bb-app ${result.bbApp}, SDK ${result.sdk}`;
}

function testCell(step) {
  if (!step.tests) return "";
  const { passed, failed, skipped, total } = step.tests;
  return `${passed}/${total} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`;
}

function stepsTable(steps) {
  const rows = steps.map((step) => {
    const status = step.status === "fail" ? "**FAIL**" : step.status;
    return `| ${step.name} | ${status} | ${testCell(step)} |`;
  });
  return ["| Check | Result | Tests |", "| --- | --- | --- |", ...rows].join("\n");
}

function failureDetails(steps) {
  return steps
    .filter((step) => step.status === "fail")
    .map((step) => {
      const errors = step.errors?.length ? step.errors.join("\n") : "(no error lines captured; see the run log)";
      return `**${step.name}** failed (${code(step.command)}). First error lines:\n\n${fence(errors, "text")}`;
    })
    .join("\n\n");
}

/** One channel's section: versions, checks, failures, warnings, SDK report. */
function channelSection(result) {
  const state = result.ok ? "passing" : "failing";
  const lines = [`### ${result.channel}: ${versions(result)} (${state})`, ""];
  if (result.pinned) lines.push(`Pinned: bb-app ${result.pinned.bbApp}, SDK ${result.pinned.sdk}.`, "");
  const shims = Object.entries(result.shimPins ?? {});
  if (shims.length)
    lines.push(`Shim pins bb asks for: ${shims.map(([name, range]) => code(`${name}@${range}`)).join(", ")}.`, "");
  lines.push(stepsTable(result.steps), "");
  const failures = failureDetails(result.steps);
  if (failures) lines.push(failures, "");
  for (const warning of result.warnings ?? []) lines.push(`> Warning: ${warning}`, "");
  if (result.surface?.markdown) lines.push(result.surface.markdown, "");
  return lines.join("\n");
}

export function summaryMarkdown(results, { runUrl }) {
  const rows = results.map(
    (result) =>
      `| ${result.channel} | ${result.bbApp ?? "?"} | ${result.sdk ?? "?"} | ${result.ok ? "pass" : "**FAIL**"} |`,
  );
  const body = [
    "## bb compatibility check",
    "",
    `Run: ${runUrl}`,
    "",
    "| Channel | bb-app | SDK | Result |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...results.map(channelSection),
  ].join("\n");
  return truncate(body, BODY_LIMIT);
}

function channelTitle(result) {
  return result.bbApp ? `${result.channel} bb ${result.bbApp} (SDK ${result.sdk})` : `${result.channel} (no result)`;
}

/** Issue title and body for a group, and whether the group is failing. */
export function issueContent(group, results, { runUrl, now = new Date() }) {
  const members = results.filter((result) => ISSUE_GROUPS[group].channels.includes(result.channel));
  const failing = members.filter((result) => !result.ok);
  const title =
    group === "nightly"
      ? `Warning: unreleased bb nightly ${members[0]?.bbApp ?? "(unresolved)"} (SDK ${members[0]?.sdk ?? "?"}) fails the sidebar checks`
      : `bb compatibility check failing: ${failing.map(channelTitle).join(", ")}`;
  const intro =
    group === "nightly"
      ? "The nightly bb has not been released. This is an early warning: nothing is broken for users yet."
      : "The daily bb compatibility check fails. Users on these bb versions may be affected.";
  const body = [
    `<!-- bb-compat:${group} -->`,
    intro,
    "",
    `Latest failing run: ${runUrl} (${now.toISOString().slice(0, 16).replace("T", " ")} UTC).`,
    "Each failing run replaces this description; the first passing run comments and closes the issue.",
    "",
    ...members.map(channelSection),
  ].join("\n");
  return { failing: failing.length > 0, title, body: truncate(body, BODY_LIMIT) };
}

export function passingComment(group, results, { runUrl }) {
  const members = results.filter((result) => ISSUE_GROUPS[group].channels.includes(result.channel));
  return `Passing again in ${runUrl}: ${members.map((result) => `${result.channel} ${versions(result)}`).join("; ")}. Closing.`;
}

export function bumpBranch(bbApp) {
  if (!/^\d+\.\d+\.\d+$/.test(bbApp)) throw new Error(`Not a stable bb-app version: ${bbApp}`);
  return `bb-bump/bb-app-${bbApp}`;
}

function bumpCommitTitle(result) {
  return `chore: pin bb ${result.bbApp} and SDK ${result.sdk}`;
}

/** Pull request title, body and draft state for a prepared bump. */
export function prContent(result, { runUrl, note }) {
  const failing = result.steps.filter((step) => step.status !== "pass");
  const title = `${failing.length ? "[DO NOT MERGE: checks fail] " : ""}${bumpCommitTitle(result)}`;
  const shims = Object.entries(result.shimPins ?? {});
  const check = (done) => (done ? "[x]" : "[ ]");
  const body = [
    `<!-- bb-compat:bump bb-app=${result.bbApp} -->`,
    "## Why",
    "",
    `bb ${result.bbApp} is the latest stable bb (\`bb-app@latest\`); the sidebar pins ${result.pinned.bbApp}. This pull request was opened by the daily bump workflow: ${runUrl}`,
    "",
    failing.length
      ? `**Not ready to merge: ${failing.map((step) => step.name).join(", ")} failed.** Fix the code on this branch, or wait for a newer bb.`
      : "Every check passed on the runner. GitHub does not start CI for pull requests opened by a workflow token, so the results below are the CI for this branch; push any commit to start the normal CI too.",
    "",
    "## What changed",
    "",
    `- \`bb-app\`: ${result.pinned.bbApp} → ${result.bbApp}`,
    `- \`@get-bb/plugin-sdk\`: ${result.pinned.sdk} → ${result.sdk} (the SDK bb ${result.bbApp} ships)`,
    ...(shims.length
      ? [`- Shim pins bb asks for: ${shims.map(([name, range]) => code(`${name}@${range}`)).join(", ")}`]
      : []),
    "- `package-lock.json` regenerated.",
    "",
    "The pin guard checked that only `devDependencies` in package.json and package-lock.json changed. `engines` (the minimum bb), `dependencies`, `allowScripts` and `version` are unchanged; moving the minimum is a human decision.",
    "",
    "## How I verified",
    "",
    stepsTable(result.steps),
    "",
    ...(failing.length ? [failureDetails(result.steps), ""] : []),
    ...(result.warnings ?? []).map((warning) => `> Warning: ${warning}\n`),
    ...(note ? [`> ${note}`, ""] : []),
    result.surface?.markdown ?? "The SDK surface report did not run; see the run log.",
    "",
    "## Merge Danger",
    "",
    "**Door:** two-way: a revert restores the previous pins. The minimum bb in `engines` does not move.",
    "",
    "**Blast Radius:** small: development pins only. Code that compiles against the new SDK must still run on the minimum bb; the daily check's floor channel covers that.",
    "",
    "## Checklist",
    "",
    `- ${check(!failing.length)} \`npm run check\` passes (on the runner)`,
    "- [x] CHANGELOG entry under Unreleased, for user-visible changes (none: users cannot see a pin change)",
    "- [x] Screenshots for visual changes, or this PR changes nothing a user can see",
    "- [x] No AI tool, model or agent credited as an author or co-author",
    "",
  ].join("\n");
  return { title, body: truncate(body, BODY_LIMIT), draft: failing.length > 0 };
}

export function bumpCommitMessage(result) {
  const lines = [
    `Pin bb-app ${result.bbApp} and @get-bb/plugin-sdk ${result.sdk}, the SDK it`,
    `ships, with the runtime-shim pins bb ${result.bbApp} asks for. engines is unchanged.`,
  ];
  return { title: bumpCommitTitle(result), body: lines.join("\n") };
}
