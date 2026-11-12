// Shared helpers for the bb compatibility workflows. Child processes get an
// allowlisted environment, never the caller's: a token or BB_* variable in the
// parent must not reach npm, bb or a test.
import { execFile } from "node:child_process";

// Strict SemVer 2.0.0 (semver.org's recommended pattern). Every version string
// that comes from npm passes this before it is used in a command or a branch.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Returns the version, or throws when it is not strict SemVer. */
export function assertSemver(value, what = "version") {
  if (typeof value !== "string" || value.length > 128 || !SEMVER.test(value)) {
    throw new Error(`${what} is not a strict semver version: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A stable release: X.Y.Z with no prerelease or build part. */
export function assertStableSemver(value, what = "version") {
  assertSemver(value, what);
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${what} is not a stable release: ${value}`);
  return value;
}

/** A pin bb asks for: an exact version, or one with a leading ^ or ~. */
export function assertPinRange(value, what = "range") {
  if (typeof value !== "string") throw new Error(`${what} is not a string`);
  assertSemver(value.replace(/^[~^]/, ""), what);
  return value;
}

/** Compares two stable X.Y.Z versions: negative, zero or positive. */
export function compareStable(a, b) {
  const pa = assertStableSemver(a).split(".").map(Number);
  const pb = assertStableSemver(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Package names npm accepts, scoped or not; checked before use in argv. */
export function assertPackageName(value) {
  if (typeof value !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`Unexpected package name: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The environment for a child process: PATH and HOME plus explicit extras. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const key of ["PATH", "HOME"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

/**
 * Runs a command without a shell. Resolves with { code, stdout, stderr } and
 * never rejects for a non-zero exit; callers decide what a failure means.
 */
export function run(command, args, { cwd, env = cleanEnv(), timeoutMs = 10 * 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          if (error.killed || error.signal) {
            resolve({ code: 124, stdout, stderr: `${stderr}\n${command} stopped by ${error.signal ?? "timeout"}` });
            return;
          }
          reject(error);
          return;
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Like run, but throws with the output when the command fails. */
export async function runOk(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.code}\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return text.replace(ANSI, "");
}

/** Parses `--name value` and `--flag` arguments. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[name] = true;
    else {
      args[name] = next;
      i++;
    }
  }
  return args;
}

/** A Markdown code fence longer than any backtick run inside the text. */
export function fence(text, info = "") {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${text}\n${ticks}`;
}

/** Inline code that survives backticks in the value. */
export function code(text) {
  const value = String(text);
  if (!value.includes("`")) return `\`${value}\``;
  return `\`\` ${value.replace(/`{2,}/g, "`")} \`\``;
}

/** Shortens text to a character budget, saying how much was cut. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 40))}\n… (${text.length - max + 40} more characters cut)`;
}
