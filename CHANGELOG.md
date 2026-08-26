# Changelog

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

[0.2.2]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yusuf8834/bb-sidebar/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yusuf8834/bb-sidebar/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yusuf8834/bb-sidebar/releases/tag/v0.1.0
