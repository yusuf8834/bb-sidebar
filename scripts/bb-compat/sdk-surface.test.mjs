import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { diffSurfaces, readSurface, renderMarkdown, surfaceProblems } from "./sdk-surface.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake SDK package with an app entry and a server entry. */
function fixture({ app, server }) {
  const root = mkdtempSync(join(tmpdir(), "bb-compat-surface-test-"));
  roots.push(root);
  const dir = join(root, "node_modules", "@get-bb", "plugin-sdk");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@get-bb/plugin-sdk",
      version: "0.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts" }, "./app": { types: "./app.d.ts" } },
    }),
  );
  writeFileSync(join(dir, "app.d.ts"), app);
  writeFileSync(join(dir, "index.d.ts"), server);
  return root;
}

const OLD_APP = `
type PluginSidebarThreadIndicator = "none" | "draft" | "goal";
interface PluginSidebarThreadActivity { workflows: number; goals: number; }
interface PluginSidebarThread {
  id: string;
  indicator: PluginSidebarThreadIndicator;
  environment: { id: string; path: string } | null;
  activity: PluginSidebarThreadActivity;
}
interface PluginComposerThreadRowStatus { label: string; }
type PluginSidebarThreadRowStatus = PluginComposerThreadRowStatus;
declare const useSdk: () => void;
declare const experimental_ComposerView: () => void;
export { useSdk, experimental_ComposerView };
export type { PluginSidebarThread, PluginSidebarThreadActivity, PluginSidebarThreadIndicator, PluginSidebarThreadRowStatus };
`;

const NEW_APP = `
type ThreadParentNotifications = "auto" | "stuck" | "off";
type PluginSidebarThreadIndicator = "none" | "draft";
interface PluginSidebarThreadActivity { workflows: number; agents: number; }
interface PluginSidebarThread {
  id: string;
  indicator: PluginSidebarThreadIndicator;
  environment: { id: string; path: string; kind?: string } | null;
  activity: PluginSidebarThreadActivity;
  parentNotifications: ThreadParentNotifications;
  note?: string;
}
interface PluginComposerThreadRowStatus { label: string; }
type PluginSidebarThreadRowStatus = PluginComposerThreadRowStatus;
declare const useSdk: () => void;
declare const experimental_resolveThreadStatus: (thread: PluginSidebarThread) => string;
export { useSdk, experimental_resolveThreadStatus };
export type { PluginSidebarThread, PluginSidebarThreadActivity, PluginSidebarThreadIndicator, PluginSidebarThreadRowStatus };
`;

const server = (activity) => `
interface ThreadRow { id: string; activity: { ${activity} } }
interface PluginBbSdk { threads: { list(): Promise<ThreadRow[]> } }
declare function definePlugin(): void;
export { definePlugin };
export type { PluginBbSdk };
`;

test("reports added and removed exports, fields and union members", () => {
  const before = readSurface(
    fixture({ app: OLD_APP, server: server("activeWorkflowCount: number; activeGoalCount: number;") }),
  );
  const after = readSurface(fixture({ app: NEW_APP, server: server("activeWorkflowCount: number;") }));
  const diff = diffSurfaces(before, after);

  assert.deepEqual(diff.exports.app, {
    added: ["experimental_resolveThreadStatus"],
    removed: ["experimental_ComposerView"],
  });
  assert.deepEqual(diff.exports.server, { added: [], removed: [] });
  assert.deepEqual(diff.types.PluginSidebarThreadIndicator, {
    status: "compared",
    added: [],
    removed: ['"goal"'],
    changed: [],
  });
  assert.deepEqual(diff.types.PluginSidebarThreadActivity.removed, ["goals"]);
  assert.deepEqual(
    diff.types.PluginSidebarThreadActivity.added.map(({ name, optional }) => [name, optional]),
    [["agents", false]],
  );
  assert.deepEqual(
    diff.types.PluginSidebarThread.added.map(({ name, optional }) => ({ name, optional })),
    [
      { name: "parentNotifications", optional: false },
      { name: "note", optional: true },
    ],
  );
  assert.equal(diff.types.PluginSidebarThreadRowStatus.changed.length, 0);
  assert.deepEqual(surfaceProblems(diff), []);

  const markdown = renderMarkdown(diff, { from: "0.6.94", to: "0.6.132" });
  assert.match(markdown, /SDK 0\.6\.94 → 0\.6\.132/);
  assert.match(markdown, /added \(1\): `experimental_resolveThreadStatus`/);
  assert.match(markdown, /`parentNotifications` \(required: `"auto" \| "stuck" \| "off"`\)/);
  assert.match(markdown, /`note` \(optional: `string \| undefined`\)/);
  assert.match(markdown, /changed `indicator`: members removed `"goal"`/);
  assert.match(markdown, /changed `environment`: fields added `kind` \(`\?string \| undefined`\)/);
  // A named interface prints as its name; its member changes must still show.
  assert.match(markdown, /changed `activity`: fields added `agents` \(`number`\); fields removed `goals`/);
  assert.match(markdown, /`server thread row`:\n {2}- changed `activity`: fields removed `activeGoalCount`/);
  assert.match(markdown, /`PluginSidebarThreadRowStatus`: unchanged\./);
});

test("a tracked type that cannot be resolved is a problem, not 'no changes'", () => {
  const noServerSdk = "declare function definePlugin(): void;\nexport { definePlugin };\n";
  const surface = readSurface(fixture({ app: OLD_APP, server: noServerSdk }));
  assert.equal(surface.types["server thread row"], null);
  assert.deepEqual(surfaceProblems(diffSurfaces(surface, surface)), ["server thread row: missing in both"]);

  const anyActivity = OLD_APP.replace(
    "interface PluginSidebarThreadActivity { workflows: number; goals: number; }",
    "type PluginSidebarThreadActivity = any;",
  );
  const loose = readSurface(fixture({ app: anyActivity, server: server("activeWorkflowCount: number;") }));
  assert.deepEqual(loose.types.PluginSidebarThreadActivity, { kind: "unresolved" });
  assert.deepEqual(surfaceProblems(diffSurfaces(loose, loose)), ["PluginSidebarThreadActivity: unresolved"]);
});

test("a type removed from the SDK is reported as removed", () => {
  const before = readSurface(fixture({ app: OLD_APP, server: server("id: string;") }));
  const withoutActivity = OLD_APP.replace(", PluginSidebarThreadActivity", "");
  const after = readSurface(fixture({ app: withoutActivity, server: server("id: string;") }));
  const diff = diffSurfaces(before, after);
  assert.deepEqual(diff.types.PluginSidebarThreadActivity, { status: "removed" });
  assert.match(renderMarkdown(diff, { from: "1.0.0", to: "1.0.1" }), /`PluginSidebarThreadActivity`: removed\./);
});

test("the same version renders a short note", () => {
  const surface = readSurface(fixture({ app: OLD_APP, server: server("id: string;") }));
  assert.match(
    renderMarkdown(diffSurfaces(surface, surface), { from: "1.0.0", to: "1.0.0" }),
    /Same SDK version as the pin/,
  );
});
