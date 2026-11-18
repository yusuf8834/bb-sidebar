import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

const mocks = vi.hoisted(() => ({ run: vi.fn(), platform: vi.fn(), proc: new Map<string, string>() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.run }) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: mocks.platform,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type Read = (path: unknown, ...rest: unknown[]) => Promise<unknown>;
  // A Linux scan reads /proc; those reads answer from `mocks.proc`.
  const procOr =
    (real: Read): Read =>
    async (path, ...rest) => {
      if (typeof path !== "string" || !path.startsWith("/proc/")) return real(path, ...rest);
      const content = mocks.proc.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    };
  return {
    ...actual,
    realpath: async (path: string) => path,
    readlink: procOr(actual.readlink as Read),
    readFile: procOr(actual.readFile as Read),
  };
});
import entry from "./ports-host";

const roots = [{ environmentId: "env_a", path: "/workspace/app" }];
const sockets = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 123 u 1u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)
node 456 u 1u IPv4 0x2 0t0 TCP 127.0.0.1:4000 (LISTEN)
`;
let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof entry.contract, {}>>;

beforeEach(() => {
  mocks.run.mockReset();
  mocks.proc.clear();
  mocks.platform.mockReturnValue("darwin");
  harness = experimental_createHostEntryHarness(entry);
});
afterEach(async () => {
  await harness.experimental_dispose();
});

function commands(docker: () => string = () => "") {
  mocks.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === "lsof")
      return { stdout: args.includes("-d") ? "p123\nfcwd\nn/workspace/app\np456\nfcwd\nn/workspace/app\n" : sockets };
    if (command === "ps")
      return {
        stdout:
          args[0] === "eww"
            ? "node app.js BB_THREAD_ID=thr_owner PATH=/bin"
            : args.includes("lstart=")
              ? "Sat Oct  3 12:29:38 2026\n"
              : args.includes("pid=,ppid=")
                ? "123 1\n"
                : "123 node app.js\n456 node /opt/bb-app/server/dist/index.js",
      };
    if (command === "docker") return { stdout: docker() };
    throw new Error(`Unexpected command ${command}`);
  });
}

describe("host port scan", () => {
  it("reports the host timezone for provider reset timestamps", async () => {
    expect(await harness.experimental_call("timeZone", {})).toEqual({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("enriches process listeners with Docker metadata without losing ownership or bind address", async () => {
    commands(() => "abc\tapp-web-1\t0.0.0.0:3000->3000/tcp, 0.0.0.0:8080->8080/tcp\t/workspace/app\tweb");
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([
      {
        environmentId: "env_a",
        port: 3000,
        address: "127.0.0.1",
        pid: 123,
        processName: "node",
        source: "process",
        ownerThreadId: "thr_owner",
        processStartedAt: "Sat Oct  3 12:29:38 2026",
        container: "app-web-1",
        service: "web",
      },
      {
        environmentId: "env_a",
        port: 8080,
        address: "0.0.0.0",
        source: "docker",
        container: "app-web-1",
        service: "web",
      },
    ]);
  });

  it("keeps user listeners and excludes BB listeners when Docker is unavailable", async () => {
    commands(() => {
      throw new Error("ENOENT");
    });
    const result = await harness.experimental_call("scan", {
      roots: [...roots, { environmentId: "env_b", path: roots[0].path }],
    });
    expect(
      result.ports.map(({ environmentId, port, ownerThreadId }) => ({ environmentId, port, ownerThreadId })),
    ).toEqual([
      { environmentId: "env_a", port: 3000, ownerThreadId: "thr_owner" },
      { environmentId: "env_b", port: 3000, ownerThreadId: "thr_owner" },
    ]);
  });

  it("propagates cancellation instead of returning a partial scan", async () => {
    const controller = new AbortController();
    commands(() => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(harness.experimental_call("scan", { roots }, { signal: controller.signal })).rejects.toThrow();
  });
});

const WORKER =
  "/Applications/bb Nightly.app/Contents/MacOS/bb Nightly --use-system-ca --use-env-proxy /Applications/bb Nightly.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs /Users/ysf/.bb/plugin-host-artifacts/provider-claude-code/d96f00ea2bf07b28110d5a0cd1c3c8b3dc7a4b88903962dfb0d0f728fe692353/host.mjs provider-claude-code /Users/ysf/.bb/plugins/provider-claude-code/bridge-data";
const CLAUDE = "/Users/ysf/.local/bin/claude --output-format stream-json --verbose";
const HEADER = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n";
/** The agent (pid 789) listens for its sandbox proxy; pid 123 is a server it started. */
const agentSockets = `${HEADER}2.1.325 789 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:52603 (LISTEN)
2.1.325 789 u 21u IPv6 0x2 0t0 TCP [::1]:52603 (LISTEN)
node 123 u 1u IPv4 0x3 0t0 TCP 127.0.0.1:3000 (LISTEN)
`;
const THREAD = "BB_THREAD_ID=thr_owner PATH=/bin";
const agent = { ppid: 700, args: CLAUDE, cwd: "/workspace/app", env: THREAD };
const server = { args: "node app.js", cwd: "/workspace/app", env: THREAD };
const serverPort = {
  environmentId: "env_a",
  port: 3000,
  address: "127.0.0.1",
  pid: 123,
  processName: "node",
  source: "process",
  ownerThreadId: "thr_owner",
  processStartedAt: "Sat Oct  3 12:29:38 2026",
};

type Process = { ppid?: number; args?: string; cwd?: string; env?: string };
/** Answer lsof and ps from a process table; a pid without a value has no row, as if it had exited. */
function processTable(listening: string, table: Record<number, Process>, psFailure?: (args: string[]) => unknown) {
  mocks.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === "docker") return { stdout: "" };
    const pids = (args[args.indexOf("-p") + 1] ?? "").split(",").map(Number);
    if (command === "lsof") {
      if (!args.includes("-d")) return { stdout: listening };
      return { stdout: pids.map((pid) => (table[pid]?.cwd ? `p${pid}\nfcwd\nn${table[pid].cwd}\n` : "")).join("") };
    }
    if (command !== "ps") throw new Error(`Unexpected command ${command}`);
    const failure = psFailure?.(args);
    if (failure) throw failure;
    const rows = pids.flatMap((pid) => {
      const row = table[pid];
      if (!row) return [];
      if (args.includes("pid=,ppid=")) return row.ppid === undefined ? [] : [`${pid} ${row.ppid}`];
      if (args.includes("pid=,args=")) return row.args === undefined ? [] : [`${pid} ${row.args}`];
      return [args[0] === "eww" ? `${row.args} ${row.env ?? ""}` : "Sat Oct  3 12:29:38 2026"];
    });
    // Like ps: exit 1 without output when none of the pids exist.
    if (!rows.length) throw Object.assign(new Error("ps exited 1"), { code: 1, stdout: "", stderr: "" });
    return { stdout: `${rows.join("\n")}\n` };
  });
}
function psCalls(flag: string): string[][] {
  return mocks.run.mock.calls
    .filter(([command, args]) => command === "ps" && args.includes(flag))
    .map(([, args]) => args);
}

describe("host port scan and the agent's own process", () => {
  it("leaves out the agent and keeps the server it started", async () => {
    processTable(agentSockets, {
      700: { ppid: 600, args: WORKER },
      789: agent,
      123: { ...server, ppid: 789 },
    });
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([serverPort]);
    // Only the parent that does not listen itself is looked up.
    expect(psCalls("pid=,args=").map((args) => args[args.indexOf("-p") + 1])).toEqual(["789,123", "700"]);
    // The agent is dropped before its environment or start time is read.
    expect(psCalls("eww").map((args) => args[args.indexOf("-p") + 1])).toEqual(["123"]);
    expect(psCalls("lstart=").map((args) => args[args.indexOf("-p") + 1])).toEqual(["123"]);
  });

  it("keeps a server reparented to launchd without looking its parent up", async () => {
    processTable(sockets, { 123: { ...server, ppid: 1 } });
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([serverPort]);
    expect(psCalls("pid=,args=")).toHaveLength(1);
  });

  it("leaves out a listener that exited, or whose parent exited, during the scan", async () => {
    const listening = `${sockets}node 457 u 1u IPv4 0x4 0t0 TCP 127.0.0.1:5000 (LISTEN)\n`;
    processTable(listening, {
      // 456 answered lsof and is gone for ps; 457's parent 600 is gone.
      456: { args: "node gone.js", cwd: "/workspace/app" },
      457: { ppid: 600, args: "node orphan.js", cwd: "/workspace/app" },
      123: { ...server, ppid: 500 },
      500: { ppid: 1, args: "/bin/zsh -c npm run dev" },
    });
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([serverPort]);
  });

  it("takes a silent ps exit 1 as processes that are gone", async () => {
    processTable(sockets, { 123: { ...server, ppid: 1 } }, (args) =>
      args.includes("pid=,ppid=") ? Object.assign(new Error("exit 1"), { code: 1, stdout: "", stderr: "" }) : undefined,
    );
    expect((await harness.experimental_call("scan", { roots })).ports).toEqual([]);
  });

  it.each([
    ["refuses the call", { code: 1, stdout: "", stderr: "ps: process id too large: 99999999999\n" }],
    ["times out", { code: null, killed: true, signal: "SIGTERM", stdout: "", stderr: "" }],
    ["is missing", { code: "ENOENT" }],
  ])("fails the scan when the parent lookup %s", async (_, failure) => {
    processTable(sockets, { 123: { ...server, ppid: 1 } }, (args) =>
      args.includes("pid=,ppid=") ? Object.assign(new Error("ps failed"), failure) : undefined,
    );
    await expect(harness.experimental_call("scan", { roots })).rejects.toThrow();
  });

  it("never signals the agent, in a workspace-wide close either", async () => {
    processTable(agentSockets, {
      700: { ppid: 600, args: WORKER },
      789: agent,
      123: { ...server, ppid: 789 },
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const close = (port: number, pid: number) =>
        harness.experimental_call("closeOwnedPorts", {
          root: roots[0],
          threadId: "thr_owner",
          ports: [{ port, pid }],
          scope: "workspace",
        });
      expect(await close(52603, 789)).toEqual({ signalled: [], skipped: [52603], failed: [] });
      expect(kill).not.toHaveBeenCalled();
      expect(await close(3000, 123)).toEqual({ signalled: [3000], skipped: [], failed: [] });
      expect(kill.mock.calls).toEqual([[123, "SIGTERM"]]);
    } finally {
      kill.mockRestore();
    }
  });

  it("reuses the command of a parent that listens itself", async () => {
    // The ACP bridge worker listens for its tool bridge.
    const listening = `${agentSockets}bb\\x20Nightly 700 u 30u IPv4 0x5 0t0 TCP 127.0.0.1:54000 (LISTEN)\n`;
    processTable(listening, {
      700: { ppid: 600, args: WORKER, cwd: "/workspace/app" },
      789: agent,
      123: { ...server, ppid: 789 },
    });
    const result = await harness.experimental_call("scan", { roots });
    expect(result.ports).toEqual([serverPort]);
    expect(psCalls("pid=,args=")).toHaveLength(1);
  });

  describe("on Linux", () => {
    const linuxSockets = `${agentSockets}node 321 u 1u IPv4 0x6 0t0 TCP 127.0.0.1:6000 (LISTEN)\n`;
    const table = { 789: agent, 123: server, 321: { args: "node gone.js" } };
    beforeEach(() => {
      mocks.platform.mockReturnValue("linux");
      for (const pid of [789, 123, 321]) mocks.proc.set(`/proc/${pid}/cwd`, "/workspace/app");
      for (const pid of [789, 123]) mocks.proc.set(`/proc/${pid}/environ`, "BB_THREAD_ID=thr_owner\0PATH=/bin\0");
      mocks.proc.set("/proc/789/stat", "789 (claude) S 700 700 700 0 -1 4194304 1500 0 0 0");
      mocks.proc.set("/proc/123/stat", "123 (node) S 789 123 123 0 -1 4194304 900 0 0 0");
      mocks.proc.set(
        "/proc/700/cmdline",
        "node\0/home/u/.bb/app/host-daemon/dist/bb-provider-bridge-worker.mjs\0/home/u/.bb/plugin-host-artifacts/provider-claude-code/abc/host.mjs\0provider-claude-code\0/home/u/.bb/plugins/provider-claude-code/bridge-data\0",
      );
      mocks.proc.set("/proc/789/cmdline", "claude\0--output-format\0stream-json\0");
    });

    it("reads parents from /proc, and drops a listener whose stat is gone", async () => {
      processTable(linuxSockets, table);
      const result = await harness.experimental_call("scan", { roots });
      expect(result.ports).toEqual([serverPort]);
      expect(psCalls("pid=,ppid=")).toEqual([]);
      expect(psCalls("pid=,args=")).toHaveLength(1);
    });

    it("still lists ports when ps cannot look processes up", async () => {
      // BusyBox ps has no -p: commands, parents and owners all come from /proc.
      processTable(linuxSockets, table, () => Object.assign(new Error("ps: invalid option -- p"), { code: 1 }));
      const result = await harness.experimental_call("scan", { roots });
      const { processStartedAt: _, ...listed } = serverPort;
      expect(result.ports).toEqual([listed]);
    });
  });
});

describe("host pull request lookup", () => {
  it("reads each PR with gh and skips the ones it cannot see", async () => {
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      if (command !== "gh") throw new Error(`Unexpected command ${command}`);
      if (args[2]!.endsWith("/2")) throw new Error("Could not resolve to a PullRequest");
      return {
        stdout: JSON.stringify({
          number: 1,
          title: "Fix",
          state: "OPEN",
          isDraft: true,
          url: "https://github.com/new/r/pull/1",
        }),
      };
    });
    const result = await harness.experimental_call("pullRequests", {
      urls: ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"],
    });
    expect(result.pullRequests).toEqual([
      { url: "https://github.com/o/r/pull/1", number: 1, title: "Fix", state: "draft" },
    ]);
  });
});
