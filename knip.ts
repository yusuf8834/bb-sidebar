import type { KnipConfig } from "knip";

// The SDK loads these peer dependencies even without direct source imports.
const sdkPeerDependencies = ["hono", "cron-parser", "better-sqlite3"];

const config: KnipConfig = {
  entry: [
    "app.tsx",
    "src/server.ts",
    "src/ports-host.ts",
    "src/test-setup.ts",
    "e2e/*.spec.mjs",
    "e2e/playwright.config.mjs",
    "scripts/e2e/isolation.test.mjs",
  ],
  project: ["app.tsx", "src/**/*.{ts,tsx}", "scripts/**/*.mjs", "e2e/**/*.mjs"],
  ignoreDependencies: sdkPeerDependencies,
  // npm's typescript -> @typescript/typescript6 alias provides tsc; Knip misses that binary.
  ignoreBinaries: ["tsc"],
};

export default config;
