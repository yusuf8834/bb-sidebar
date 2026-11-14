/**
 * Tags of the sidebar's own server reads in bb's query cache. A read declares
 * its tags in the browser contract (`sidebarReads` in `src/bb-sdk.ts`). The
 * server code that changes the data calls `bb.rpc.experimental_invalidate`
 * with the same tags after the write, and every open client rereads.
 */
export const PROJECT_COLORS_TAG = "project-colors";
