# BB Sidebar

A calmer thread list for [bb](https://github.com/get-bb/bb), inspired by T3 Code. Threads stay where you put them while status, snooze, settle, and bulk actions remain close at hand.

![BB Sidebar running in bb](docs/screenshots/sidebar.png)

## Features

- Stable inbox ordering with drag and keyboard reordering
- Pinned, Snoozed, and Settled shelves
- Project filtering and multi-select bulk actions
- Live status, branch, pull request, and provider details
- Native bb navigation, split, rename, archive, and delete flows

## Install

```sh
bb plugin install git:https://github.com/yusuf8834/bb-t3sidebar.git
```

Then choose **BB Sidebar** under **Settings > Appearance > Sidebar**.

## Development

```sh
npm install
npm run build
bb plugin install path:. --yes
```

Directly inspired by [T3 Code](https://github.com/pingdotgg/t3code). See [LICENSE](LICENSE).
