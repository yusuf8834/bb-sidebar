import { describe, expect, it } from "vitest";
import {
  isAgentRuntime,
  isBbInternalListener,
  parseParentPids,
  parseProcessCommands,
  parseStatParent,
} from "./port-processes";

describe("BB internal port filtering", () => {
  it.each([
    [
      "bb Nightly",
      "/Applications/bb Nightly.app/Contents/MacOS/bb Nightly /Applications/bb Nightly.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs",
    ],
    ["node", "/usr/bin/node /opt/node_modules/bb-app/server/dist/index.js"],
    ["bb", "/usr/bin/bb"],
    ["bb Nightly", ""],
  ])("excludes the BB runtime %s", (name, command) => {
    expect(isBbInternalListener(name, command)).toBe(true);
  });

  it.each([
    ["git-history", "git-history"],
    ["node", "/usr/bin/node /workspace/server.js"],
    ["python3", "python3 -m http.server 49631"],
    ["bb-api", "bb-api"],
    ["bb Nightly", "/Applications/bb Nightly.app/Contents/MacOS/bb Nightly /workspace/server.js"],
  ])("keeps the user server %s", (name, command) => {
    expect(isBbInternalListener(name, command)).toBe(false);
  });

  it("reads commands containing spaces without losing the executable path", () => {
    expect(
      parseProcessCommands("  123 /Applications/bb Nightly.app/Contents/MacOS/bb Nightly\n  456 node server.js\n"),
    ).toEqual(
      new Map([
        [123, "/Applications/bb Nightly.app/Contents/MacOS/bb Nightly"],
        [456, "node server.js"],
      ]),
    );
  });
});

const BB = "/Applications/bb Nightly.app/Contents";
const DIST = `${BB}/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist`;
/** A provider bridge worker's command line as bb starts it on macOS. */
function bridgeWorker(plugin: string): string {
  return `${BB}/MacOS/bb Nightly --use-system-ca --use-env-proxy ${DIST}/bb-provider-bridge-worker.mjs /Users/ysf/.bb/plugin-host-artifacts/${plugin}/d96f00ea2bf07b28110d5a0cd1c3c8b3dc7a4b88903962dfb0d0f728fe692353/host.mjs ${plugin} /Users/ysf/.bb/plugins/${plugin}/bridge-data`;
}

describe("agent runtime detection", () => {
  it.each([
    ["Claude Code", bridgeWorker("provider-claude-code")],
    ["a Claude account", bridgeWorker("claude-accounts")],
    ["Codex", bridgeWorker("provider-codex")],
    ["an ACP agent", bridgeWorker("provider-acp")],
    [
      "Linux",
      "node /home/u/.bb/app/host-daemon/dist/bb-provider-bridge-worker.mjs /home/u/.bb/plugin-host-artifacts/provider-claude-code/abc/host.mjs provider-claude-code /home/u/.bb/plugins/provider-claude-code/bridge-data",
    ],
    ["a worker without arguments", "node /opt/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs"],
  ])("takes a child of the bridge worker for %s as the agent", (_, parentCommand) => {
    expect(isAgentRuntime(parentCommand)).toBe(true);
  });

  it.each([
    ["the host daemon, which starts terminals", `${BB}/MacOS/bb Nightly ${DIST}/daemon-bundle.mjs`],
    [
      "a plugin host worker",
      `${BB}/MacOS/bb Nightly ${DIST}/bb-plugin-host-worker.mjs /Users/ysf/.bb/plugin-host-artifacts/environment-git-worktree/abc/host.mjs environment-git-worktree`,
    ],
    ["launchd", "/sbin/launchd"],
    ["a shell", "/bin/zsh -c npm run dev"],
    ["the agent itself", "/Users/ysf/.local/bin/claude --output-format stream-json --verbose"],
    ["Codex itself", "/Users/ysf/.local/bin/codex app-server -c model=gpt"],
    // Its helper, localharness_external, listens too and stays listed.
    ["Antigravity's adapter", "/Users/ysf/.local/share/antigravity-acp/agy_acp_server.par"],
    ["an unread command", ""],
    ["a file that only starts with the worker's name", "node /opt/dist/bb-provider-bridge-worker.mjs.bak"],
  ])("keeps a process started by %s", (_, parentCommand) => {
    expect(isAgentRuntime(parentCommand)).toBe(false);
  });

  it("reads parent pids from ps and skips rows that are not two numbers", () => {
    expect(parseParentPids("    1     0\n45914 45801\n57264 57211\n")).toEqual(
      new Map([
        [1, 0],
        [45914, 45801],
        [57264, 57211],
      ]),
    );
    expect(parseParentPids("123 node app.js\n\n12 x\n")).toEqual(new Map());
  });

  it("reads the parent pid from /proc stat after the process name", () => {
    expect(parseStatParent("4242 (node) S 4100 4242 4242 0 -1 4194304 1500 0 0 0")).toBe(4100);
    expect(parseStatParent("77 (tmux: server (1)) S 1 77 77 0 -1 4194560 300 0 0 0")).toBe(1);
    expect(parseStatParent("")).toBeUndefined();
    expect(parseStatParent("4242 (node")).toBeUndefined();
    expect(parseStatParent("4242 (node) S 41")).toBeUndefined();
  });
});
