import assert from "node:assert/strict";
import { test } from "node:test";
import { installArgs } from "./channel.mjs";
import { assertSemver, compareStable, fence } from "./lib.mjs";
import { decideHost, floorVersion, parseTypesCheck, sdkLiterals } from "./resolve-bb.mjs";

// Real output of bb-app 0.48.0's `bb plugin types --check` on this package.json.
const OUTPUT_0_48 = `This plugin uses the npm package @get-bb/plugin-sdk; pin is 0.6.132, host is 0.6.94.
Set "@get-bb/plugin-sdk" to 0.6.94 in devDependencies and re-run npm install (\`bb plugin types\` does it for you).
Set "@radix-ui/react-context-menu" to ^2.3.3 in devDependencies — the version this bb shims at runtime (\`bb plugin types\` does it for you).
Set "tailwind-merge" to ^3.4.0 in devDependencies — the version this bb shims at runtime (\`bb plugin types\` does it for you).
`;
// Real output when the pins already match.
const OUTPUT_CURRENT = `This plugin uses the npm package @get-bb/plugin-sdk; pin is 0.6.132, host is 0.6.132.
The declarations are in node_modules/@get-bb/plugin-sdk/bundled-types/ — read them for exact signatures.
`;

test("parses the SDK version and shim pins bb asks for", () => {
  const parsed = parseTypesCheck(OUTPUT_0_48);
  assert.equal(parsed.pin, "0.6.132");
  assert.equal(parsed.host, "0.6.94");
  assert.deepEqual(parsed.unknown, []);
  assert.deepEqual(decideHost(parsed, ["0.6.94", "0.6.94"]), {
    sdk: "0.6.94",
    shimPins: { "@radix-ui/react-context-menu": "^2.3.3", "tailwind-merge": "^3.4.0" },
    crossChecked: true,
  });
  assert.deepEqual(decideHost(parseTypesCheck(OUTPUT_CURRENT), ["0.6.132"]), {
    sdk: "0.6.132",
    shimPins: {},
    crossChecked: true,
  });
});

test("fails closed on unknown output, disagreement, or a missing host version", () => {
  const moved = `${OUTPUT_CURRENT}Set "@get-bb/plugin-sdk" to 0.6.200 in dependencies (Git installs omit devDependencies).\n`;
  assert.throws(() => decideHost(parseTypesCheck(moved), []), /Unrecognised/);
  assert.throws(() => decideHost(parseTypesCheck(OUTPUT_0_48), ["0.6.95"]), /bundle says 0\.6\.95/);
  assert.throws(() => decideHost(parseTypesCheck(OUTPUT_0_48), ["0.6.94", "0.6.95"]), /several SDK versions/);
  assert.throws(() => decideHost(parseTypesCheck("Nothing useful\n"), []), /Unrecognised/);
  assert.throws(() => decideHost(parseTypesCheck(""), []), /did not report/);
  const evil = OUTPUT_CURRENT.replace("host is 0.6.132", "host is 0.6.132$(id)");
  assert.throws(() => decideHost(parseTypesCheck(evil), []), /strict semver/);
  const shim = `${OUTPUT_CURRENT}Set "tailwind-merge" to latest in devDependencies — the version this bb shims at runtime.\n`;
  assert.throws(() => decideHost(parseTypesCheck(shim), []), /strict semver/);
  assert.equal(decideHost(parseTypesCheck(OUTPUT_CURRENT), []).crossChecked, false);
});

test("reads PLUGIN_SDK_VERSION literals from a bundle", () => {
  assert.deepEqual(sdkLiterals('var A;\n    PLUGIN_SDK_VERSION = "0.6.132";\nx PLUGIN_SDK_VERSION="0.6.132"'), [
    "0.6.132",
    "0.6.132",
  ]);
  assert.deepEqual(sdkLiterals("nothing here"), []);
});

test("the floor is the >=X.Y.Z minimum in engines", () => {
  assert.equal(floorVersion(">=0.49.0"), "0.49.0");
  assert.equal(floorVersion(" >= 0.49.0 "), "0.49.0");
  for (const range of ["^0.49.0", ">=0.49", ">=0.49.0 <0.60.0", undefined, ">=0.49.0-nightly.1"]) {
    assert.throws(() => floorVersion(range), /engines\.bb/);
  }
});

test("versions are strict semver and compare numerically", () => {
  assert.equal(assertSemver("0.49.1-nightly.43282278192.1"), "0.49.1-nightly.43282278192.1");
  for (const bad of ["v1.0.0", "1.0", "1.0.0\n", "1.0.0 && x", "01.0.0", "1.0.0-", ""])
    assert.throws(() => assertSemver(bad));
  assert.ok(compareStable("0.50.0", "0.49.0") > 0);
  assert.ok(compareStable("0.49.10", "0.49.9") > 0);
  assert.equal(compareStable("0.49.0", "0.49.0"), 0);
  assert.throws(() => compareStable("0.50.0-nightly.1", "0.49.0"), /stable release/);
});

test("a channel installs bb-app, the SDK and the shims in one npm command", () => {
  assert.deepEqual(installArgs({ bbApp: "0.48.0", sdk: "0.6.94", shimPins: { "tailwind-merge": "^3.4.0" } }), [
    "install",
    "--no-save",
    "--no-audit",
    "--no-fund",
    "bb-app@0.48.0",
    "@get-bb/plugin-sdk@0.6.94",
    "tailwind-merge@^3.4.0",
  ]);
});

test("code fences outgrow backticks in error output", () => {
  assert.equal(fence("plain"), "```\nplain\n```");
  assert.equal(fence("has ``` inside", "text"), "````text\nhas ``` inside\n````");
});
