// Drives `bb sidebar` against the scratch server from scripts/e2e/server.mjs.
// The transcript of every command is kept in e2e-artifacts/cli-transcript.log.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startScratchServer } from "./e2e/server.mjs";

const results = [];
const transcript = [];
const server = await startScratchServer();

async function sidebar(argv, threadId) {
  const env = threadId ? { ...server.env, BB_THREAD_ID: threadId } : server.env;
  const result = await server.cli(["sidebar", ...argv], { allowFailure: true, env });
  transcript.push(
    `$ ${threadId ? `BB_THREAD_ID=${threadId} ` : ""}bb sidebar ${argv.join(" ")}  [exit ${result.code}]`,
  );
  transcript.push((result.stdout + result.stderr).trimEnd());
  return result;
}
async function rows() {
  const response = await fetch(`${server.url}/api/v1/plugins/bb-sidebar/rpc/listLifecycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return new Map((await response.json()).result.rows.map((row) => [row.threadId, row]));
}
async function shelves() {
  const result = await sidebar(["list", "--all", "--json"]);
  return new Map(JSON.parse(result.stdout).threads.map((row) => [row.threadId, row]));
}
async function step(name, check) {
  try {
    await check();
    results.push({ name, status: "passed" });
    console.log(`PASS: ${name}`);
  } catch (error) {
    results.push({ name, status: "failed", message: error.message });
    console.log(`FAIL: ${name}\n  ${error.message}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const [a, b, c] = [
    await server.seed("Alpha", { idle: true }),
    await server.seed("Bravo", { idle: true }),
    await server.seed("Charlie", { idle: true }),
  ];

  await step("command is registered with help", async () => {
    const help = await sidebar(["--help"]);
    expect(help.code === 0 && /snooze/.test(help.stdout) && /parent/.test(help.stdout), help.stdout + help.stderr);
  });
  await step("list shows every seeded thread as active", async () => {
    const list = await shelves();
    for (const t of [a, b, c]) expect(list.get(t.id)?.shelf === "active", `${t.title}: ${list.get(t.id)?.shelf}`);
  });
  await step("snooze 2h defaults to the calling thread", async () => {
    const before = Date.now();
    const result = await sidebar(["snooze", "2h"], a.id);
    expect(result.code === 0, result.stderr);
    const row = (await rows()).get(a.id);
    expect(row?.snoozedUntil >= before + 7_200_000 - 1000, JSON.stringify(row));
    expect((await shelves()).get(a.id).shelf === "snoozed", "not on Snoozed");
  });
  await step("list --state snoozed filters", async () => {
    const result = await sidebar(["list", "--all", "--state", "snoozed"]);
    expect(result.stdout.includes(a.id) && !result.stdout.includes(b.id), result.stdout);
  });
  await step("resume unsnoozes", async () => {
    expect((await sidebar(["resume", "--thread", a.id])).code === 0, "exit");
    expect(!(await rows()).has(a.id), "row kept");
  });
  await step("settle and resume", async () => {
    expect((await sidebar(["settle", "--thread", b.id])).code === 0, "settle exit");
    expect((await shelves()).get(b.id).shelf === "settled", "not settled");
    expect((await sidebar(["resume", "--thread", b.id])).code === 0, "resume exit");
    expect((await shelves()).get(b.id).shelf === "active", "not active");
  });
  await step("park and resume", async () => {
    expect((await sidebar(["park", "--thread", c.id])).code === 0, "park exit");
    expect((await shelves()).get(c.id).shelf === "parked", "not parked");
    expect((await sidebar(["resume", "--thread", c.id])).code === 0, "resume exit");
    expect((await shelves()).get(c.id).shelf === "active", "not active");
  });
  await step("pin a top-level thread", async () => {
    expect((await sidebar(["pin", "--thread", a.id])).code === 0, "pin exit");
    expect((await shelves()).get(a.id).pinned === true, "not pinned");
  });
  await step("parent and --clear", async () => {
    expect((await sidebar(["parent", b.id, "--thread", c.id])).code === 0, "parent exit");
    expect((await shelves()).get(c.id).parentThreadId === b.id, "parent not set");
    expect((await sidebar(["parent", "--clear", "--thread", c.id])).code === 0, "clear exit");
    expect((await shelves()).get(c.id).parentThreadId === null, "parent not cleared");
  });
  await step("pinning a child is refused", async () => {
    await sidebar(["parent", b.id, "--thread", c.id]);
    const result = await sidebar(["pin", "--thread", c.id]);
    expect(result.code !== 0 && /cannot be pinned/i.test(result.stderr), result.stderr);
    await sidebar(["parent", "--clear", "--thread", c.id]);
  });
  await step("a child is listed on its parent's shelf", async () => {
    await sidebar(["parent", b.id, "--thread", c.id]);
    expect((await sidebar(["snooze", "1h", "--thread", b.id])).code === 0, "snooze exit");
    // Snooze writes only the parent's row; the child keeps its own Active one.
    expect((await rows()).get(c.id)?.snoozedUntil == null, "snoozing the parent wrote the child's row");
    const list = await shelves();
    expect(list.get(c.id).shelf === "snoozed", `child: ${list.get(c.id).shelf}`);
    expect(list.get(c.id).snoozedUntil === list.get(b.id).snoozedUntil, "child wake time differs");
    const active = await sidebar(["list", "--all", "--state", "active"]);
    expect(!active.stdout.includes(c.id), active.stdout);
    const resume = await sidebar(["resume", "--thread", c.id]);
    expect(resume.code !== 0 && resume.stderr.includes(b.id), resume.stderr);
    expect((await sidebar(["resume", "--thread", b.id])).code === 0, "resume exit");
    expect((await shelves()).get(c.id).shelf === "active", "child not back with its parent");
    await sidebar(["parent", "--clear", "--thread", c.id]);
  });
  await step("bad wake time is rejected with a hint", async () => {
    const result = await sidebar(["snooze", "soonish", "--thread", b.id]);
    expect(result.code !== 0 && /tomorrow@09:00/.test(result.stderr), result.stderr);
  });
  await step("no thread outside a thread is rejected", async () => {
    const result = await sidebar(["settle"]);
    expect(result.code !== 0 && /--thread/.test(result.stderr), result.stderr);
  });
  await step("--json errors use the envelope", async () => {
    const result = await sidebar(["list", "--state", "nope", "--json"]);
    expect(result.code !== 0 && JSON.parse(result.stdout).ok === false, result.stdout);
  });
  await step("list pages with --limit and --offset", async () => {
    const first = JSON.parse((await sidebar(["list", "--all", "--limit", "2", "--json"])).stdout);
    const second = JSON.parse((await sidebar(["list", "--all", "--limit", "2", "--offset", "2", "--json"])).stdout);
    expect(first.total === 3 && first.nextOffset === 2 && second.nextOffset === null, JSON.stringify([first, second]));
    const seen = [...first.threads, ...second.threads].map((row) => row.threadId);
    expect(new Set(seen).size === 3, seen.join(","));
  });
  await step("isolation guard stayed clean", () => server.checkIsolation("complete"));
} finally {
  writeFileSync(resolve("e2e-artifacts/cli-transcript.log"), `${transcript.join("\n")}\n`);
  await server.cleanup();
}
const failed = results.filter((result) => result.status === "failed").length;
console.log(failed ? `${failed} of ${results.length} CLI checks failed` : `All ${results.length} CLI checks passed`);
process.exitCode = failed ? 1 : 0;
