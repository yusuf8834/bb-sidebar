# T3 Chat Sidebar

A T3 Code-style thread list for bb. It replaces the scrolling part of bb's
sidebar while bb keeps its own search, New thread button, plugin navigation,
and footer.

The list follows one opinionated rule: activity never moves a card. Active
threads stay in creation order until you pin or park them, so a row cannot
jump away while you are about to click it.

## What is included

- Three-line cards with project, status or age, title, branch or machine,
  activity counts, pull request, and provider glyph
- Project filtering through the list's own scope picker
- Pinned threads above the inbox
- Snoozed and Settled shelves backed by the plugin's SQLite database
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

Then choose **T3 Chat Sidebar** under **Settings -> Appearance -> Sidebar**.
bb's sidebar returns immediately if you select it again or disable this plugin.

For development, use `bb plugin dev` after the path install. It rebuilds and
reloads the plugin when a source file changes.

## How parking works

Snoozed and Settled belong to this plugin, not to bb's thread schema.
Snoozing records a wake time. Settling records when the user filed the thread
away. A pending question or any live work overrides both states and returns the
thread to the inbox.

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
