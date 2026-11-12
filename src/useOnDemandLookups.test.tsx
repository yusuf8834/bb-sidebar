// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ON_DEMAND_TTL_MS, useOnDemandLookups } from "./useOnDemandLookups";
import { deferred } from "./test-fixtures";

afterEach(() => vi.useRealTimers());

function setup(eligible: ReadonlySet<string> = new Set(["a"])) {
  const answers: ReturnType<typeof deferred<string>>[] = [];
  const fetch = vi.fn(() => {
    const answer = deferred<string>();
    answers.push(answer);
    return answer.promise;
  });
  const hook = renderHook(({ keys }) => useOnDemandLookups(fetch, keys), { initialProps: { keys: eligible } });
  return { fetch, answers, hook };
}

it("asks once per key at a time, reuses an answer for 30s, and lets a forced look through", async () => {
  vi.useFakeTimers();
  const { fetch, answers, hook } = setup(new Set(["a", "b"]));
  act(() => {
    hook.result.current.lookUp("a");
    hook.result.current.lookUp("a");
    hook.result.current.lookUp("other");
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => answers[0]!.resolve("first"));
  expect(hook.result.current.values.get("a")).toBe("first");
  act(() => vi.advanceTimersByTime(29_000));
  act(() => hook.result.current.lookUp("a"));
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() => hook.result.current.lookUp("a", true));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => answers[1]!.resolve("forced"));
  expect(hook.result.current.values.get("a")).toBe("forced");
});

it("retries after a failure and keeps nothing from it", async () => {
  const { fetch, answers, hook } = setup();
  act(() => hook.result.current.lookUp("a"));
  await act(async () => answers[0]!.reject(new Error("offline")));
  expect(hook.result.current.values.size).toBe(0);
  act(() => hook.result.current.lookUp("a"));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("drops an answer when its key stops being eligible, and does not bring it back", async () => {
  const { answers, hook } = setup();
  act(() => hook.result.current.lookUp("a"));
  await act(async () => answers[0]!.resolve("warning"));
  hook.rerender({ keys: new Set() });
  expect(hook.result.current.values.size).toBe(0);
  hook.rerender({ keys: new Set(["a"]) });
  expect(hook.result.current.values.size).toBe(0);
});

it("ignores an answer that lands after its key stopped being eligible", async () => {
  const { answers, hook } = setup();
  act(() => hook.result.current.lookUp("a"));
  hook.rerender({ keys: new Set() });
  await act(async () => answers[0]!.resolve("late"));
  hook.rerender({ keys: new Set(["a"]) });
  expect(hook.result.current.values.size).toBe(0);
});

it("expires an answer after the bounded time", async () => {
  vi.useFakeTimers();
  const { answers, hook } = setup();
  act(() => hook.result.current.lookUp("a"));
  await act(async () => answers[0]!.resolve("warning"));
  act(() => vi.advanceTimersByTime(ON_DEMAND_TTL_MS - 1));
  expect(hook.result.current.values.get("a")).toBe("warning");
  act(() => vi.advanceTimersByTime(1));
  expect(hook.result.current.values.size).toBe(0);
});
