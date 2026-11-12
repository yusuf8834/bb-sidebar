// "What bb changed": compares the public surface of two @get-bb/plugin-sdk
// versions with the TypeScript checker. A typecheck against the newer SDK
// finds removals; this report also lists additions (a new status, a new
// required field), which no typecheck can find.
//
//   node scripts/bb-compat/sdk-surface.mjs --from 0.6.94 --to 0.6.132 [--json out.json] [--markdown out.md]
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { assertSemver, code, parseArgs, runOk } from "./lib.mjs";

const SDK = "@get-bb/plugin-sdk";
const ENTRIES = { app: `${SDK}/app`, server: SDK };

// The SDK types the sidebar reads. Each is an alias in a probe file, so a
// type that bb derives (the server row comes from threads.list) is covered too.
const TRACKED_TYPES = [
  { name: "PluginSidebarThread", entry: "app", expression: "App.PluginSidebarThread" },
  { name: "PluginSidebarThreadActivity", entry: "app", expression: "App.PluginSidebarThreadActivity" },
  { name: "PluginSidebarThreadIndicator", entry: "app", expression: "App.PluginSidebarThreadIndicator" },
  { name: "PluginSidebarThreadRowStatus", entry: "app", expression: "App.PluginSidebarThreadRowStatus" },
  {
    name: "server thread row",
    entry: "server",
    requires: "PluginBbSdk",
    expression: 'Awaited<ReturnType<Server.PluginBbSdk["threads"]["list"]>>[number]',
  },
];

const FORMAT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

/**
 * Reads the surface of the SDK installed at
 * `<rootDir>/node_modules/@get-bb/plugin-sdk`. Module resolution walks up from
 * rootDir, so react and zod come from the nearest enclosing node_modules.
 */
export function readSurface(rootDir, tracked = TRACKED_TYPES) {
  const probePath = join(rootDir, "bb-compat-probe.ts");
  const exportsProbe = [
    `import type * as App from "${ENTRIES.app}";`,
    `import type * as Server from "${ENTRIES.server}";`,
  ];
  writeFileSync(probePath, `${exportsProbe.join("\n")}\nexport {};\n`);
  const first = createProgram(probePath);
  const exportsByEntry = {};
  for (const [entry, specifier] of Object.entries(ENTRIES)) {
    exportsByEntry[entry] = moduleExports(first, probePath, specifier);
  }
  // Second pass: alias only the tracked types whose roots exist, so a removed
  // type is reported as missing rather than resolving to an error type.
  const present = tracked.filter((type) => exportsByEntry[type.entry]?.has(type.requires ?? type.name));
  const aliases = present.map((type, index) => `export type Tracked${index} = ${type.expression};`);
  writeFileSync(probePath, `${exportsProbe.join("\n")}\n${aliases.join("\n")}\n`);
  const program = createProgram(probePath);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(probePath);
  const types = {};
  for (const type of tracked) types[type.name] = null;
  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) continue;
    const index = Number(statement.name.text.replace("Tracked", ""));
    types[present[index].name] = describeType(checker, checker.getTypeAtLocation(statement.name), statement);
  }
  rmSync(probePath, { force: true });
  return {
    exports: Object.fromEntries(Object.entries(exportsByEntry).map(([entry, names]) => [entry, [...names].sort()])),
    types,
  };
}

function createProgram(probePath) {
  return ts.createProgram([probePath], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    types: [],
  });
}

function moduleExports(program, probePath, specifier) {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(probePath);
  const declaration = source.statements.find(
    (statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === specifier,
  );
  const symbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
  if (!symbol) throw new Error(`Cannot resolve ${specifier}; is the SDK installed?`);
  return new Set(checker.getExportsOfModule(symbol).map((exported) => exported.name));
}

function describeType(checker, type, location) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: "unresolved" };
  if (
    type.isUnion() &&
    type.types.every((member) => member.isLiteral() || member.flags & ts.TypeFlags.BooleanLiteral)
  ) {
    return { kind: "union", members: type.types.map((member) => checker.typeToString(member)).sort() };
  }
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) return { kind: "unresolved" };
  const fields = {};
  for (const property of properties) {
    const fieldType = checker.getTypeOfSymbolAtLocation(property, location);
    fields[property.name] = {
      optional: Boolean(property.flags & ts.SymbolFlags.Optional),
      type: checker.typeToString(fieldType, undefined, FORMAT),
      ...describeParts(checker, fieldType, location),
    };
  }
  return { kind: "object", fields };
}

// One level deeper, so a changed field reports what changed inside it: the
// members of a literal union, or the fields of an object (nullable or not).
// Deeper changes show only as a changed type string.
function describeParts(checker, type, location) {
  const parts = type.isUnion() ? type.types : [type];
  const nonNull = parts.filter((part) => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  if (nonNull.length > 1 && nonNull.every((part) => part.isLiteral() || part.flags & ts.TypeFlags.BooleanLiteral)) {
    return { members: nonNull.map((part) => checker.typeToString(part)).sort() };
  }
  if (nonNull.length !== 1 || !(nonNull[0].flags & ts.TypeFlags.Object) || checker.isArrayType(nonNull[0])) return {};
  if (nonNull[0].getCallSignatures().length) return {};
  const subfields = {};
  for (const property of checker.getPropertiesOfType(nonNull[0])) {
    const optional = property.flags & ts.SymbolFlags.Optional ? "?" : "";
    subfields[property.name] =
      `${optional}${checker.typeToString(checker.getTypeOfSymbolAtLocation(property, location), undefined, FORMAT)}`;
  }
  return { subfields };
}

function partChanges(from, to) {
  const changes = [];
  if (from.members && to.members) {
    const added = to.members.filter((member) => !from.members.includes(member));
    const removed = from.members.filter((member) => !to.members.includes(member));
    if (added.length) changes.push(`members added ${added.map(code).join(", ")}`);
    if (removed.length) changes.push(`members removed ${removed.map(code).join(", ")}`);
  } else if (from.subfields && to.subfields) {
    const keys = (record) => Object.keys(record);
    const added = keys(to.subfields).filter((key) => !(key in from.subfields));
    const removed = keys(from.subfields).filter((key) => !(key in to.subfields));
    const changed = keys(to.subfields).filter(
      (key) => key in from.subfields && from.subfields[key] !== to.subfields[key],
    );
    if (added.length)
      changes.push(`fields added ${added.map((key) => `${code(key)} (${shortType(to.subfields[key])})`).join(", ")}`);
    if (removed.length) changes.push(`fields removed ${removed.map(code).join(", ")}`);
    if (changed.length) changes.push(`fields changed ${changed.map(code).join(", ")}`);
  }
  if (from.optional !== to.optional) changes.push(to.optional ? "now optional" : "now required");
  return changes;
}

/** The differences between two surfaces from readSurface. */
export function diffSurfaces(before, after) {
  const exports = {};
  for (const entry of Object.keys(ENTRIES)) {
    const was = new Set(before.exports[entry]);
    const now = new Set(after.exports[entry]);
    exports[entry] = {
      added: [...now].filter((name) => !was.has(name)).sort(),
      removed: [...was].filter((name) => !now.has(name)).sort(),
    };
  }
  const types = {};
  for (const name of Object.keys(after.types)) {
    types[name] = diffType(before.types[name], after.types[name]);
  }
  return { exports, types };
}

function diffType(was, now) {
  if (!was && !now) return { status: "missing in both" };
  if (!was) return { status: "added" };
  if (!now) return { status: "removed" };
  if (was.kind === "unresolved" || now.kind === "unresolved") return { status: "unresolved" };
  if (was.kind !== now.kind) return { status: "changed kind", from: was.kind, to: now.kind };
  if (now.kind === "union") {
    const before = new Set(was.members);
    const after = new Set(now.members);
    return {
      status: "compared",
      added: now.members.filter((member) => !before.has(member)),
      removed: was.members.filter((member) => !after.has(member)),
      changed: [],
    };
  }
  const added = [];
  const changed = [];
  for (const [field, info] of Object.entries(now.fields)) {
    const old = was.fields[field];
    if (!old) added.push({ name: field, optional: info.optional, type: info.type });
    // Compare the parts too: a field typed by a named interface or alias
    // prints as the same name even when that type gained or lost a member.
    else if (JSON.stringify(old) !== JSON.stringify(info)) changed.push({ name: field, from: old, to: info });
  }
  const removed = Object.keys(was.fields).filter((field) => !now.fields[field]);
  return { status: "compared", added, removed, changed };
}

/** True when the report could not compare something it must compare. */
export function surfaceProblems(diff) {
  return Object.entries(diff.types)
    .filter(([, change]) => change.status === "unresolved" || change.status === "missing in both")
    .map(([name, change]) => `${name}: ${change.status}`);
}

const LIST_LIMIT = 40;
const TYPE_LIMIT = 160;

function names(list) {
  const shown = list.slice(0, LIST_LIMIT).map(code).join(", ");
  return list.length > LIST_LIMIT ? `${shown}, and ${list.length - LIST_LIMIT} more` : shown;
}

function shortType(text) {
  return code(text.length > TYPE_LIMIT ? `${text.slice(0, TYPE_LIMIT)}…` : text);
}

/** Markdown for job summaries, issues and pull requests. */
export function renderMarkdown(diff, { from, to }) {
  const lines = [`#### What bb changed: SDK ${from} → ${to}`, ""];
  if (from === to) return [...lines, "Same SDK version as the pin; nothing to compare.", ""].join("\n");
  lines.push(
    "Typechecking against the new SDK finds removals. Additions below need a human look: a new status or a new required field compiles but may need handling.",
    "",
  );
  for (const [entry, change] of Object.entries(diff.exports)) {
    const label = `${entry === "app" ? "App" : "Server"} entry ${code(ENTRIES[entry])}`;
    if (!change.added.length && !change.removed.length) {
      lines.push(`- ${label}: no exports added or removed.`);
      continue;
    }
    lines.push(`- ${label}:`);
    if (change.added.length) lines.push(`  - added (${change.added.length}): ${names(change.added)}`);
    if (change.removed.length) lines.push(`  - removed (${change.removed.length}): ${names(change.removed)}`);
  }
  lines.push("", "Types the sidebar reads:", "");
  for (const [name, change] of Object.entries(diff.types)) {
    const label = code(name);
    if (change.status !== "compared") {
      lines.push(`- ${label}: ${change.status}${change.from ? ` (${change.from} → ${change.to})` : ""}.`);
      continue;
    }
    if (!change.added.length && !change.removed.length && !change.changed.length) {
      lines.push(`- ${label}: unchanged.`);
      continue;
    }
    lines.push(`- ${label}:`);
    const member = (item) => (typeof item === "string" ? code(item) : code(item.name));
    if (change.added.length) {
      const added = change.added.map((item) =>
        typeof item === "string"
          ? code(item)
          : `${code(item.name)} (${item.optional ? "optional" : "required"}: ${shortType(item.type)})`,
      );
      lines.push(`  - added: ${added.join(", ")}`);
    }
    if (change.removed.length) lines.push(`  - removed: ${change.removed.map(member).join(", ")}`);
    for (const item of change.changed) {
      const parts = partChanges(item.from, item.to);
      const side = (info) => `${info.optional ? "optional " : ""}${shortType(info.type)}`;
      const detail = parts.length ? parts.join("; ") : `${side(item.from)} → ${side(item.to)}`;
      lines.push(`  - changed ${code(item.name)}: ${detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Downloads one SDK version into `<cacheDir>/sdk-<version>/node_modules`.
 * cacheDir must sit inside the repository's node_modules so react and zod
 * resolve from the repository install.
 */
async function fetchSdk(version, cacheDir) {
  assertSemver(version, "SDK version");
  const root = join(cacheDir, `sdk-${version}`);
  const packageDir = join(root, "node_modules", SDK);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });
  const download = mkdtempSync(join(cacheDir, "pack-"));
  try {
    await runOk("npm", ["pack", `${SDK}@${version}`, "--pack-destination", download, "--silent"], { cwd: download });
    const tarball = readdirSync(download).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack ${SDK}@${version} produced no tarball`);
    await runOk("tar", ["-xzf", join(download, tarball), "-C", packageDir, "--strip-components=1"]);
  } finally {
    rmSync(download, { recursive: true, force: true });
  }
  return root;
}

export async function compareSdkVersions(from, to, cacheDir = resolve("node_modules/.cache/bb-compat")) {
  mkdirSync(cacheDir, { recursive: true });
  const before = readSurface(await fetchSdk(from, cacheDir));
  const after = from === to ? before : readSurface(await fetchSdk(to, cacheDir));
  return diffSurfaces(before, after);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = assertSemver(args.from, "--from");
  const to = assertSemver(args.to, "--to");
  const diff = await compareSdkVersions(from, to);
  const markdown = renderMarkdown(diff, { from, to });
  if (args.json) writeFileSync(args.json, `${JSON.stringify(diff, null, 2)}\n`);
  if (args.markdown) writeFileSync(args.markdown, markdown);
  process.stdout.write(markdown);
  const problems = surfaceProblems(diff);
  if (problems.length) {
    console.error(`Surface report incomplete: ${problems.join("; ")}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
