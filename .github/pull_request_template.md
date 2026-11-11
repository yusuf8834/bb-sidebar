## Why

<!-- What was wrong or missing, and who it affects. Link the issue: "Fixes #123". -->

## What changed

<!-- The changes a reviewer needs to know, in a few bullets. -->

## Screenshots

<!--
Required when the PR changes anything a user can see: rows, cards, glyphs,
labels, menus, hover cards, settings, colours, spacing or motion.
Otherwise delete this section.

- Show before and after, taken in the same state, side by side.
- Changed colours or tones: include light and dark.
- Changed layout: include the narrow sidebar or compact view if it is affected.
- Changed motion: attach a short recording, or say how it behaves.
- Drag the images into this description; GitHub hosts them for you.
- No bb at hand? `npm run e2e` and `npm run e2e:smoke` start an isolated
  scratch bb (see e2e/README.md).
-->

| Before | After |
| --- | --- |
|  |  |

## How I verified

<!--
- `npm run check` result, and any e2e you ran.
- New or changed tests, and whether they fail without the change.
- What you checked by hand, in which bb version.
-->

## Merge Danger

**Door:** <!-- two-way: a revert fully undoes it (UI, labels, glyphs).
one-way: a revert can't fully undo it (migrations, settings or storage formats,
storage keys, minimum bb/SDK version, removed features). -->

**Blast Radius:** <!-- small: one component or rare path. medium: a common path
(shelves, sorting, menus). large: every user, every time (inbox render, server
start, install). Say why. -->

## Checklist

- [ ] `npm run check` passes
- [ ] CHANGELOG entry under Unreleased, for user-visible changes
- [ ] Screenshots for visual changes, or this PR changes nothing a user can see
- [ ] No AI tool, model or agent credited as an author or co-author
