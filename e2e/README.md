# Sidebar browser tests

Install dependencies with `npm ci`, the fixture provider CLI, and Chromium:

```sh
npm install --global @openai/codex@0.162.1
npx --no-install playwright install chromium
# On Linux, install the browser's OS dependencies too:
npx --no-install playwright install --with-deps chromium

env -i PATH="$PATH" HOME="$HOME" npm run e2e
env -i PATH="$PATH" HOME="$HOME" npm run e2e:smoke
# Drive every `bb sidebar` subcommand against the scratch server (no browser):
env -i PATH="$PATH" HOME="$HOME" npm run e2e:cli
# Run a focused flow through the same scratch launcher:
env -i PATH="$PATH" HOME="$HOME" npm run e2e -- --grep 'settle moves'
# Exercise motion with 60 loaded settled rows, with timing attached to the report:
env -i PATH="$PATH" HOME="$HOME" npm run e2e -- --grep 'large settled shelves'
# Toggle every shelf pair and a seeded walk, docked and not; fails on any jump:
env -i PATH="$PATH" HOME="$HOME" npm run e2e -- --grep 'toggle sequence'
```

`@playwright/test` supplies role locators, retrying assertions, PNG comparisons,
and failure screenshots/traces. `e2e:cli` seeds three idle threads and runs each
`bb sidebar` subcommand through the scratch CLI, checking the result with
`bb sidebar list --json` and the plugin RPC; its command transcript is saved to
`e2e-artifacts/cli-transcript.log`. All three commands use `scripts/e2e/server.mjs` and
the pinned bb-app (`devDependencies.bb-app`). Neither runs as part of
`npm run check`. Run e2e separately from Vitest; the scratch server and
Chromium compete with the unit suite for CPU.
Before releases on macOS: `npm run e2e`; CI: `gh workflow run "Browser e2e"`.

## Isolation and fixtures

The launcher creates its own `/tmp/bb-sidebar-smoke-*` data directory, two free
loopback ports, and a Git repository on branch `main`. It strips inherited
`BB_*` values through the original environment allowlist, rejects an inherited
`BB_SERVER_URL` on port 38886 before starting anything, and also rejects either
allocated port if it is 38886. Plugin installation, sidebar selection, project
creation, thread creation, RPC calls, and browser navigation target that server.
The launcher owns one server for the entire run, including test failures. It
stops detached process groups with TERM followed by KILL and deletes scratch
data on completion or SIGINT/SIGTERM. The CLI and server use the same pinned
bb-app package. The runtime and plugin are staged under scratch so even mapped
code stays outside the real `~/.bb` tree. `--app-dir <absolute-path>` can select another local bb-app for
compatibility checks; it does not select a running server or data directory.

The server and every BB CLI call receive a new `HOME=<scratch>/home`, plus
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`,
`CODEX_HOME`, and `CLAUDE_CONFIG_DIR` beneath it. `TMPDIR=<scratch>/tmp` keeps
host-worker temporary directories inside teardown. Only the build and
Playwright processes retain the real HOME; the build's BB data/toolchain cache
still targets scratch. The community marketplace is an empty loopback fixture.
On macOS the launcher creates an unlocked throwaway keychain in scratch HOME
before starting bb-app, sets it as the only user search-list/default keychain,
and aliases the login keychain to it. All three lookups are verified before
providers can start. Chromium also receives `--use-mock-keychain` in both
launchers. Teardown removes the scratch keychain with the scratch home.
Pi is disabled in scratch because these fixtures use Codex. Codex's scratch
configuration uses a file credential store and disables analytics/feedback,
using keys from the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The credential guard starts after readiness and samples the scratch process
tree throughout the run. It rejects visible HOME/CODEX_HOME/CLAUDE_CONFIG_DIR
values outside scratch and any open file under the real `~/.codex`, `~/.claude`,
`~/.cursor`, `~/.config`, or `~/.bb`, with no workspace exception. macOS helpers
that replace their process title can hide their environment from `ps`; those
samples are marked `environmentVisible: false`, and their open files are still
checked. Raw environments are never logged. Evidence is retained in
`e2e-artifacts/isolation.jsonl` and uploaded on CI failures.

Known limitation: this guard enforces credential/file isolation, not zero
outbound traffic. During investigation an unauthenticated Codex child contacted
`[2606:4700:4408::ac40:9bd1]:443`; its hostname was not established. Other native
provider discovery helpers also contacted outside addresses. Documented model
endpoint overrides did not eliminate all traffic. Established TCP destinations
are recorded with `lsof`; outbound connections do not fail the credential guard.
The scratch homes contain no developer credentials or copied provider state.

The suite seeds four fixed-title threads using CLI `thread spawn --prompt ''`
with Codex and the scratch checkout, immediately followed by `thread stop`.
Each must reach `idle`, have an environment, have no queued messages, and have
no item/output/tool events or provider errors. Metadata warnings and account
announcements are allowed. An empty initial turn can start before stop arrives;
this is a create-and-cancel fixture, not a guarantee that no turn ever starts.
It supplies idle rows without completed agent output. The quick smoke keeps
the original seven-day scheduled fixture.

The launcher checks `codex --version` before starting the scratch server. CI
installs the pinned CLI above; no login or credentials are needed. Without the
executable, provider startup can fail before cancellation reaches the thread,
leaving it in `error`. On suite failure, the runner saves server output and
thread state/event logs in `e2e-artifacts/` before deleting scratch data.

Seeding investigation: scheduled threads stayed `pending` even after queue
deletion and stop; unknown providers were rejected; idle forks required an
active provider session to clone. Empty-prompt creation and cancellation worked
without completed agent output. The fixtures exercise idle threads.
Working/attention/woke states stay outside this suite. Those stay in the wired tests.
There is no direct database mutation or mocked browser RPC response.

The shelf-motion flow creates 60 additional idle threads and settles them through
the plugin RPC. It loads all pages and repeatedly expands and collapses Settled
with normal motion enabled, in docked and undocked layouts. It checks that bulk
toggles use no row or height animations and that the selected thread remains
visible when collapsed. Frame gaps and long tasks are attached to the report;
they are measurements, not a hardware-dependent FPS assertion. Extra threads
are deleted during teardown.

Each behavior test resets pin/read/lifecycle/order state through the scratch
CLI and plugin RPC, then gets a new browser context. The fourteen flows assert
selection/rendering, pin persistence, Alt+ArrowUp manual order persistence,
snooze/wake, settle/Undo, the complete right-click menu, and a sidebar settings
change that updates visible snooze options and persists after reload. They also
cover park/resume across reload, project filtering, custom project name/stripe
colors through computed styles across reload, child-chip expansion/collapse,
and the Settled Clean preview. Server assertions check core pin/idle/parent
state and plugin lifecycle/order/settings/color state. No production test IDs
were added. The visual capture uses the existing `data-bb-sidebar-root` marker
because the whole plugin container has no accessible role.

`seeds.mjs` creates a separate scratch Git checkout and project with one idle
thread for filtering, and an idle parent with two idle children for the child-chip flow. Fixtures
delete these extra projects/threads even when assertions fail. Children are
assigned through the sidebar's Parent menu after their empty turns stop.
Parent assignment can asynchronously send ownership notifications that start
an agent turn, so this flow uses a disposable parent instead of a shared seed.
The family is deleted at teardown; its background turns cannot affect later tests.
The color flow clears its override and settings in a `finally` block. These
seeds and overrides are gone before the four original snapshot captures.

The Clean flow settles all four original seeds, which share a checkout, so an
Active fixture cannot protect the workspace and hide resources. These seeds
have no terminals or owned listening ports. The empty dialog offers Cancel,
with no Clean resources button. The test calls the real cleanup RPC with the
UI preview's token and verifies zero closed resources and unchanged thread,
terminal, and lifecycle state. It does not exercise closing a real terminal.

## Visual baselines

Three populated captures cover light, dark, and a 280 px wide plugin sidebar.
A fourth capture shows empty Active after all threads have been settled.
The wide captures are 320 px. The host's persisted width includes a 49 px
navigation rail/border on bb 0.47, so the browser fixture adds that amount and
asserts the actual plugin width. Update the offset in `open()` when a host
release changes it. The populated images contain Pinned, Active, Snoozed, and Settled.
Titles, project name, branch, order, locale, and timezone are fixed. A capture
stylesheet hides relative update/wake labels while retaining layout, reduced
motion disables animation, and the mouse moves off the sidebar.

Baselines live in `e2e/__snapshots__/darwin/`. Playwright allows **20 differing
pixels**, with a per-pixel perceived-color threshold of **0.1**. Missing
baselines fail unless updating explicitly. Keep the pinned Playwright version
and Chromium download together when reviewing new baselines.

```sh
# On macOS, after an intentional UI change, with no unit suite running:
env -i PATH="$PATH" HOME="$HOME" npm run e2e -- --update-snapshots
# Inspect all four PNGs and git diff before committing them.
```

Only macOS has reviewed baselines, so Linux skips the four visual comparisons
and runs all fourteen behavior tests. This avoids treating font/rendering
differences as product regressions. The manual Ubuntu workflow installs
Chromium's Linux dependencies, the pinned Codex CLI, `lsof`, and `procps`.
It uploads screenshots, traces, reports, thread/server diagnostics, and isolation
evidence on failure. Use this workflow to verify Ubuntu execution and native
addon installation; macOS checks do not cover them. Linux snapshots should be added only after
generating and reviewing them on the chosen runner.

Inspect failures with `npx --no-install playwright show-report` or
`npx --no-install playwright show-trace test-results/<test>/trace.zip`.
