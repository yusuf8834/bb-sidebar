import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
  experimental_useThreadActions,
  type useSdk,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useRef } from "react";
import type {
  PluginRpcContract,
  PluginRpcResult,
  PluginSidebarThread,
  PluginThreadActionsOptions,
  StandardSchemaV1,
  experimental_PluginRpcCallError,
} from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./contract";
import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  type EnvironmentPullRequest,
  type EnvironmentPullRequestRow,
} from "./github-pr-status";
import {
  INBOX_ORDER_TAG,
  LIFECYCLE_TAG,
  PROJECT_COLORS_TAG,
  PROJECTS_TAG,
  SIDE_CHATS_TAG,
  SIDEBAR_SETTINGS_TAG,
} from "./rpc-tags";

export {
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_ShortcutHint as ShortcutHint,
  // bb 0.49.0, the minimum host (engines.bb), ships it, so it has no fallback.
  experimental_ProviderIcon as ProviderIcon,
  // bb's own thread-status rule. bb 0.49.0, the minimum host (engines.bb),
  // ships it, so it has no fallback.
  experimental_resolveThreadStatus as resolveThreadStatus,
} from "@get-bb/plugin-sdk/app";

export function useThreadActions(thread: PluginSidebarThread, options?: PluginThreadActionsOptions) {
  const environment = thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null;
  // bb 0.50.2 nightlies type the target as `{ id }` and resolve the rest from
  // the id; older bb reads the fields, including this `environment`. A
  // variable, not a literal, so both typings accept the extra fields.
  const target = { ...thread, environment };
  return experimental_useThreadActions(target, options);
}

/** How many other threads bb deletes with this one, archived ones and lifecycle dependents included. */
export async function countDeleteCascade(sdk: ReturnType<typeof useSdk>, threadId: string, signal: AbortSignal) {
  const { threads } = await sdk.threads.experimental_listCascade({ threadIds: [threadId], action: "delete", signal });
  return threads[0]?.cascadeThreadIds.length ?? 0;
}

// The browser bundle stays free of zod, so the GitHub PR Status contract uses
// hand-written Standard Schemas. bb validates only the input against them;
// rows arrive as the plugin sent them.
function schema<T>(validate: (value: unknown) => value is T): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "bb-sidebar",
      validate: (value) => (validate(value) ? { value } : { issues: [{ message: "Unexpected value" }] }),
    },
  };
}

const githubPrStatusContract = {
  pullRequests: {
    input: schema(
      (value): value is { keys: string[] } =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { keys?: unknown }).keys) &&
        (value as { keys: unknown[] }).keys.every((key) => typeof key === "string"),
    ),
    output: schema(
      (value): value is Record<string, EnvironmentPullRequestRow> => typeof value === "object" && value !== null,
    ),
  },
} satisfies PluginRpcContract;

/**
 * The PR for an environment's checked-out branch, from the bundled GitHub PR
 * Status plugin. A query error, no PR, an unavailable machine, and a disabled
 * plugin all show nothing.
 */
export function useEnvironmentPullRequest(environmentId: string | null): EnvironmentPullRequest | null {
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN_ID,
    contract: githubPrStatusContract,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const row = environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row.pullRequest : null;
}

type SidebarRpc = typeof bbSidebarRpcContract;
type NoInput = Record<string, never>;

/**
 * One of the sidebar's own `{}` reads, for bb's query cache. bb computes a
 * read's tags in the browser from this contract; the server still validates
 * input and output against the zod contract, so these schemas only check shape.
 */
function taggedRead<Method extends keyof SidebarRpc>(tags: readonly string[]) {
  return {
    input: schema(
      (value): value is NoInput => typeof value === "object" && value !== null && Object.keys(value).length === 0,
    ),
    output: schema((_value): _value is PluginRpcResult<SidebarRpc[Method]> => true),
    tags: () => tags,
  };
}

const sidebarReads = {
  getProjectColors: taggedRead<"getProjectColors">([PROJECT_COLORS_TAG]),
  getSidebarSettings: taggedRead<"getSidebarSettings">([SIDEBAR_SETTINGS_TAG]),
  listProjects: taggedRead<"listProjects">([PROJECTS_TAG]),
  listInboxOrder: taggedRead<"listInboxOrder">([INBOX_ORDER_TAG]),
  listLifecycle: taggedRead<"listLifecycle">([LIFECYCLE_TAG]),
  // Settling or waking a source thread changes which side chats are listed.
  listSideChats: taggedRead<"listSideChats">([SIDE_CHATS_TAG, LIFECYCLE_TAG]),
} satisfies PluginRpcContract;

interface SidebarRead<T> {
  /** The last server answer; undefined until the first one lands. */
  data: T | undefined;
  error: experimental_PluginRpcCallError | null;
  /** Reread now, whatever the cache's freshness. Stable across renders. */
  refresh(): Promise<void>;
}

/**
 * Read the sidebar's own server through bb's shared query cache. Reads of
 * the same method share one request, refresh when the server invalidates
 * their tags, and refresh after bb reconnects. Server code that changes the
 * data must call `bb.rpc.experimental_invalidate` with the read's tags.
 */
export function useSidebarRead<Method extends keyof typeof sidebarReads>(
  method: Method,
  { enabled = true }: { enabled?: boolean } = {},
): SidebarRead<PluginRpcResult<(typeof sidebarReads)[Method]>> {
  const query = experimental_useRpcQuery({ contract: sidebarReads, method, input: {}, enabled });
  // The hook returns a new refetch on every render; keep callers' effects still.
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;
  const refresh = useCallback(() => refetch.current(), []);
  return { data: query.data, error: query.error, refresh };
}
