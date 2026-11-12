// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { idleSidebarThreadFields } from "./test-fixtures";
import { useWorkingSince } from "./useWorkingSince";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const STARTED = 1_000_000_000;

function working(id: string): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    id,
    projectId: "proj_1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "runtime",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: STARTED,
    updatedAt: STARTED,
    lastReadAt: null,
    latestAttentionAt: STARTED,
  };
}

type Props = { threads: readonly PluginSidebarThread[]; status: "error" | "loading" | "ready" };

it("keeps saved stamps while the list loads or fails, and reconciles once it is ready", () => {
  localStorage.setItem(STORAGE_KEYS.workingSince.key, JSON.stringify({ a: STARTED, gone: STARTED }));
  const hook = renderHook(({ threads, status }: Props) => useWorkingSince(threads, status), {
    initialProps: { threads: [], status: "loading" },
  });
  expect(hook.result.current.get("a")).toBe(STARTED);
  hook.rerender({ threads: [], status: "error" });
  expect(hook.result.current.get("a")).toBe(STARTED);
  hook.rerender({ threads: [working("a")], status: "ready" });
  expect(hook.result.current.get("a")).toBe(STARTED);
  expect(hook.result.current.has("gone")).toBe(false);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.workingSince.key)!)).toEqual({ a: STARTED });
});
