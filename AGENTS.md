# Working in bb-sidebar

Behavior-preserving refactors only unless the task says otherwise. Keep test
meaning intact.

Contributor lists are for people only. Do not list AI tools, models, or agents
as contributors or add `Co-authored-by` commit trailers crediting them.

Pull requests follow `.github/pull_request_template.md`, including when the body
is passed to `gh pr create`. A PR that changes anything a user can see includes
before and after screenshots; `npm run e2e` starts a scratch bb to take them.

Inbox layout: `src/inbox-layout.ts`; shelves: `ThreadInboxShelves.tsx`.
Inbox hooks use `src/use*.ts`; gesture helpers use `src/drag-*.ts`.
Inbox rendering: `src/ThreadInboxView.tsx` and `src/ThreadInboxEmptyStates.tsx`.
Inbox context: `src/InboxContext.tsx` shares environment, actions, and activity.

## Live threads: polls and scheduled work skip Settled

A settled thread is done, practically archived. Any automatic, recurring work
you add (poll, scheduled pass, scan, background lookup) must cover only threads
that are not settled. Look a settled thread up on demand instead: when its
hover card opens, when the thread is open, or when it returns to Active (it is
live again). Snoozed, Parked and Inactive-shelf threads stay live.

- App: `useLiveThreads`, over shared `src/live-threads.ts`, gives `settled`;
  it is null until lifecycle rows load, so start nothing before then.
  On-demand lookups use `useOnDemandLookups`, fired from
  `ThreadDetailsTooltip.tsx`.
- `ThreadInbox` reads rows with `useLifecycleRows` above `RateLimitsProvider`;
  `useLifecycle(threads, lifecycleRows)` classifies.
- `RateLimitsProvider` and `OpenPortsProvider` poll live threads only. Ports
  go by workspace: one shared with a live thread is still polled.
- `getOpenPorts` takes `{ environmentIds }` (1-500, strict) and rejects `{}`;
  the app sends live workspaces and splits longer lists.
- Server: `server-policy` passes (run by the 5-minute `auto-settle` schedule,
  among others) skip PR lookups for policy-settled threads; only
  `cannotAutoSettle` in `src/auto-settle.ts` can return them to Active. A
  full re-check is pending from server start and from each auto-settle
  settings change until a pass completes; unanswered lookups retry each pass.
  New server jobs decide "settled" with `resolveRowShelf` or `resolveShelf`
  from shared `src/lifecycle.ts`.

## Runtimes and imports

- Browser entry: `app.tsx`. App code includes `src/*.tsx`, `src/components/**`,
  `src/lib/**`, `src/use*.ts`, and the browser modules listed below.
  React, DOM APIs, and SDK app APIs belong here. No imports of `server`,
  `server-*`, or `ports-host`, even for types or side effects. No value
  imports of Node built-ins with or without `node:`, or `better-sqlite3`, even
  dynamically. Type-only imports of other Node modules are allowed.
- Node server entry: `src/server.ts`. Node host entry: `src/ports-host.ts`.
  Flat `src/server-*.ts` modules share `ServerContext` explicitly.
  Their other supporting Node modules are `port-scan`, `auto-title`,
  `cloud-title`, `regenerate-title`, `port-discovery`, `thread-ports`,
  `thread-pull-requests`, and `thread-tasks`, all under `src/`.
  Node/SDK server or host APIs are allowed. These modules must not import React,
  TSX, browser `.ts` modules, `use*` hooks, `lib/**`, or `components/**`, even
  for types. Pure settings definitions and helpers live in shared
  `sidebar-settings-values.ts`.
- Browser `.ts` modules are `project-colors`, `title-generation-state`,
  `sidebar-settings`, `working-since`, `working-tree`, `drag-preview`,
  `drag-reorder`, `drag-reorder-geometry`, `drag-auto-scroll`,
  `settled-port-prompt`, and `bb-sdk`. `project-colors.ts` uses React's
  `CSSProperties` type and `title-generation-state.ts` uses
  `useSyncExternalStore` intentionally.
- Shared modules are all other top-level `src/*.ts`, excluding `server-*.ts`,
  `use*.ts`, `*.test.ts`, `*.d.ts`, and `test-*.ts`. They must not import
  React, React DOM, Node built-ins, Node entries, TSX, browser `.ts` modules,
  `use*` hooks, `lib/**`, or `components/**`, even for types, or value-import
  SQLite. This is a dependency boundary; these modules are not necessarily
  free of side effects or DOM access.
- Tests keep their runtime's boundaries; top-level `.ts` tests and test
  helpers may use Node test tooling.
- These classifications are the ordered overrides in `biome.json` (type
  imports, app, shared, Node). A new browser `.ts` or Node module goes in its
  override's `includes` and in the shared override's exclusions.

App experimental SDK hooks use stable names from `src/bb-sdk.ts`.
Pin to the SDK the latest stable bb-app ships; migrate experimental_* breaks
through `src/bb-sdk.ts`. The minimum host is bb 0.48.0 with SDK 0.6.94.
Pull request data comes from the bundled GitHub PR Status plugin
(`src/github-pr-status.ts`): rows through `useEnvironmentPullRequest` in
`src/bb-sdk.ts`, and `plugins.callRpc` in `server-policy`. A failed or
`unavailable` lookup is `unknown` and never settles a thread.

Keep the sidebar's own menus and named delete confirmation. Bound core actions
own unpin, read state, rename requests, split, and thread-tree archive. Thread
rows, child rows, and hover-card subthreads are links to `thread.href`, so bb
routes the click (Cmd/Ctrl opens a split); `navigate.toThread` would also turn
off the thread's saved Full Screen. Rows still call `onNavigate`; only clicks
that are not links use `useBbNavigate`. Title saves use the optimistic SDK client.
Root pinning keeps the lifecycle RPC's parent lock and atomic shelf clearing.
Delete keeps `deleteThread` RPC after confirming the named tree. Parent, snooze,
park, settle, project, title regeneration, and clean stay plugin-owned.
Do not adopt the SDK's thread menu components for this sidebar.

The sidebar RPC contract and its schemas live in shared `src/contract.ts` as
`bbSidebarRpcContract`. App code imports its types with `import type`. The
contract re-exports all six realtime channels from `src/realtime-channels.ts`;
browser value imports use that pure module to avoid loading schemas. The host
port contract lives in `src/port-scan-contract.ts`.

## Server modules

- `server-context`: SDK/database context and handler types.
- `server-settings`: settings reads, writes, and legacy import.
- `server-lifecycle`: lifecycle rows, shelves, ancestor wakes, inbox order,
  thread loading, and locks for pin/parent changes.
- `server-project-icons`: icon resolution, caches, overrides, and uploads.
- `server-project-colors`: project color reads and writes.
- `server-project-management`: project names, paths, and removal.
- `server-settle-cleanup`: cleanup previews, cleanup, and runtime reclaim.
- `server-settle-actions`: tree settle, return to Active, and Undo snapshots.
- `server-policy`: automatic settle passes and settings revisions.
- `server-rate-limits`: provider-limit reads and scheduled Continue queue actions.
- `server-rate-limit-details`: failed-turn classification and provider reset times.
- `server-handlers`: RPC handlers assembled from the modules.
- `server-cli`: the `bb sidebar` agent command over those handlers. Keep it to
  a few subcommands; each one adds a line to the `plugin-commands` skill.
- `server.ts`: migrations, context, wiring, `auto-settle` schedule, HTTP, CLI,
  events.

Settings live in the single `sidebar_settings.settings_json` column, validated
with `sidebarSettingsSchema`; RPC input validation stays strict. Per-field
fallbacks come from `DEFAULT_SIDEBAR_SETTINGS`, except that installs marked in
`install_defaults` keep `autoSettleOnMerge` on until they save settings. The
old columns are unused: a compatibility row satisfies their NOT NULL
constraints, NULL JSON still permits the legacy SDK settings import, and
dropping them needs a table rebuild in a later major. The app reads server
settings or the existing cache. Do not load zod or contract schemas in browser
code; cache validation uses codecs in `src/lib/`.

## Browser persistence

Declare persisted browser keys once in `src/lib/storage-keys.ts`, with an
eviction priority. `src/lib/safe-storage.ts` derives quota recovery from it.
Use `src/lib/use-persisted-preference.ts` for UI preferences and
`src/lib/cached-rpc-state.ts` for caches keyed by RPC client. Both use codecs
and the read/write functions in `src/lib/storage-codec.ts`; other browser
state uses those functions directly. Keep DOM event names in
`src/lib/browser-events.ts`. Production key literals and direct localStorage
access are checked by `src/storage-keys.test.ts`.

## Size and style budgets

- Production files and `scripts/**/*.mjs`: at most 500 physical lines; tests
  get 1,000. `scripts/check-file-sizes.mjs` records a ceiling for one file,
  `src/ThreadCard.tsx`. Growth fails; shrinkage also fails until the ceiling
  is lowered. Remove the entry once the file is within 500.
- `SidebarSettings.tsx` renders section components; keep draft and save logic
  centralized there.
- Biome does not format Markdown or YAML. `useImportType` is an error.
  `jsxRuntime: reactClassic` affects linting only; TypeScript still compiles
  with `react-jsx`.
- Biome's `noRestrictedImports` enforces the import rules above. Biome lacks
  `allowTypeImports`, so `scripts/check-import-boundaries.mjs` enforces the
  type-only, dynamic-import and Node built-in parts. It also checks the
  Node/shared TSX name lists for drift, requires named imports from
  `@get-bb/plugin-sdk/app` with `experimental_*` only in `src/bb-sdk.ts`, and
  bans `import()` type annotations except in `ports-host.test.ts` (Vitest's
  `importOriginal`; regular imports there still need type-only syntax when
  used only as types).

## Checks

A fresh checkout or worktree must run `npm ci` before its first commit: it
installs lefthook, and the pre-commit hook runs the local Biome binary.

Run `npm run check` before and after changes; once before a commit is enough.
CI runs it plus `npx --no-install bb plugin types --check`. `npm run format`
writes formatting; `npm run lint`, `npm run format:check`, and `npm run knip`
run individually.

`npm run test:stress` is manual only. Do not run it unless the user asks:
it pins every CPU core for minutes. The stress CI job also runs only when
triggered by hand.

Hooks (`lefthook.yml`) are installed into the common `.git/hooks` for every
worktree; branches without `lefthook.yml` skip them. They check without
applying fixes. Commit-msg runs `scripts/strip-ai-attribution.mjs`.

Knip: if it says unused and bb plugin types did not pin it, remove it.
`npm run knip` checks unused exports and exported types in every file, without
per-file or issue-type exceptions. `knip.ts` preserves only SDK peer
dependencies and the `tsc` binary ignore for the TypeScript alias.

### Tests

- Timeouts are centralized in `test-setup.ts` (Testing Library) and
  `vitest.config.ts` (Vitest). App tests retain file isolation.
- `test-app-setup.ts` resets state, and cleanup hooks register per file.
  New module-level mutable app state (`Map`/`Set`/`let`) needs a `*ForTests`
  reset wired into it. Existing resets: `resetProjectFaviconsForTests` in
  `ProjectFavicon.tsx`, `resetTitleGenerationForTests` in
  `title-generation-state.ts`, `resetWorkingEmptyLineForTests` in
  `working-empty-lines.ts`. State inside hooks or providers needs none.
- Vitest loads real icon data through `test-icon-data.ts` leaf exports. Keep
  them in sync with `components/Icon.tsx`; `hugeicons.test.ts` checks their SVG
  data against the package's full ESM entry.
- `src/test-wired.ts` wires real app/server SDK RPC; `flush()` sends realtime.
- `harness.lifecycle.reload(plugin)` rebuilds the host from the original
  `createFakePluginHost` options (stored data survives). Stubs added through
  `inspection.sdk.stub`, including `test-server.ts`'s default `threads.list`,
  are dropped, so reload tests pass `threads.list` in the options.
- Fixtures in `src/fixtures/` have hashes; release data comes from pinned tags.
  Generate with `npm run fixture:db -- <new-path> [git-ref]`. The default is
  v0.2.34. An explicit tag or commit SHA generates a new schema
  snapshot from a temporary git worktree using that checkout's `server.ts`.
  Future schema changes add versions; never edit or overwrite old fixtures.

### Browser e2e

Outside `npm run check`; see `e2e/README.md`. Full:
`env -i PATH="$PATH" HOME="$HOME" npm run e2e`; quick: `e2e:smoke`; `bb sidebar`
CLI against the scratch server: `e2e:cli`. Only drive/install/seed on the
runner's scratch server; never the live host. macOS snapshots:
`npm run e2e -- --update-snapshots` with the same clean environment; review
`e2e/__snapshots__/` diffs. Before releases on macOS: `npm run e2e`; CI:
`gh workflow run "Browser e2e"`.
