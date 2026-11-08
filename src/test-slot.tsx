import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginSdkApp, PluginThreadActionEntry } from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot as sdkRenderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";

const SplitSources = createContext<Array<{ threadId: string }> | null>(null);
installTestPluginRuntime();
const runtime = (globalThis as typeof globalThis & { __bbPluginRuntime: { pluginSdkApp: PluginSdkApp } })
  .__bbPluginRuntime.pluginSdkApp;
const useSdkSplit = runtime.experimental_useSidebarThreadSplit;
// The SDK 0.6.37 fake still records pointer bindings in its now-private legacy
// log. Observe the same source event without conflating it with navigation.
runtime.experimental_useSidebarThreadSplit = (threadId) => {
  const split = useSdkSplit(threadId);
  const sources = useContext(SplitSources);
  return {
    ...split,
    splitProps: {
      ...split.splitProps,
      onPointerDown: (event) => {
        split.splitProps.onPointerDown?.(event);
        sources?.push({ threadId });
      },
    },
  };
};

/** A link click bb's slot wrapper would route: a plain open, or a split. */
type LinkCall = { href: string; split: boolean };
let linkCalls: LinkCall[] | null = null;
// The official fake leaves anchors to jsdom, which cannot navigate. Mirror the
// host: after React's handlers, take an unprevented primary click on a link.
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!linkCalls || !link || event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
  event.preventDefault();
  linkCalls.push({ href: link.getAttribute("href") ?? "", split: event.metaKey || event.ctrlKey });
});

/** Supply core registrations explicitly: the official fake does not emulate them. */
export function renderSlot<Props extends object>(
  slot: { component: ComponentType<Props> },
  props: Props,
  options: RenderSlotOptions & {
    archiveThread?: (threadId: string, sdk: ReturnType<typeof useSdk>) => Promise<unknown>;
  } = {},
) {
  const threadActionCalls: Array<{ key: string; threadId: string }> = [];
  const renderedLinkCalls: LinkCall[] = [];
  linkCalls = renderedLinkCalls;
  const splitSourceCalls: Array<{ threadId: string }> = [];
  const response = async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId });
  const sdk = {
    ...options.sdk,
    threads: {
      get: response,
      update: response,
      pin: response,
      unpin: response,
      archive: async ({ threadId }: { threadId: string }) => ({ ok: true as const, archivedThreadIds: [threadId] }),
      unarchive: async () => ({ ok: true as const }),
      markRead: response,
      markUnread: response,
      experimental_listCascade: async ({ threadIds }: { threadIds: readonly string[] }) => ({
        threads: threadIds.map((threadId) => ({ threadId, cascadeThreadIds: [] })),
      }),
      ...options.sdk?.threads,
    },
  };
  const threadActions: NonNullable<RenderSlotOptions["threadActions"]> = (thread, { requestRename }) => {
    const client = useSdk();
    const navigate = useBbNavigate();
    const entry = (id: string, label: string, run: () => void | Promise<unknown>): PluginThreadActionEntry => ({
      key: `bb--core/${id}`,
      pluginId: "bb--core",
      group: "organize",
      action: {
        label,
        icon: "Pin",
        async run() {
          threadActionCalls.push({ key: `bb--core/${id}`, threadId: thread.id });
          try {
            await run();
          } catch (error) {
            // Host-bound actions log failures and always resolve.
            console.error(`thread action "bb--core/${id}" failed`, error);
          }
        },
      },
    });
    return [
      entry("split", "Open in split", () => navigate.toThread(thread.id, { split: true })),
      entry("pin", thread.pinnedAt === null ? "Pin" : "Unpin", async () => {
        try {
          await (thread.pinnedAt === null
            ? client.threads.pin({ threadId: thread.id })
            : client.threads.unpin({ threadId: thread.id }));
        } catch (error) {
          // The core pin registration owns its mutation error toast.
          const { toast } = await import("sonner");
          toast.error(thread.pinnedAt === null ? "Failed to pin thread." : "Failed to unpin thread.", {
            description: error instanceof Error ? error.message : undefined,
          });
        }
      }),
      entry("read", thread.isUnread ? "Mark read" : "Mark unread", () =>
        thread.isUnread
          ? client.threads.markRead({ threadId: thread.id })
          : client.threads.markUnread({ threadId: thread.id }),
      ),
      entry("rename", "Rename", () => requestRename(thread.id)),
      entry(
        "archive",
        "Archive",
        () => options.archiveThread?.(thread.id, client) ?? client.threads.archive({ threadId: thread.id }),
      ),
      // Keep accidental native delete requests observable without emulating its dialog.
      entry("delete", "Delete", () => undefined),
    ];
  };
  const Component = slot.component;
  let renderedUi: { node: ReactNode } | null = null;
  const Wrapped = (componentProps: Props): ReactNode => (
    <SplitSources.Provider value={splitSourceCalls}>
      {renderedUi ? renderedUi.node : <Component {...componentProps} />}
    </SplitSources.Provider>
  );
  const rendered = sdkRenderSlot({ ...slot, component: Wrapped }, props, {
    ...options,
    sdk,
    threadActions: options.threadActions ?? threadActions,
  });
  const sdkRerender = rendered.lifecycle.rerender;
  const rerender = (ui: ReactNode) => {
    renderedUi = { node: ui };
    sdkRerender(<Wrapped {...props} />);
  };
  rendered.rerender = rerender;
  rendered.lifecycle.rerender = rerender;
  return Object.assign(rendered, { threadActionCalls, splitSourceCalls, linkCalls: renderedLinkCalls });
}
