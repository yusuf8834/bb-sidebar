# Changelog

## [Unreleased]

### Added

- Optional project colors, disabled by default. Each project gets an automatic color based on its ID, with a custom color picker and reset control in Settings > Project appearance. Project groups share one continuous stripe; ungrouped rows have their own stripe.
- While project colors are enabled, all project names stay colored. Show stripes in full and collapsed mode, full mode only, or grouped projects only when sorting by Project.

### Changed

- Grouped settings by sidebar layout, project appearance, thread behavior, child threads, and device. Section links jump to each group; project removal has its own management section at the bottom.
- Settling a parent also settles its descendants, and waits until the whole tree is idle. New or resumed child activity reopens its ancestors.
- The Settled Clean button is now labelled "Close terminals and ports of settled threads": it never archived anything.

### Fixed

- Undo after settling restores each child's previous shelf instead of marking every child explicitly Active. It preserves newer shelf choices and activity.
- Trying automatic-settle options no longer reopens manually settled, parked, or snoozed parents when an old child returns from automatic settling. Appearance changes do not trigger settling, and evaluations discard outdated settings before changing threads.
- Retained automatic title recovery for threads BB leaves unnamed, including first prompts shorter than five words. BB's [Codex stream fix](https://github.com/get-bb/bb/pull/4830) fixes completion handling but does not change that naming threshold. Successful BB titles, manual titles, and the selected AI title service are preserved.

## [0.2.34] - 2026-10-04

### Fixed

- Installing from the marketplace no longer fails with `Could not resolve "react-day-picker"`. Releases from 0.2.28 through 0.2.33 could not be installed fresh ([#7](https://github.com/yusuf8834/bb-sidebar/issues/7), reported by [@a-kras](https://github.com/a-kras)).

### Changed

- Settling a thread plays a short sweep across its card before the card moves. Reduced motion settles at once.
- The snooze control turns orange while its menu is open, on hover, and on keyboard focus.
- The message Active shows when every thread is working changes each time the scene appears, and never repeats the previous one.

## [0.2.33] - 2026-10-04

### Added

- A thread with an unsent message in its composer shows **Draft** in place of its age, or **Drafting** while it works, as bb's own sidebar does. Failures, questions, unread results, and queued messages still take precedence.
- With the Working shelf on, Active shows an animated scene when every thread is working.

## [0.2.32] - 2026-10-04

### Added

- A child thread in a different project from its parent shows that project's icon in the sidebar tree, and the project's name in the header's Children popover.
- Child threads at any depth can be dragged into the composer as a thread reference, or into the workspace to open a pane, like root threads. This also works from the Subthreads list in the hover card. Dragging keeps the child's parent ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).
- Thread trees show the full hierarchy, including great-grandchildren and deeper, and every level counts toward the parent card's status badge ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).

### Changed

- Dragging to reorder slides the other rows and project groups out of the way, and a row moves as soon as the pointer enters the next one. Reduced motion turns the animation off ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).
- With **Show children that need attention** on, collapsed shelves and projects keep a parent visible while one of its descendants needs attention ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).
- Child rows are more compact and line up under their parent's icon. The count and chevron disclosure is a larger pill ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).

### Fixed

- Pinned threads keep bb's global pin order when grouped by project, and reordering places a pin between the right neighbours ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).
- Only root threads can be pinned. Assigning a different parent unpins a thread; choosing None keeps it pinned ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).
- When a parent and child are in different projects, project filters and collapsed shelves keep the open thread or its nearest visible parent reachable ([#6](https://github.com/yusuf8834/bb-sidebar/pull/6) by [@a-kras](https://github.com/a-kras)).

### Contributors

- Thanks to [@a-kras](https://github.com/a-kras) for the pinning, reordering, drag-and-drop, and nested child-thread improvements in [#6](https://github.com/yusuf8834/bb-sidebar/pull/6).

## [0.2.31] - 2026-10-03

### Fixed

- Matched the development SDK to the stable BB build tools so the extension's SDK check passes in CI.

## [0.2.30] - 2026-10-03

### Fixed

- **Regenerate title** reuses the thread's workspace instead of creating a personal workspace that can stall during setup. Selecting Codex for thread titles now uses a lightweight Codex helper, including for threads running through a custom provider. Turning thread titles off disables regeneration.
- An unnamed thread gets one background title recovery attempt after BB's initial naming request. Recovery follows the selected AI title service, respects Off, and preserves successful or manually edited titles. Codex recovery allows up to 45 seconds for its helper to finish. Attempts are remembered across plugin reloads, with at most two running at once. This provides recovery while [BB's Codex stream issue](https://github.com/get-bb/bb/issues/4828) is investigated.
- Selecting **bb cloud** for sidebar title regeneration now sends the last three user messages to bb cloud through the public account RPC. Automatic tries services in BB's advertised order, with cloud first. Explicit selections keep the existing title on failure and never switch to another service. Unsupported services show an error.
- Pull-request lookups run only while their thread card is visible in the sidebar ([#5](https://github.com/yusuf8834/bb-sidebar/pull/5) by [@amrtawfik160](https://github.com/amrtawfik160)). Initial automatic-settle evaluation is preserved.

### Contributors

- Thanks to [@amrtawfik160](https://github.com/amrtawfik160) for finding that pull-request lookups for off-screen rows could delay other sidebar requests and contributing the fix in [#5](https://github.com/yusuf8834/bb-sidebar/pull/5).

## [0.2.29] - 2026-10-03

### Added

- **Clean** in the Settled header previews only live terminals and verified thread-owned listening ports before asking for confirmation. Threads with nothing to clean and zero counts stay out of the preview. Each listed thread has an Open button for inspection. Clean force-closes the listed terminals and sends graceful shutdown requests to listed port processes. Threads that return to Active or Working are skipped, as are resources in a workspace shared with another non-settled thread. The result lists completed, skipped, failed, and still-listening resources.
- **Dock shelves to the bottom (experimental)**, off by default in sidebar settings. Every shelf after Active (Working, Inactive, Snoozed, Parked, Settled) rests at the bottom of the sidebar, below the space Pinned and Active leave free, as in T3 Code. An open shelf that needs more room extends the list, and everything scrolls together.
- **Working shelf (experimental)**, off by default in sidebar settings. A thread that is working, or has work running under it (child threads, background agents, commands, workflows, goals), moves out of Active into a Working shelf right below it, shown as one line like the other shelves, whether or not **Compact working threads** is on. It returns to its place in Active when all of it is done, or as soon as it fails or needs you. Pinned threads stay pinned, and a thread that just woke from a snooze stays in Active.

### Changed

- The Working shelf's header spinner now turns while the shelf contains live work, and stays still when reduced motion is enabled.
- The thread list scrolls like T3 Code's sidebar: no scrollbar, and an edge fades out only where there is more to scroll, growing with the distance left. Scrolling the list no longer scrolls what is behind it.
- A compact working row stays compact until everything under it is done: its own turn, its background agents, commands and workflows, and any working child or grandchild. It used to unfold into a full card as soon as the parent's own turn ended. It still unfolds at once if the parent needs you or fails. While only its children run, the row shows its usual status or age, and the badge shows the children still working.
- A compact working row keeps its child threads folded, including children that need attention, until you expand them from its badge. Full cards still show those children while folded when **Show children that need attention** is on.

### Fixed

- Clean rechecks a thread before each terminal close and skips terminals in workspaces shared with Active or Working threads. It checks each terminal's own environment and host, even when the thread has moved. Workspace paths are resolved on the host before comparing them, including symlink aliases; unresolved paths block cleanup.
- Clean binds previewed ports to their workspace and process start time, preserves partial shutdown results, and retains preview inspection failures in its final report. Open stays disabled during cleanup and closes the mobile sidebar drawer when used.
- Live descendants remain classified as working even when their unread-success badge takes precedence. A thread requesting input stays in Active, compact Unpin controls remain clickable, and a rename in progress stays mounted while work finishes. If an attention, pin, or dock change interrupts a rename, its draft saves once and its shelf lock clears. Keyboard focus follows the thread or child control between shelves.
- Clean's result remains visible if its last Settled thread leaves the shelf while cleanup is running.
- Scroll-edge fades update when loading or search replaces the list contents.

## [0.2.28] - 2026-10-03

### Added

- **Compact working threads (experimental)**, off by default in sidebar settings. A thread with live work shows as one line, like a settled thread, ending in a small status icon and how long it has run (◌ 6m). It returns to a full card when it finishes, fails, or needs you. Folded rows still reorder, open their child threads, and keep the right-click menu.
- Snooze offers **Pick date & time…** below its shortcuts, in both the row's clock menu and the right-click menu. It opens a calendar and a time field, starting at tomorrow 9:00, and shows the exact wake time before you confirm. Past times and dates more than a year out cannot be picked.

### Changed

- The settings page is reorganised to match bb's own: Shelves, Snooze, Automatic settle, Child threads, Projects, This device, and Experimental. Changes save as you make them, so there is no Save button: the section you changed shows **Saving…** and then **Saved**, or **Not saved** if the save failed. An invalid value shows why and is not saved. The hours and days for the inactive shelf and automatic settle appear only while their switch is on, the snooze shortcuts show the menu they produce, and one project picker serves both the project icon and removing a project.
- The right-click menu lists thread actions as Pin, Snooze, Park thread, Settle.

## [0.2.27] - 2026-10-01

### Added

- A project without an icon shows a letter tile: its first letter on a colour picked from its name, so it looks the same on every machine. Common leading words such as `bb-` are skipped, so `bb-sidebar` shows **S**. The tile also shows while an icon is loading, in the hover card in place of the folder glyph, and in the Project icon settings preview.
- A row shows **Send failed** when a queued message could not be sent, and **Queued** when a message is waiting to send on an otherwise quiet thread, such as a scheduled send. These rows used to show only their age. A failed send also counts as failed in a parent's child summary.
- A pull request in GitHub's merge queue shows **In merge queue**.

### Changed

- Sorting Active by project gives a header only to projects with two or more Active threads. A project with one Active thread stays an ordinary card, so a list without repeated projects reads like manual order.
- Project groups and single cards follow your manual order, with each group drawn where its first thread sits. Dragging a project header, or pressing Alt+Up or Alt+Down on it, moves the whole group; threads inside a group reorder among themselves.
- Collapsing Active also hides the project headers, leaving only the open thread.
- Requires plugin SDK 0.6.5 or newer.

### Fixed

- Automatic settle no longer settles, or stops the runtime of, a thread that is still waiting on you or has live work: a question or approval, queued messages, a workflow, a background agent or command, plan mode, or a goal. It now uses the same rule as the sidebar's **Settle** action.
- Automatic settle no longer settles a thread that is still serving a port from its workspace, such as a dev server. Settling stops the thread's runtime, which also stops processes its agent left running, and some providers do not tell bb about them. A thread whose machine cannot be checked is left alone until the next pass.
- **Settle**, **Park**, and **Snooze** are no longer offered for a thread with a queued or failed message, or for an unread thread whose turn is still running. Settled, parked, and snoozed threads in either state return to Active.
- **Regenerate title** works again on current bb, which no longer exposes the inference model it read. It now generates the title with the thread's own agent and model, at low reasoning.

## [0.2.26] - 2026-09-29

### Added

- Holding Cmd (Ctrl off Mac) labels the first nine rows with bb's own shortcut hints, ⌘ 1 to ⌘ 9, in place of their status. They appear on the same hold delay as bb's hints and match the row each Cmd+digit shortcut opens.
- Each process in a hover card's **Workspace ports** list has a stop button. The first click arms it; a second click within four seconds stops the process.

### Changed

- The **Workspace ports** list in a hover card starts collapsed. Click its header to show the ports.

## [0.2.25] - 2026-09-28

### Changed

- Sorting Active by project now shows each project's name once, in a header with its icon and thread count, instead of on every card. Cards under a header are a line shorter: the title sits beside the status.

### Added

- Project headers collapse. The choice is remembered, and a collapsed project still shows the open thread.

## [0.2.24] - 2026-09-27

### Fixed

- A thread's hover card no longer lists pull requests from commands that only mention `gh pr create`, such as a search of another thread's log. Only commands that run it count.

## [0.2.23] - 2026-09-27

### Added

- Hover cards have a collapsible **Pull requests** section listing every pull request a thread opened with `gh pr create`, newest first, with each PR's title and status. Before, only the PR on the thread's current branch was shown. Status comes from `gh` on the thread's machine; without it, the list still shows PR numbers and links. In a shared project checkout, a thread lists only the PRs it opened, not the checkout branch's PR.

## [0.2.22] - 2026-09-27

### Added

- A **Child threads** settings section. **Sort** orders child threads by date created or last activity, ascending or descending, in the sidebar, the thread header popup, the parent's badge, and hover cards. **Child thread icon** shows a colour circle per thread (the default) or the agent's provider icon; with provider icons, the parent's badge shows each agent once. The defaults keep the previous look and oldest-first order ([#3](https://github.com/yusuf8834/bb-sidebar/pull/3) by [@a-kras](https://github.com/a-kras)).

### Improved

- The child-thread tree line sits under the parent's title, and child rows sit closer to it ([#3](https://github.com/yusuf8834/bb-sidebar/pull/3) by [@a-kras](https://github.com/a-kras)).

### Fixed

- A slow, older settings load arriving after a newer one no longer rolls the sidebar back to the previous settings ([#3](https://github.com/yusuf8834/bb-sidebar/pull/3) by [@a-kras](https://github.com/a-kras)).
- The thread header's child-thread popup stays inside the window and scrolls a long list instead of running off screen.

### Contributors

- Thanks to [@a-kras](https://github.com/a-kras) for designing and contributing the Child threads settings (sort order and provider icons), the tighter child-thread indent, and the settings-load race fix in [#3](https://github.com/yusuf8834/bb-sidebar/pull/3).

## [0.2.21] - 2026-09-23

### Added

- Show a spinner and "Loading threads…" while bb loads the thread list, instead of an empty list. It appears only if loading takes longer than 200 ms, so fast loads do not flicker.
- The delete confirmation now names the thread and its project, and says how many child threads go with it, so a right-click delete in a busy list cannot be mistaken for another thread. The sidebar owns this dialog and deletes through bb's SDK instead of opening bb's generic "Delete thread?" prompt.

### Fixed

- A project icon that failed to load once, for example while bb's host was still starting, no longer stays hidden until the sidebar reloads. The sidebar retries with backoff, and the server reports a read failure as temporary instead of caching it as "no icon".

## [0.2.20] - 2026-09-21

### Added

- Show every child-thread status in expanded rows: Failed, Needs you, Unread, Working or Monitoring with duration, Planning, Workflow, Agent, Command, Goal, Draft, and Drafting, using the same vocabulary as thread cards.
- Keep every child that reports a status visible while its section is collapsed, not only running ones. The "Show running children" setting is now "Show children that need attention"; its saved value carries over.

### Improved

- Child-thread rows size the status column to its label, so short statuses and ages leave more room for the title in a narrow sidebar.
- Search results give the title priority over a long project name in a narrow sidebar.
- The dark needs-you child row has a stronger tint and a leading amber edge.

### Fixed

- Status colours follow bb's theme instead of the OS colour scheme, so a dark bb on a light OS (or the reverse) no longer shows low-contrast statuses or a light needs-you band.
- On touch screens, Failed, Unread, and idle ages stay visible beside the snooze and settle actions instead of being hidden behind them.
- A woken thread shows "Woke" beside its current status in cards and search results instead of replacing it.

## [0.2.19] - 2026-09-19

### Added

- Support configurable snooze shortcuts for this evening, tomorrow morning, and next week, using local calendar times.

### Improved

- Sort parent-thread choices by recent activity in a single list.

### Fixed

- After parking or snoozing the open thread, select the first Pinned thread, then the first Active thread, or open the new-thread page when both sections are empty.

## [0.2.18] - 2026-09-19

### Improved

- Show one branch-name line in thread hover cards, using the worktree icon for worktrees and the branch icon for plain checkouts, matching the thread card.
- Add Park thread at the bottom of the snooze icon's menu.
- Reuse the section status icons for thread context-menu actions and Park thread in the snooze menu.

### Fixed

- Pinning a thread clears Settled, Snoozed, and Parked states. Settling, snoozing, or parking a thread removes its pin.

## [0.2.17] - 2026-09-18

### Added

- Add small rounded icons to Pinned, Active, Inactive, Snoozed, Parked, and Settled section headers.

### Improved

- Move Parked directly below Snoozed, before Settled.

### Fixed

- After settling the open thread, select the first Pinned thread, then the first Active thread in its current sort order, or open the new-thread page when both sections are empty.

## [0.2.16] - 2026-09-18

### Added

- Add a Parked section for threads waiting on others, with Resume, Undo, waiting age, and protection from automatic cleanup.
- Add a searchable Parent submenu for assigning or removing a thread's parent.
- Add expandable subthreads to thread hover cards.
- Offer to close thread-owned ports when settling a thread.

### Improved

- Improve drag-and-drop thread reordering and keyboard accessibility.

### Fixed

- Preserve inbox order across remounts and respect disabled inactivity settings.

## [0.2.15] - 2026-09-16

### Added

- Add Undo actions after settling, un-settling, and waking a snoozed thread.

### Removed

- Remove thread multi-selection and bulk actions.
- Remove project icon lookup through `t3.json`.

### Improved

- Shorten the README feature documentation.

## [0.2.14] - 2026-09-15

### Improved

- Add a green glow, gentle checkmark tilt, and five sparkles to the settle button, with light and dark styling, keyboard focus, and reduced-motion support.
- Keep the settle button's hit area fixed so hovering near a corner does not cause flickering.
- Remove the settle tooltip while preserving its accessible label.

## [0.2.12] - 2026-09-12

### Fixed

- Keep snooze, settle, and restore actions visible on touch devices, with parked thread labels and snooze countdowns beside the restore button ([#2](https://github.com/yusuf8834/bb-sidebar/pull/2) by [@banjerluke](https://github.com/banjerluke)).
- Group the unpin button with card actions, or with the status and Woke label when parking actions are unavailable.
- Keep the status visible when focusing Unpin on cards without parking actions.

### Contributors

- Thanks to [@banjerluke](https://github.com/banjerluke) for finding that row and card actions were unreachable on touch devices and contributing the fix in [#2](https://github.com/yusuf8834/bb-sidebar/pull/2).

## [0.2.11] - 2026-09-11

### Added

- Show monitoring runtimes as "Monitoring" on thread cards when BB reports that state.
- Added compact hover cards to main, child, grandchild, snoozed, and settled threads, showing project, machine, branch, provider, model, and reasoning details.
- Show project icons in hover cards when available, with a folder icon as fallback.

### Improved

- Moved thread details from the provider icon tooltip to the thread row, with support for keyboard focus.

## [0.2.10] - 2026-09-10

### Added

- Kept running child and grandchild threads visible while their child sections are collapsed. A new setting controls the behavior and is enabled by default.

### Improved

- Released thread runtimes when work is settled and closed only terminal sessions without user input, while preserving terminals the user interacted with.

## [0.2.9] - 2026-09-09

### Added

- Added a search row to the project scope card. Opening the scope picker puts the caret in a filter field above the list, so a long project list is reachable by typing, with arrow keys and Enter to pick a match.

## [0.2.8] - 2026-09-08

### Added

- Rolled child thread state up into the parent card's child badge. The badge now carries a glyph and tint for the most urgent child or grandchild: failed, needs you, done, or working, and its tooltip lists the counts.
- Highlighted the active child or grandchild row in the sidebar tree, the same way the active parent card is highlighted.

### Fixed

- Let a parent card collapse while one of its children is the active thread. A collapsed list now keeps only the active child visible, the same way a collapsed shelf keeps its active thread, and the grandchild disclosure behaves the same way.

## [0.2.7] - 2026-09-06

### Added

- Showed how long a thread has been working next to its live status, such as "Working · 5m" or "Planning · 2h". The count starts when the sidebar first sees the thread busy, survives reloads, and resets after the thread stops or asks for input.
- Added a Project submenu to thread cards with project settings, rename, local path setup, and removal with typed confirmation.
- Added Copy thread link for project and personal threads.
- Added inline rename to child and grandchild thread menus.
- Added discovery of conventional root-level project icons.

### Fixed

- Avoided pull request lookups for pinned, running, pending, snoozed, and manually overridden threads during automatic cleanup.
- Added inline validation for automatic cleanup thresholds and snooze shortcuts, including a preview of the saved snooze menu.
- Fixed styling scope for project menus and dialogs, including padding, typography, and focus rings.

### Improved

- Updated the plugin description and source comments to reflect optional sort modes.
- Documented how closed and merged pull requests participate in automatic cleanup.

## [0.2.6] - 2026-09-05

### Fixed

- Bounded the browser cache to 500 lifecycle records and 100 expanded-thread IDs to prevent unbounded storage growth ([#1](https://github.com/yusuf8834/bb-sidebar/pull/1) by [@elianiva](https://github.com/elianiva)).
- Recovered from storage-quota errors by evicting sidebar caches one at a time, stopping as soon as the write succeeds to preserve remaining preferences ([#1](https://github.com/yusuf8834/bb-sidebar/pull/1) by [@elianiva](https://github.com/elianiva)).
- Preserved expansion recency across restarts so pruning removes the oldest entries.

### Contributors

- Thanks to [@elianiva](https://github.com/elianiva) for finding the unbounded browser storage growth and contributing the cache limits and quota-error recovery in [#1](https://github.com/yusuf8834/bb-sidebar/pull/1).

## [0.2.5] - 2026-09-05

### Added

- Added **Regenerate title** to thread context menus. Titles use only the last three accepted user-message texts, or fewer when available.
- Added a subtle spinner beside the title during generation, shared across cards, shelves, child rows, and search results, with reduced-motion support.

### Improved

- Used bb's configured inference model and fallback through a temporary hidden helper, with cleanup after generation and protection for manual title changes.
- Kept pending threads available instead of automatically settling them.
- Aligned the development CLI with Plugin SDK 0.4.47. Requires bb 0.42.0 or later and Plugin SDK 0.4.47 or later.

## [0.2.4] - 2026-08-30

### Added

- Added project removal to plugin settings with a compact two-step confirmation and server-side checks.
- Added archive actions to child and grandchild thread menus. Archived descendants no longer appear in badges, counts, or lists.
- Added CI checks for the SDK contract, tests, type checking, and production build.

### Improved

- Kept active child and grandchild threads visible when their surrounding shelves or lists are collapsed.
- Included matching child threads in search and made lifecycle, ordering, icon, and settings refreshes resilient to stale responses.
- Kept thread-card metadata in a stable reading order.

## [0.2.3] - 2026-08-26

### Added

- Added a collapsed grandchild level to the shared header and sidebar child-thread list, with per-child counts, disclosures, status styling, and thread navigation.

### Improved

- Kept parent badges scoped to direct children while exposing one nested level beneath each child.
- Matched child-title typography between the header menu and sidebar rows.

## [0.2.2] - 2026-08-26

### Added

- Added expandable child-thread badges to parent cards, including identity colors, direct-child counts, running and attention states, and persistent inline child lists.

### Improved

- Refreshed thread card styling and tightened child-row typography.
- Updated the README screenshots to show child threads in light and dark modes.

## [0.2.1] - 2026-08-25

### Fixed

- Prevented inactive, snoozed, and settled threads from briefly appearing under Active when returning from Settings or restarting bb.

## [0.2.0] - 2026-08-24

### Added

- Added a separate Pinned shelf above Active.
- Added an optional Inactive shelf for unpinned threads without recent activity, with a configurable hour threshold.
- Added automatic project icon detection and per-project image uploads.
- Added an empty state when no active threads remain.

### Improved

- Rebuilt the plugin settings page with related controls grouped into clear sections.
- Added a native file picker and current-icon preview to the project icon settings.
- Kept Pinned, Active, Inactive, Snoozed, and Settled expansion states across reloads.

### Fixed

- Kept the settings toggle thumb inside its track in both states.

## [0.1.3] - 2026-08-24

### Added

- Added an Active sort menu with Manual order, Recent activity, Date created, and Project options.
- Added project grouping with a faint outline around projects that contain multiple active threads.

### Improved

- Preserved saved manual order when viewing activity or creation-date sorts.
- Remembered the selected Active sort mode across reloads.
- Replaced the project-grouping icon with a simpler sort icon.

### Fixed

- Removed the focus outline that remained around the sort icon after choosing an option with the pointer.

## [0.1.2] - 2026-08-24

### Fixed

- Corrected the package and plugin identity to `bb-sidebar`, matching the repository and marketplace entry.
- Rebuilt frontend styles for the `bb-sidebar` scope so hover actions load correctly after installation.
- Removed the obsolete internal product name from source comments and release notes.

## [0.1.1] - 2026-08-24

### Added

- Added a collapsible Active section that remembers its state and keeps the open thread visible.
- Added project names to Snoozed rows, matching Settled rows.

### Improved

- Tightened spacing between the Snooze and Settle hover actions.
- Increased parked-row title contrast, muted project labels, and enlarged the separator dot.

### Fixed

- Hid the extra Snooze dropdown chevron without changing menu behavior.
- Fixed plugin stylesheet scoping after the BB Sidebar rename.

## [0.1.0] - 2026-08-23

- Initial public release.

[0.2.9]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yusuf8834/bb-sidebar/releases/tag/v0.1.0

[0.2.16]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.15...v0.2.16
[0.2.17]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.16...v0.2.17
