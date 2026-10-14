import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { lastUserMessages, parseTitle } from "./regenerate-title";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

function message(id: number, text: string, extra = {}) {
  return {
    kind: "conversation",
    role: "user",
    initiator: "user",
    id: String(id),
    text,
    createdAt: id,
    sourceSeqStart: id,
    turnRequest: { status: "accepted" },
    ...extra,
  };
}
function page(rows: unknown[], older = false) {
  return {
    rows,
    timelinePage: {
      hasOlderRows: older,
      olderCursor: older ? { anchorId: "older", anchorSeq: 4 } : null,
    },
  };
}

const cloudService = {
  id: "bb",
  pluginId: "bb-ai",
  displayName: "bb cloud",
  tasks: ["thread-title"],
  automaticRank: 0,
  status: { ready: true },
};
const codexService = {
  id: "codex",
  pluginId: "provider-codex",
  displayName: "Codex",
  tasks: ["thread-title"],
  automaticRank: 1,
  status: { ready: true },
};

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  const sdk = harness.inspection.sdk;
  sdk.stub("threads.get", async () =>
    makeThreadResponse({
      id: "target",
      projectId: "project",
      environmentId: "workspace",
      providerId: "codex",
      title: "Original title",
    }),
  );
  sdk.stub("threads.timeline", async () =>
    page([
      message(1, "Old excluded request"),
      message(2, "Build a sidebar"),
      message(3, "Add title regeneration"),
      message(4, "Use three user messages"),
      message(5, "Assistant must be excluded", { role: "assistant" }),
    ]),
  );
  sdk.stub("providers.models", async () => ({ models: [{ id: "primary", model: "primary", isDefault: true }] }));
  sdk.stub("providers.list", async () => [{ id: "codex", available: true }]);
  sdk.stub("system.aiServices", async () => ({
    selections: { "thread-title": { mode: "automatic" } },
    services: [codexService],
  }));
  sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "helper" }));
  sdk.stub("threads.wait", async () => ({ matched: true }));
  sdk.stub("threads.output", async () => ({
    output: '{"title":"Regenerate sidebar titles"}',
  }));
  sdk.stub("threads.stop", async () => ({ ok: true }));
  sdk.stub("threads.delete", async () => ({ ok: true }));
  sdk.stub("threads.update", async () => makeThreadResponse({ title: "Regenerate sidebar titles" }));
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  return {
    bb,
    harness,
    sdk,
    run: () => harness.behavior.callRpc("regenerateTitle", { threadId: "target" }),
  };
}

describe("title regeneration", () => {
  it("sends only the last three user texts in order and saves the title", async () => {
    const { sdk, run } = await setup();
    await expect(run()).resolves.toEqual({
      title: "Regenerate sidebar titles",
    });
    const spawn = sdk.callsTo("threads.spawn")[0]![0] as { prompt: string };
    expect(JSON.parse(spawn.prompt.split("\n\n").at(-1)!)).toEqual([
      "Build a sidebar",
      "Add title regeneration",
      "Use three user messages",
    ]);
    expect(spawn).toMatchObject({
      projectId: "project",
      providerId: "codex",
      model: "primary",
      reasoningLevel: "low",
      visibility: "hidden",
      environment: { type: "reuse", environmentId: "workspace" },
    });
    expect(spawn).not.toHaveProperty("parentThreadId");
    expect(spawn).not.toHaveProperty("sourceThreadId");
    expect(sdk.callsTo("projects.list")).toHaveLength(0);
    expect(sdk.callsTo("providers.list")[0]![0]).toEqual({ environmentId: "workspace" });
    expect(sdk.callsTo("threads.update")[0]![0]).toEqual({
      threadId: "target",
      title: "Regenerate sidebar titles",
    });
    expect(sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(sdk.callsTo("threads.delete")[0]![0]).toEqual({
      threadId: "helper",
      childThreadsConfirmed: true,
    });
  });

  it("uses Codex when selected, even for a thread using a custom provider", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "target",
        projectId: "project",
        environmentId: "workspace",
        providerId: "acp-codex-cell",
        title: "Original title",
      }),
    );
    sdk.stub("system.aiServices", async () => ({
      selections: { "thread-title": { mode: "service", pluginId: "provider-codex", serviceId: "codex" } },
      services: [codexService],
    }));
    sdk.stub("providers.models", async () => ({
      models: [
        { id: "default", model: "default-model", isDefault: true },
        { id: "gpt-6-luna", model: "gpt-6-luna", isDefault: false },
      ],
    }));
    await expect(run()).resolves.toEqual({ title: "Regenerate sidebar titles" });
    expect(sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({
      providerId: "codex",
      model: "gpt-6-luna",
      environment: { type: "reuse", environmentId: "workspace" },
    });
    expect(sdk.callsTo("threads.defaultExecutionOptions")).toHaveLength(0);
    expect(sdk.callsTo("providers.models")[0]![0]).toEqual({
      providerId: "codex",
      environmentId: "workspace",
    });
  });

  it("honors titles being turned off", async () => {
    const { sdk, run } = await setup();
    sdk.stub("system.aiServices", async () => ({
      selections: { "thread-title": { mode: "off" } },
      services: [],
    }));
    await expect(run()).rejects.toThrow("turned off in Settings");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("explains when the thread has no workspace", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.get", async () => makeThreadResponse({ environmentId: null }));
    await expect(run()).rejects.toThrow("needs a workspace");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("pages past system, assistant, and pending rows, retaining repeated user messages", async () => {
    const { bb, sdk } = await setup();
    sdk.stub(
      "threads.timeline",
      vi
        .fn()
        .mockResolvedValueOnce(
          page(
            [
              message(8, "System", { initiator: "system" }),
              message(7, "Queued", { turnRequest: { status: "pending" } }),
              { kind: "turn", children: [message(6, "Repeat")] },
              message(5, "Assistant", { role: "assistant" }),
            ],
            true,
          ),
        )
        .mockResolvedValueOnce(page([message(2, "Opening message"), message(3, "Repeat"), message(6, "Repeat")])),
    );
    expect(await lastUserMessages(bb, "target")).toEqual(["Opening message", "Repeat", "Repeat"]);
    expect(sdk.callsTo("threads.timeline")[1]![0]).toMatchObject({
      beforeAnchorId: "older",
      beforeAnchorSeq: "4",
    });
  });

  it("uses fewer than three messages and caps each message", async () => {
    const { bb, sdk } = await setup();
    sdk.stub("threads.timeline", async () => page([message(1, "a".repeat(9_000)), message(2, "")]));
    expect((await lastUserMessages(bb, "target")).map((text) => text.length)).toEqual([8_000, 0]);
  });

  it("does not generate or rename when the selected messages have no text", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.timeline", async () => page([message(1, "")]));
    await expect(run()).rejects.toThrow("no user-message text");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("keeps the existing title and cleans up after invalid output", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.output", async () => ({
      output: "I will edit the project",
    }));
    await expect(run()).rejects.toThrow("invalid title");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
    expect(sdk.callsTo("threads.delete")).toHaveLength(1);
  });

  it("explains when Codex has no model or provider available", async () => {
    const { sdk, run } = await setup();
    sdk.stub("providers.models", async () => ({ models: [] }));
    await expect(run()).rejects.toThrow("no available model");
    sdk.stub("providers.list", async () => [{ id: "codex", available: false }]);
    await expect(run()).rejects.toThrow("codex provider to be available");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("preserves a manual rename made while generating", async () => {
    const { sdk, run } = await setup();
    sdk.stub(
      "threads.get",
      vi
        .fn()
        .mockResolvedValueOnce(
          makeThreadResponse({ providerId: "codex", environmentId: "workspace", title: "Original title" }),
        )
        .mockResolvedValueOnce(makeThreadResponse({ providerId: "codex", title: "Manual title" })),
    );
    await expect(run()).rejects.toThrow("newer title was kept");
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("deduplicates simultaneous requests for the same thread", async () => {
    const { sdk, run } = await setup();
    await Promise.all([run(), run()]);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(sdk.callsTo("threads.update")).toHaveLength(1);
  });

  it("rejects malformed or long titles", () => {
    for (const output of [null, "{}", '{"title":""}', '{"title":"one two three four five six"}', "[]"]) {
      expect(() => parseTitle(output)).toThrow();
    }
    expect(parseTitle('```json\n{"title":"  Sidebar   titles "}\n```')).toBe("Sidebar titles");
  });
});

describe("bb cloud title regeneration", () => {
  async function cloudSetup(mode: "service" | "automatic" = "service") {
    const state = await setup();
    state.sdk.stub("system.aiServices", async () => ({
      selections: {
        "thread-title":
          mode === "automatic"
            ? { mode }
            : {
                mode,
                pluginId: "bb-ai",
                serviceId: "bb",
              },
      },
      services: [codexService, cloudService],
    }));
    state.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) =>
      method === "overview"
        ? { enabled: true, status: { ready: true } }
        : { status: 200, body: { text: '{"title":"Regenerate sidebar titles"}' } },
    );
    return state;
  }

  it("sends the last three messages to the authenticated cloud gateway without an agent or workspace", async () => {
    const { sdk, run } = await cloudSetup();
    sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "target",
        environmentId: null,
        title: "Original title",
      }),
    );
    await expect(run()).resolves.toEqual({ title: "Regenerate sidebar titles" });
    const calls = sdk.callsTo("plugins.callRpc");
    expect(calls[0]![0]).toMatchObject({ pluginId: "bb-ai", method: "overview", input: null });
    const completion = calls[1]![0] as { input: { body: { prompt: string } } };
    expect(completion).toMatchObject({
      pluginId: "bb-account",
      method: "bb-account.v1.fetch",
      input: { target: "api", method: "POST", path: "/api/ai/v1/complete", timeoutMs: 5_000 },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(completion.input.body.prompt.split("\n\n").at(-1)!)).toEqual([
      "Build a sidebar",
      "Add title regeneration",
      "Use three user messages",
    ]);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("providers.list")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")[0]![0]).toEqual({ threadId: "target", title: "Regenerate sidebar titles" });
  });

  it("uses cloud first in Automatic even if the services arrive in another order", async () => {
    const { sdk, run } = await cloudSetup("automatic");
    await run();
    expect(sdk.callsTo("plugins.callRpc")).toHaveLength(2);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("falls back to Codex after a cloud failure only in Automatic", async () => {
    const { sdk, run } = await cloudSetup("automatic");
    sdk.stub("plugins.callRpc", async () => {
      throw new Error("Cloud timeout");
    });
    await run();
    expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("keeps the title and reports a gateway error when cloud is explicitly selected", async () => {
    const { sdk, run } = await cloudSetup();
    sdk.stub("plugins.callRpc", async ({ method }: { method: string }) =>
      method === "overview"
        ? { enabled: true, status: { ready: true } }
        : { status: 429, body: { error: { message: "Daily limit reached" } } },
    );
    await expect(run()).rejects.toThrow("Daily limit reached");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("sends nothing to the cloud when its current overview says it is off, despite a cached ready status", async () => {
    const { sdk, run } = await cloudSetup();
    sdk.stub("plugins.callRpc", async () => ({ enabled: false, status: { ready: false, message: "Off" } }));
    await expect(run()).rejects.toThrow("bb cloud is off");
    expect(sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("reports cloud being unavailable without contacting the account plugin", async () => {
    const { sdk, run } = await cloudSetup();
    sdk.stub("system.aiServices", async () => ({
      selections: { "thread-title": { mode: "service", pluginId: "bb-ai", serviceId: "bb" } },
      services: [{ ...cloudService, status: { ready: false, message: "Sign in to your bb account" } }],
    }));
    await expect(run()).rejects.toThrow("Sign in to your bb account");
    expect(sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });

  it("does not rename or switch providers after malformed cloud output", async () => {
    const { sdk, run } = await cloudSetup();
    sdk.stub("plugins.callRpc", async ({ method }: { method: string }) =>
      method === "overview"
        ? { enabled: true, status: { ready: true } }
        : { status: 200, body: { text: "I will edit the project" } },
    );
    await expect(run()).rejects.toThrow("invalid title");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("does not silently replace a failing explicit service with the thread's provider", async () => {
    const { sdk, run } = await setup();
    sdk.stub("system.aiServices", async () => ({
      selections: { "thread-title": { mode: "service", pluginId: "custom", serviceId: "custom" } },
      services: [{ ...codexService, pluginId: "custom", id: "custom", displayName: "Custom AI" }],
    }));
    sdk.stub("plugins.callRpc", async () => {
      throw new Error('plugin "custom" has no rpc method "ai-services.v1.complete"');
    });
    await expect(run()).rejects.toThrow("needs Custom AI to expose the ai-services.v1.complete RPC");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });
});

describe("plugin AI service title regeneration", () => {
  const exampleService = {
    id: "example-ai",
    pluginId: "example-ai",
    displayName: "Example AI",
    tasks: ["thread-title"],
    automaticRank: 2,
    status: { ready: true },
  };

  async function serviceSetup(mode: "service" | "automatic" = "service") {
    const state = await setup();
    state.sdk.stub("system.aiServices", async () => ({
      selections: {
        "thread-title": mode === "automatic" ? { mode } : { mode, pluginId: "example-ai", serviceId: "example-ai" },
      },
      services: [codexService, exampleService],
    }));
    state.sdk.stub("plugins.callRpc", async () => ({ text: '{"title":"Regenerate sidebar titles"}' }));
    return state;
  }

  it("asks the selected service's plugin through its completion RPC", async () => {
    const { sdk, run } = await serviceSetup();
    sdk.stub("threads.get", async () => makeThreadResponse({ id: "target", environmentId: null, title: "Old" }));
    await expect(run()).resolves.toEqual({ title: "Regenerate sidebar titles" });
    const [call] = sdk.callsTo("plugins.callRpc");
    const args = call![0] as { input: { prompt: string } };
    expect(args).toMatchObject({
      pluginId: "example-ai",
      method: "ai-services.v1.complete",
      input: { serviceId: "example-ai", task: "thread-title" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(args.input.prompt.split("\n\n").at(-1)!)).toEqual([
      "Build a sidebar",
      "Add title regeneration",
      "Use three user messages",
    ]);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")[0]![0]).toEqual({ threadId: "target", title: "Regenerate sidebar titles" });
  });

  it("keeps the title and reports the service error when it is explicitly selected", async () => {
    const { sdk, run } = await serviceSetup();
    sdk.stub("plugins.callRpc", async () => {
      throw new Error("AI proxy 500");
    });
    await expect(run()).rejects.toThrow("Example AI: AI proxy 500");
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("rejects malformed service output without renaming", async () => {
    const { sdk, run } = await serviceSetup();
    sdk.stub("plugins.callRpc", async () => ({ text: "Sure, here is a title" }));
    await expect(run()).rejects.toThrow("invalid title");
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
  });

  it("follows automaticRank and falls back to the next service in Automatic", async () => {
    const { sdk, run } = await serviceSetup("automatic");
    sdk.stub("system.aiServices", async () => ({
      selections: { "thread-title": { mode: "automatic" } },
      services: [codexService, { ...exampleService, automaticRank: 0 }],
    }));
    sdk.stub("plugins.callRpc", async () => {
      throw new Error("AI proxy 503");
    });
    await expect(run()).resolves.toEqual({ title: "Regenerate sidebar titles" });
    expect(sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("skips a service that is not ready without calling it", async () => {
    const { sdk, run } = await serviceSetup();
    sdk.stub("system.aiServices", async () => ({
      selections: { "thread-title": { mode: "service", pluginId: "example-ai", serviceId: "example-ai" } },
      services: [{ ...exampleService, status: { ready: false, message: "No proxy token" } }],
    }));
    await expect(run()).rejects.toThrow("No proxy token");
    expect(sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });
});
