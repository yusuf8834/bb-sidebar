// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "./test-slot";
import { thread } from "./test-inbox";
import { useThreadActions } from "./bb-sdk";

afterEach(cleanup);

it.each([null, "env_1"])("normalizes sidebar environment id %s for bound actions", (id) => {
  const selected = thread({
    environment: {
      id,
      path: "/workspace",
      name: null,
      branchName: null,
      isWorktree: null,
      providerId: null,
      workspaceDisplayKind: null,
    },
  });
  // What reached bb; SDK 0.6.202 types it as `{ id }`, older SDKs as the full target.
  const targets: unknown[] = [];
  renderSlot(
    {
      component: () => {
        useThreadActions(selected, { keys: ["bb--core/pin"] });
        return null;
      },
    },
    {},
    {
      threadActions: (target) => {
        targets.push(target);
        return [];
      },
    },
  );
  expect(targets.at(-1)).toMatchObject({ id: selected.id, environment: id ? { id, path: "/workspace" } : null });
});
