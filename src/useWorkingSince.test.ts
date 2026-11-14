// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { sidebarThread } from "./test-fixtures";
import { useWorkingSince } from "./useWorkingSince";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const STARTED = 1_000_000_000;

function working(id: string): PluginSidebarThread {
  const times = { createdAt: STARTED, updatedAt: STARTED, latestAttentionAt: STARTED };
  return sidebarThread({ ...times, id, title: id, indicator: "runtime", lastReadAt: null });
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
