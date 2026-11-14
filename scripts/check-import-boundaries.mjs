import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { matchesGlob, relative, resolve } from "node:path";
import ts from "typescript";

// Biome 2.5 has no allowTypeImports. Read its classifications rather than duplicate them.
const config = JSON.parse(readFileSync("biome.json", "utf8"));
function configError(message) {
  console.error(`biome.json: import-boundaries configuration: ${message}`);
  process.exit(1);
}

function findOverride(marker) {
  const found = config.overrides.filter((override) => override.includes?.includes(marker));
  if (found.length !== 1) {
    configError(`Expected exactly one override containing ${marker}; found ${found.length}.`);
  }
  return found.at(0);
}

const typeImportsOverride = findOverride("src/**/*.ts");
const appOverride = findOverride("src/components/**");
const sharedOverride = findOverride("src/*.ts");
const nodeOverride = findOverride("src/ports-host.ts");
if (!nodeOverride.includes.includes("src/server-*.ts") || !sharedOverride.includes.includes("!src/server-*.ts")) {
  configError("Server modules must be classified as Node with src/server-*.ts.");
}
const expectedOrder = [typeImportsOverride, appOverride, sharedOverride, nodeOverride];
const actualOrder = config.overrides.filter((override) => expectedOrder.includes(override));
if (actualOrder.some((override, index) => override !== expectedOrder.at(index))) {
  configError("Overrides must remain ordered: type imports, app, shared, Node.");
}
const appIncludes = appOverride.includes;
const sharedIncludes = sharedOverride.includes;
const nodeIncludes = nodeOverride.includes;
const { options: compilerOptions } = ts.convertCompilerOptionsFromJson(
  JSON.parse(readFileSync("tsconfig.json", "utf8")).compilerOptions,
  ".",
);
const sourceFiles = [
  "app.tsx",
  ...readdirSync("src", { recursive: true })
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => `src/${name}`),
];
const files = process.argv.length > 2 ? process.argv.slice(2) : sourceFiles;
const nodeBuiltins = new Set(builtinModules);
const matches = (file, globs) =>
  globs.some((glob) => !glob.startsWith("!") && matchesGlob(file, glob)) &&
  !globs.some((glob) => glob.startsWith("!") && matchesGlob(file, glob.slice(1)));
let failures = 0;

function report(file, source, node, message) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  console.error(`${file}:${line + 1}:${character + 1}: import-boundaries: ${message}`);
  failures++;
}

function isTypeOnly(node) {
  if (node.isTypeOnly || node.importClause?.isTypeOnly) return true;
  const bindings = ts.isExportDeclaration(node) ? node.exportClause : node.importClause?.namedBindings;
  return (
    !node.importClause?.name &&
    bindings &&
    (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

for (const input of files) {
  const file = relative(process.cwd(), resolve(input)).replaceAll("\\", "/");
  if (!sourceFiles.includes(file)) continue;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const shared = matches(file, sharedIncludes);
  const browser = matches(file, appIncludes);
  const nodeRuntime = matches(file, nodeIncludes);
  function checkSdkImport(node) {
    if (!browser || file === "src/bb-sdk.ts" || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    if (node.moduleSpecifier.text !== "@get-bb/plugin-sdk/app") return;
    const bindings = ts.isExportDeclaration(node) ? node.exportClause : node.importClause?.namedBindings;
    if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text.startsWith("experimental_")) {
          report(file, source, element, "Import experimental SDK APIs through src/bb-sdk.ts.");
        }
      }
    } else {
      report(file, source, node, "Use named SDK imports; experimental APIs belong in src/bb-sdk.ts.");
    }
  }
  function checkSpecifier(specifier, typeOnly = false) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const name = specifier.text;
    const normalized = nodeBuiltins.has(name) && !name.startsWith("node:") ? `node:${name}` : name;
    // Shared and Node code must not reach app files or any TSX, whatever the specifier's spelling.
    const target =
      (shared || nodeRuntime) &&
      ts.resolveModuleName(name, resolve(file), compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    if (
      target &&
      (target.endsWith(".tsx") || matches(relative(process.cwd(), target).replaceAll("\\", "/"), appIncludes))
    ) {
      report(
        file,
        source,
        specifier,
        `${shared ? "Shared" : "Node"} modules must not import app or TSX module ${name}, even for types.`,
      );
    } else if (!browser && !shared) {
      return;
    } else if (/(^|\/)(server(?:-[^/]+)?|ports-host)(\.[cm]?[jt]sx?)?$/.test(normalized)) {
      report(file, source, specifier, `Browser/shared code must not import ${name}, even for types.`);
    } else if (shared && normalized.startsWith("node:")) {
      report(file, source, specifier, `Shared modules must not import Node built-in ${name}, even for types.`);
    } else if (
      !typeOnly &&
      (normalized.startsWith("node:") || normalized === "better-sqlite3" || normalized.startsWith("better-sqlite3/"))
    ) {
      report(file, source, specifier, `Browser/shared code may only import types from ${name}.`);
    }
  }
  function visit(node) {
    // Preserve consistent-type-imports' annotation ban, including its sole Vitest exception.
    if (ts.isImportTypeNode(node) && file !== "src/ports-host.test.ts") {
      report(file, source, node, "Use a top-level import type instead of an import() type annotation.");
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkSdkImport(node);
      checkSpecifier(node.moduleSpecifier, isTypeOnly(node));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (browser && file !== "src/bb-sdk.ts" && node.arguments.at(0)?.text === "@get-bb/plugin-sdk/app") {
        report(file, source, node, "Use named SDK imports; experimental APIs belong in src/bb-sdk.ts.");
      }
      checkSpecifier(node.arguments.at(0));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (failures > 0) process.exitCode = 1;
else console.log("Import boundaries passed.");
