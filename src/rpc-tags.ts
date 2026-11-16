/**
 * Tags of the sidebar's own server reads in bb's query cache. A read declares
 * its tags in the browser contract (`sidebarReads` in `src/bb-sdk.ts`). The
 * server code that changes the data calls `bb.rpc.experimental_invalidate`
 * with the same tags after the write, and every open client rereads.
 */
export const PROJECT_COLORS_TAG = "project-colors";
export const SIDEBAR_SETTINGS_TAG = "sidebar-settings";
export const INBOX_ORDER_TAG = "inbox-order";
export const LIFECYCLE_TAG = "lifecycle";
/** The standard projects `listProjects` returns: their ids and names. */
export const PROJECTS_TAG = "projects";
/** Side chats from bb's Side chat plugin, which bb's own sidebar view leaves out. */
export const SIDE_CHATS_TAG = "side-chats";
