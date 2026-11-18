import { execFile } from "node:child_process";
import { readFile, readlink, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { closeOwnedPortProcesses } from "./close-owned-ports";
import { portScanContract, type PortRoot } from "./port-scan-contract";
import { attribute, parseCwds, parseDockerRows, parseListeners } from "./port-scan";
import type { OpenPort, ThreadPullRequest } from "./contract";
import {
  isAgentRuntime,
  isBbInternalListener,
  parseParentPids,
  parseProcessCommands,
  parseStatParent,
} from "./port-processes";
import { macProcessEnvironment, threadIdFromEnvironment } from "./port-ownership";
import { parseGhPullRequest } from "./pull-requests";

const exec = promisify(execFile);

async function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    return (await exec(command, args, { signal, timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (signal.aborted) throw error;
    const result = error as { code?: unknown; stdout?: string };
    // lsof returns 1 for no matches and can report partial results.
    if (command === "lsof" && (result.code === 1 || result.stdout?.trim())) return result.stdout ?? "";
    throw error;
  }
}

async function scanPorts(roots: PortRoot[], signal: AbortSignal) {
  if (!roots.length) return { ports: [] };
  if (platform() !== "darwin" && platform() !== "linux") {
    throw new Error("Port discovery requires macOS or Linux");
  }
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => ({
      ...root,
      path: await realpath(root.path).catch(() => root.path),
    })),
  );
  const listeners = parseListeners(await run("lsof", ["-nP", "+c", "0", "-iTCP", "-sTCP:LISTEN"], signal));
  const pids = [...new Set(listeners.map((listener) => listener.pid))];
  const commands = new Map<number, string>();
  for (let start = 0; start < pids.length; start += 100) {
    try {
      const output = await run(
        "ps",
        ["ww", "-p", pids.slice(start, start + 100).join(","), "-o", "pid=,args="],
        signal,
      );
      for (const [pid, command] of parseProcessCommands(output)) commands.set(pid, command);
    } catch (error) {
      if (signal.aborted) throw error;
      // Processes can exit between the socket and command scans.
    }
  }
  const cwds = new Map<number, string>();
  if (platform() === "linux") {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          cwds.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          /* Exited or inaccessible. */
        }
      }),
    );
  } else {
    for (let start = 0; start < pids.length; start += 100) {
      const batch = await run(
        "lsof",
        ["-a", "-p", pids.slice(start, start + 100).join(","), "-d", "cwd", "-Fn"],
        signal,
      );
      for (const [pid, cwd] of parseCwds(batch)) cwds.set(pid, cwd);
    }
  }
  const ports = new Map<string, OpenPort & { environmentId: string }>();
  const ownerByPid = new Map<number, string | undefined>();
  const startByPid = new Map<number, string | undefined>();
  async function processStart(pid: number): Promise<string | undefined> {
    if (startByPid.has(pid)) return startByPid.get(pid);
    let startedAt: string | undefined;
    try {
      const value = (await run("ps", ["-p", String(pid), "-o", "lstart="], signal)).trim();
      if (Number.isFinite(Date.parse(value))) startedAt = value;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    startByPid.set(pid, startedAt);
    return startedAt;
  }
  async function ownerThread(pid: number): Promise<string | undefined> {
    if (ownerByPid.has(pid)) return ownerByPid.get(pid);
    let owner: string | undefined;
    try {
      if (platform() === "linux") {
        owner = threadIdFromEnvironment(await readFile(`/proc/${pid}/environ`, "utf8"), "nul");
      } else {
        const command = commands.get(pid);
        if (command) {
          const full = await run("ps", ["eww", "-p", String(pid), "-o", "command="], signal);
          owner = threadIdFromEnvironment(macProcessEnvironment(command, full), "space");
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // Missing metadata means workspace-only attribution.
    }
    ownerByPid.set(pid, owner);
    return owner;
  }
  async function psRows(args: string[]): Promise<string> {
    try {
      return await run("ps", args, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = error as { code?: unknown; stderr?: string };
      // ps exits 1 in silence when none of the pids exist anymore. With a
      // message on stderr it refused the call, which is no answer.
      if (failure.code === 1 && !failure.stderr?.trim()) return "";
      throw error;
    }
  }
  /** Parent pid of each process that still exists. */
  async function parentPids(pids: number[]): Promise<Map<number, number>> {
    const parents = new Map<number, number>();
    if (platform() === "linux") {
      await Promise.all(
        pids.map(async (pid) => {
          try {
            const parent = parseStatParent(await readFile(`/proc/${pid}/stat`, "utf8"));
            if (parent !== undefined) parents.set(pid, parent);
          } catch {
            /* Exited or inaccessible. */
          }
        }),
      );
      return parents;
    }
    for (let start = 0; start < pids.length; start += 100) {
      const rows = await psRows(["-o", "pid=,ppid=", "-p", pids.slice(start, start + 100).join(",")]);
      for (const [pid, parent] of parseParentPids(rows)) parents.set(pid, parent);
    }
    return parents;
  }
  /** Command line of each process that still exists. */
  async function processCommands(pids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    if (platform() === "linux") {
      await Promise.all(
        pids.map(async (pid) => {
          try {
            const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
            found.set(pid, cmdline.replaceAll("\0", " ").trim());
          } catch {
            /* Exited or inaccessible. */
          }
        }),
      );
      return found;
    }
    for (let start = 0; start < pids.length; start += 100) {
      const rows = await psRows(["ww", "-p", pids.slice(start, start + 100).join(","), "-o", "pid=,args="]);
      for (const [pid, command] of parseProcessCommands(rows)) found.set(pid, command);
    }
    return found;
  }
  /** The agent itself, and any process whose parent could not be read. */
  async function pidsToLeaveOut(pids: number[]): Promise<Set<number>> {
    const leaveOut = new Set<number>();
    if (!pids.length) return leaveOut;
    const parents = await parentPids(pids);
    // A parent that listens itself (the ACP worker does) is already known.
    const unknown = [...new Set(parents.values())].filter((parent) => parent > 1 && !commands.has(parent));
    const parentCommands = new Map([...commands, ...(unknown.length ? await processCommands(unknown) : [])]);
    for (const pid of pids) {
      const parent = parents.get(pid);
      // No parent row: the process exited after lsof listed it.
      if (parent === undefined) leaveOut.add(pid);
      else if (parent > 1) {
        const command = parentCommands.get(parent);
        // No command: the parent exited between the two lookups. Listing the
        // process now could put a stop button on an agent; the next scan
        // sees it under its new parent.
        if (command === undefined || isAgentRuntime(command)) leaveOut.add(pid);
      }
    }
    return leaveOut;
  }
  function add(cwd: string, detail: OpenPort) {
    const owner = attribute(cwd, canonicalRoots);
    if (!owner) return;
    const path = canonicalRoots.find((root) => root.environmentId === owner)!.path;
    // Multiple BB environments can refer to the same checkout.
    for (const root of canonicalRoots.filter((root) => root.path === path)) {
      const key = `${root.environmentId}:${detail.port}`;
      // Docker enriches an observed listener; it must not replace its PID,
      // bind address, or thread ownership with less specific metadata.
      ports.set(key, { environmentId: root.environmentId, ...detail, ...ports.get(key) });
    }
  }
  const candidates = listeners.flatMap((listener) => {
    if (isBbInternalListener(listener.processName, commands.get(listener.pid))) return [];
    const cwd = cwds.get(listener.pid);
    return cwd && attribute(cwd, canonicalRoots) ? [{ listener, cwd }] : [];
  });
  const leaveOut = await pidsToLeaveOut([...new Set(candidates.map(({ listener }) => listener.pid))]);
  for (const { listener, cwd } of candidates) {
    if (leaveOut.has(listener.pid)) continue;
    const ownerThreadId = await ownerThread(listener.pid);
    const processStartedAt = ownerThreadId ? await processStart(listener.pid) : undefined;
    add(cwd, {
      ...listener,
      source: "process",
      ...(ownerThreadId ? { ownerThreadId } : {}),
      ...(processStartedAt ? { processStartedAt } : {}),
    });
  }
  try {
    const output = await run(
      "docker",
      [
        "ps",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      signal,
    );
    for (const row of parseDockerRows(output)) {
      const cwd = await realpath(row.workingDir).catch(() => row.workingDir);
      for (const binding of row.ports)
        add(cwd, {
          ...binding,
          source: "docker",
          container: row.name,
          ...(row.service ? { service: row.service } : {}),
        });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    // Docker is optional; process listeners still apply when it is absent.
  }
  return { ports: [...ports.values()] };
}

// GUI-launched daemons often miss the shell PATH where Homebrew installs gh.
const GH_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

async function viewPullRequests(urls: string[], signal: AbortSignal) {
  const pullRequests: ThreadPullRequest[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, urls.length) }, async () => {
      while (next < urls.length) {
        const url = urls[next++]!;
        try {
          const { stdout } = await exec("gh", ["pr", "view", url, "--json", "number,title,state,isDraft,url"], {
            signal,
            timeout: 10_000,
            env: { ...process.env, PATH: GH_PATH },
          });
          const pullRequest = parseGhPullRequest(stdout);
          // Keyed by the URL the thread printed, even if the repo was renamed.
          if (pullRequest) pullRequests.push({ ...pullRequest, url });
        } catch (error) {
          if (signal.aborted) throw error;
          // Missing gh, no access, or a deleted PR: the caller lists it without status.
        }
      }
    }),
  );
  return { pullRequests };
}

export default experimental_defineHostEntry({
  contract: portScanContract,
  handlers: {
    async timeZone() {
      return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null };
    },
    async resolveRoots({ roots }) {
      return {
        roots: await Promise.all(
          roots.map(async (root) => ({
            environmentId: root.environmentId,
            path: await realpath(root.path).catch(() => null),
          })),
        ),
      };
    },
    async scan({ roots }, { signal }) {
      return scanPorts(roots, signal);
    },
    async pullRequests({ urls }, { signal }) {
      return viewPullRequests(urls, signal);
    },
    async closeOwnedPorts({ root, threadId, ports, scope }, { signal }) {
      return closeOwnedPortProcesses(
        threadId,
        ports,
        async () => (await scanPorts([root], signal)).ports.filter((port) => port.environmentId === root.environmentId),
        (pid) => {
          signal.throwIfAborted();
          process.kill(pid, "SIGTERM");
        },
        scope,
      );
    },
  },
});
