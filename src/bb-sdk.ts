import { experimental_useRpcKeyedQuery, experimental_useThreadActions, type useSdk } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type {
  PluginAppSlots,
  PluginRpcContract,
  PluginSidebarThread,
  PluginThreadActionsOptions,
  StandardSchemaV1,
} from "@get-bb/plugin-sdk/app";
import {
  GITHUB_PR_STATUS_PLUGIN_ID,
  type EnvironmentPullRequest,
  type EnvironmentPullRequestRow,
} from "./github-pr-status";

export {
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_ShortcutHint as ShortcutHint,
} from "@get-bb/plugin-sdk/app";

/** Props bb passes to a thread header action. */
export interface ThreadHeaderActionProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

interface RetiredHeaderSlot {
  experimental_threadHeaderAction(registration: {
    id: string;
    title: string;
    component: ComponentType<ThreadHeaderActionProps>;
  }): void;
}

/**
 * SDK 0.6.94 dropped this slot from its types, but bb 0.47 and 0.48 still
 * render it (`bb plugin build` warns). Header thread actions are plain buttons,
 * so the parent chip keeps this slot until it is redesigned.
 */
export function registerThreadHeaderAction(
  slots: PluginAppSlots,
  registration: Parameters<RetiredHeaderSlot["experimental_threadHeaderAction"]>[0],
) {
  (slots as PluginAppSlots & RetiredHeaderSlot).experimental_threadHeaderAction(registration);
}

export function useThreadActions(thread: PluginSidebarThread, options?: PluginThreadActionsOptions) {
  const environment = thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null;
  return experimental_useThreadActions({ ...thread, environment }, options);
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
