/** Match BB's own runtime, never all descendants of a BB process. */
export function isBbInternalListener(processName: string, command = ""): boolean {
  // BB host/provider workers can run under node or the desktop executable.
  if (/[/\\]bb-app[/\\](?:host-daemon|server)[/\\]dist[/\\]/.test(command)) return true;
  if (/[/\\]bb-(?:provider-bridge|plugin-host)-worker\.mjs(?:\s|$)/.test(command)) return true;

  const bbName = /^bb(?: nightly| beta| helper(?: \([^)]+\))?)?$/i.test(processName);
  if (!bbName) return false;
  if (!command) return true;
  // A BB executable running a workspace script is still a user server.
  const executable = command.match(/^.*?[/\\]Contents[/\\]MacOS[/\\]bb(?: Nightly| Beta)?(?=\s|$)/i)?.[0];
  const args = executable ? command.slice(executable.length).trim() : command.replace(/^\S+\s*/, "").trim();
  return !args || args.startsWith("--type=");
}

export function parseProcessCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}

const BRIDGE_WORKER = /[/\\]bb-provider-bridge-worker\.mjs(?:\s|$)/;

/**
 * bb starts a thread's agent (claude, codex app-server, pi, an ACP adapter) as
 * the direct child of a provider bridge worker. That process is the agent, not
 * a server it started. What the agent starts is its own child and stays listed.
 */
export function isAgentRuntime(parentCommand: string): boolean {
  return BRIDGE_WORKER.test(parentCommand);
}

/** `ps -o pid=,ppid=` rows. */
export function parseParentPids(output: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/**
 * The parent pid in a Linux `/proc/<pid>/stat` line. The process name sits in
 * parentheses and can itself contain spaces and parentheses, so the fields are
 * read after the last ")": state, then ppid.
 */
export function parseStatParent(stat: string): number | undefined {
  const nameEnd = stat.lastIndexOf(")");
  if (nameEnd < 0) return undefined;
  // More fields always follow the ppid; a line cut off inside it is no answer.
  const match = stat.slice(nameEnd + 1).match(/^\s+\S+\s+(\d+)\s/);
  return match ? Number(match[1]) : undefined;
}
