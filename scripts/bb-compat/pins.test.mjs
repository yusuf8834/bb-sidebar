import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  guardChangedFiles,
  guardLockfile,
  guardPackageJson,
  pinsFromResolved,
  setDevDependencyPins,
  topLevelValueSpan,
} from "./pins.mjs";

const original = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
const devDependencies = JSON.parse(original).devDependencies;
const resolved = {
  bbApp: "9.9.0",
  sdk: "9.9.1",
  shimPins: { "@radix-ui/react-dialog": "^9.0.0", "tailwind-merge": "^9.1.0" },
};
const pins = pinsFromResolved(resolved);
const allowed = Object.keys(pins);

test("setting pins changes only those devDependencies values, byte for byte elsewhere", () => {
  const bumped = setDevDependencyPins(original, pins);
  const before = JSON.parse(original);
  const after = JSON.parse(bumped);
  assert.equal(after.devDependencies["bb-app"], "9.9.0");
  assert.equal(after.devDependencies["@get-bb/plugin-sdk"], "9.9.1");
  assert.equal(after.devDependencies["@radix-ui/react-dialog"], "^9.0.0");
  assert.equal(after.devDependencies["tailwind-merge"], "^9.1.0");
  for (const [name, value] of Object.entries(before.devDependencies)) {
    if (!allowed.includes(name)) assert.equal(after.devDependencies[name], value, name);
  }
  const changedLines = bumped.split("\n").filter((line, index) => line !== original.split("\n")[index]);
  assert.equal(changedLines.length, 4);
  assert.deepEqual(guardPackageJson(original, bumped, allowed), []);
});

test("the pin setter never adds a key", () => {
  assert.throws(() => setDevDependencyPins(original, { "left-pad": "1.0.0" }), /exactly once/);
});

test("pins from npm must be plain versions", () => {
  assert.throws(() => pinsFromResolved({ ...resolved, bbApp: "1.0.0; rm -rf /" }), /strict semver/);
  assert.throws(
    () => pinsFromResolved({ ...resolved, shimPins: { "tailwind-merge": "file:../evil" } }),
    /strict semver/,
  );
  assert.throws(() => pinsFromResolved({ ...resolved, shimPins: { "../evil": "^1.0.0" } }), /package name/);
});

test("the guard rejects any change outside devDependencies", () => {
  const bumped = setDevDependencyPins(original, pins);
  // Regex edits, so the fixture keeps working when the real values change.
  const cases = {
    engines: bumped.replace(/("bb": ">=)[^"]+"/, '$19.9.0"'),
    dependencies: bumped.replace(/("zod": ")[^"]+"/, '$1^9.9.9"'),
    allowScripts: bumped.replace(/("lefthook@[^"]+": )true/, "$1false"),
    version: bumped.replace(/("version": ")[^"]+"/, '$19.9.9"'),
  };
  for (const [key, text] of Object.entries(cases)) {
    assert.notEqual(text, bumped, `${key} fixture must change the text`);
    assert.deepEqual(guardPackageJson(original, text, allowed), [
      `package.json changed outside devDependencies: ${key}`,
    ]);
  }
  const reformatted = bumped.replace(
    '"keywords": ["bb-plugin", "sidebar", "threads", "inbox", "productivity"]',
    '"keywords": [\n    "bb-plugin",\n    "sidebar",\n    "threads",\n    "inbox",\n    "productivity"\n  ]',
  );
  assert.deepEqual(guardPackageJson(original, reformatted, allowed), [
    "package.json changed outside devDependencies (formatting or key order)",
  ]);
});

test("the guard rejects devDependencies changes bb did not ask for", () => {
  const extra = setDevDependencyPins(original, { ...pins, vitest: "^9.0.0" });
  assert.deepEqual(guardPackageJson(original, extra, allowed), [
    "devDependencies.vitest changed but bb did not ask for it",
  ]);
  const tampered = original.replace(`"bb-app": "${devDependencies["bb-app"]}"`, '"bb-app": "github:evil/bb"');
  assert.match(guardPackageJson(original, tampered, allowed).join("\n"), /strict semver/);
  const added = original.replace('"vitest": ', '"left-pad": "1.0.0",\n    "vitest": ');
  assert.deepEqual(guardPackageJson(original, added, allowed), [
    "devDependencies keys were added, removed or reordered",
    "devDependencies.left-pad changed but bb did not ask for it",
  ]);
  assert.deepEqual(guardPackageJson(original, "{", allowed).length, 1);
});

test("topLevelValueSpan ignores nested keys and braces inside strings", () => {
  const text = '{\n  "a": { "devDependencies": { "x": "1" } },\n  "s": "} {",\n  "devDependencies": { "y": "2" }\n}\n';
  const [start, end] = topLevelValueSpan(text, "devDependencies");
  assert.equal(text.slice(start, end), '{ "y": "2" }');
  assert.equal(topLevelValueSpan(text, "missing"), null);
});

test("only package.json and package-lock.json may change", () => {
  assert.deepEqual(guardChangedFiles(" M package.json\0 M package-lock.json\0"), []);
  assert.deepEqual(guardChangedFiles(""), []);
  assert.deepEqual(guardChangedFiles(" M package.json\0 M src/lifecycle.ts\0?? scripts/x.mjs\0"), [
    "changed file not allowed: src/lifecycle.ts (M)",
    "changed file not allowed: scripts/x.mjs (??)",
  ]);
  assert.deepEqual(guardChangedFiles(" D package-lock.json\0"), ["deleted: package-lock.json"]);
  assert.deepEqual(guardChangedFiles("R  package.json\0old.json\0"), ["renamed or copied: old.json -> package.json"]);
});

const lock = (root, packages = {}) =>
  JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, packages: { "": root, ...packages } });

test("the lockfile root must match package.json and packages must come from npm", () => {
  const manifest = JSON.stringify({ devDependencies: { "bb-app": "2.0.0" } });
  const root = { name: "p", engines: { bb: ">=1.0.0" }, devDependencies: { "bb-app": "1.0.0" } };
  const ok = {
    "node_modules/bb-app": {
      version: "2.0.0",
      resolved: "https://registry.npmjs.org/bb-app/-/bb-app-2.0.0.tgz",
      integrity: "sha512-x",
    },
    "node_modules/bb-app/node_modules/npm/node_modules/abbrev": { version: "1.0.0", inBundle: true },
  };
  const next = { ...root, devDependencies: { "bb-app": "2.0.0" } };
  assert.deepEqual(guardLockfile(lock(root), lock(next, ok), manifest), []);
  assert.deepEqual(guardLockfile(lock(root), lock({ ...next, engines: { bb: ">=2.0.0" } }, ok), manifest), [
    "lockfile root engines changed",
  ]);
  assert.deepEqual(guardLockfile(lock(root), lock(root, ok), manifest), [
    "lockfile root devDependencies do not match package.json",
  ]);
  const evil = {
    "node_modules/x": { version: "1.0.0", resolved: "https://evil.example/x.tgz", integrity: "sha512-x" },
  };
  assert.deepEqual(guardLockfile(lock(root), lock(next, evil), manifest), [
    "node_modules/x does not resolve from https://registry.npmjs.org/",
  ]);
  const unsigned = { "node_modules/x": { version: "1.0.0", resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } };
  assert.deepEqual(guardLockfile(lock(root), lock(next, unsigned), manifest), [
    "node_modules/x has no sha512 integrity",
  ]);
});

test("the repository's own lockfile passes the lockfile guard against itself", () => {
  const lockText = readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8");
  assert.deepEqual(guardLockfile(lockText, lockText, original), []);
});
