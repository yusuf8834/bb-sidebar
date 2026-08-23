# BB Sidebar

A thread list for bb, heavily inspired by the T3 Chat sidebar. It replaces the
scrolling part of bb's sidebar while bb keeps its own search, New thread button,
plugin navigation, and footer.

The list follows one opinionated rule: activity never moves a card. Active
threads stay in creation order until you pin or park them, so a row cannot
jump away while you are about to click it.

## What is included

- Three-line cards with project, status or age, title, branch or machine,
  activity counts, pull request, and provider glyph
- Project filtering through the list's own scope picker
- Pinned threads above the inbox, with persistent drag or keyboard reordering
- Durable custom ordering for ordinary inbox threads
- Modifier-click and Shift-click selection with bulk settle, snooze, read, and unread actions
- Hover controls for unpinning a pinned thread without opening its menu
- Snoozed and Settled shelves backed by the plugin's SQLite database
- Optional settling after inactivity, PR merge, or PR close
- Right-click Snooze presets that can be changed in the plugin settings
- Automatic wake-up when parked work becomes active or needs input
- Header chips for navigating between parent and child threads
- bb-native open, split, rename, read, pin, archive, and delete flows
- bb keyboard targets and drag-to-split support

## Install from this checkout

```sh
npm install
npm run build
bb plugin install path:. --yes
```

Then choose **BB Sidebar** under **Settings -> Appearance -> Sidebar**.
bb's sidebar returns immediately if you select it again or disable this plugin.

For development, use `bb plugin dev` after the path install. It rebuilds and
reloads the plugin when a source file changes.

## Reordering threads

Drag anywhere on a pinned or inbox card to move it within that shelf. If the
pointer leaves the sidebar, BB takes over the same gesture for drag-to-split.
Keyboard users can focus the card and press Option+Arrow Up or Option+Arrow Down
on macOS (Alt+Arrow on other platforms). Pinned moves use BB's pinned-thread
API; inbox moves are saved in the plugin's SQLite database. A project-scoped
move preserves the hidden projects' positions. The plugin ignores another move
while a save is running and restores the previous order if the save fails.

Pinned cards also reveal an unpin button on hover or keyboard focus.

## Selecting several threads

Hold Command on macOS or Ctrl on Windows and Linux while clicking rows to add
or remove them from the selection. Shift-click extends from the last selected
row across the rows currently visible. The project picker becomes a compact
bulk-action bar for settle, snooze, mark read, and mark unread. Successful rows
leave the selection. Rows that fail stay selected so the action can be retried.

Changing project scope, search results, shelf expansion, or lifecycle state
removes rows that are no longer visible from the selection. Deletion remains a
per-row action because BB's confirmation counts descendants for one thread at
a time; the plugin does not bypass that warning.

## How parking works

Snoozed and Settled belong to this plugin, not to bb's thread schema.
Snoozing records a wake time. Settling records when the user filed the thread
away. A pending question or any live work overrides both states and returns the
thread to the inbox.

Automatic settling follows T3 Code's defaults: inactive threads settle after
three days, merged pull requests settle when that setting is on, and closed
pull requests settle. Open and draft pull requests block inactivity settling.
Pinning a policy-settled thread keeps it active. Manually choosing Un-settle
also keeps it active until the thread starts real work again. Configure the
inactivity toggle, day threshold, and merge behavior in the plugin settings.
The backend checks all visible threads in one pass every five minutes and
looks up each environment's pull request once per pass.

The `Snooze presets` setting accepts comma-separated durations using `m`, `h`,
`d`, or `w`. For example, `15m, 2h, 1d, 1w`. Add a custom menu label with
`Label=duration`, such as `Lunch break=3h`. The menu accepts up to eight
presets. Invalid entries are ignored, and a wholly invalid setting falls back
to the defaults.

## Sources

This implementation began from the MIT-licensed
[bb-plugin-t3sidebar](https://github.com/SawyerHood/bb-plugin-t3sidebar), the
reference plugin for bb's `experimental_threadList` slot. Its interaction and
layout choices were checked against the current
[T3 Code](https://github.com/pingdotgg/t3code) sidebar. The original copyright
notice remains in [LICENSE](./LICENSE).
