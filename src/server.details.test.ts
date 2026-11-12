import { describe, expect, it, onTestFinished, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPlugin } from "./test-server";

describe("lifecycle RPC", () => {
  it("rejects the empty input an older app bundle sends, and returns no ports for a workspace that is not ready", async () => {
    const harness = await loadPlugin();
    await expect(harness.behavior.callRpc("getOpenPorts", {})).rejects.toThrow();
    await expect(harness.behavior.callRpc("getOpenPorts", { environmentIds: [] })).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("getOpenPorts", { environmentIds: Array.from({ length: 501 }, (_, i) => `env_${i}`) }),
    ).rejects.toThrow();
    harness.inspection.sdk.stub("environments.list", async () => []);
    await expect(harness.behavior.callRpc("getOpenPorts", { environmentIds: ["env_gone"] })).resolves.toEqual({
      groups: [],
    });
  });

  it("returns only model and reasoning details, including unset options", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "default",
      source: "client/turn/start",
    }));
    await expect(
      harness.behavior.callRpc("getThreadExecutionDetails", {
        threadId: "thr_1",
      }),
    ).resolves.toEqual({ model: "gpt-6", reasoningLevel: "high" });
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => null);
    await expect(
      harness.behavior.callRpc("getThreadExecutionDetails", {
        threadId: "thr_1",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["models", "catalog-id", "gpt-6.1-sol", "gpt-6.1-sol", "GPT 6.1 Sol"],
    ["models", "custom-choice", "wire-model", "custom-choice", "My Custom Model"],
    ["selectedOnlyModels", "retired-model", "retired-model", "retired-model", "Retired Model"],
  ])(
    "resolves display names from %s in the thread's provider and environment",
    async (list, id, model, selected, name) => {
      const harness = await loadPlugin();
      harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
        model: selected,
        reasoningLevel: "medium",
      }));
      harness.inspection.sdk.stub("threads.get", async () =>
        makeThreadResponse({ id: "thr_1", environmentId: "env_remote", providerId: "custom-provider" }),
      );
      harness.inspection.sdk.stub("providers.models", async (args) => {
        expect(args).toEqual({ environmentId: "env_remote", providerId: "custom-provider" });
        return {
          models: [],
          selectedOnlyModels: [],
          [list]: [{ id, model, displayName: name }],
        };
      });
      await expect(harness.behavior.callRpc("getThreadExecutionDetails", { threadId: "thr_1" })).resolves.toEqual({
        model: selected,
        modelDisplayName: name,
        reasoningLevel: "medium",
      });
    },
  );

  it.each(["missing", "blank", "offline"])("keeps raw execution details when the model name is %s", async (mode) => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "unknown-model",
      reasoningLevel: "high",
    }));
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ environmentId: "env_1" }));
    harness.inspection.sdk.stub("providers.models", async () => {
      if (mode === "offline") throw new Error("Host offline");
      return {
        models: [{ id: "unknown-model", model: "unknown-model", displayName: mode === "blank" ? "  " : "" }].filter(
          () => mode === "blank",
        ),
        selectedOnlyModels: [],
      };
    });
    await expect(harness.behavior.callRpc("getThreadExecutionDetails", { threadId: "thr_1" })).resolves.toEqual({
      model: "unknown-model",
      reasoningLevel: "high",
    });
  });

  it("labels the effort from the model catalog", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6.1-sol",
      reasoningLevel: "xhigh",
    }));
    harness.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ environmentId: "env_1" }));
    harness.inspection.sdk.stub("providers.models", async () => ({
      models: [
        {
          id: "gpt-6.1-sol",
          model: "gpt-6.1-sol",
          displayName: "GPT 6.1 Sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "", label: "Medium" },
            { reasoningEffort: "xhigh", description: "", label: "Extra High" },
          ],
        },
      ],
      selectedOnlyModels: [],
    }));
    await expect(harness.behavior.callRpc("getThreadExecutionDetails", { threadId: "thr_1" })).resolves.toEqual({
      model: "gpt-6.1-sol",
      modelDisplayName: "GPT 6.1 Sol",
      reasoningLabel: "Extra High",
      reasoningLevel: "xhigh",
    });
  });

  it("shares one catalog request per environment and provider, retrying failures", async () => {
    const harness = await loadPlugin();
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({
      model: "gpt-6",
      reasoningLevel: "high",
    }));
    harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) =>
      makeThreadResponse({ id: args.threadId, environmentId: args.threadId === "thr_3" ? "env_2" : "env_1" }),
    );
    let calls = 0;
    let fail = true;
    harness.inspection.sdk.stub("providers.models", async () => {
      calls += 1;
      if (fail) throw new Error("Host offline");
      return { models: [{ id: "gpt-6", model: "gpt-6", displayName: "GPT 6" }], selectedOnlyModels: [] };
    });
    const details = (threadId: string) => harness.behavior.callRpc("getThreadExecutionDetails", { threadId });
    await expect(details("thr_1")).resolves.toEqual({ model: "gpt-6", reasoningLevel: "high" });
    fail = false;
    const named = { model: "gpt-6", modelDisplayName: "GPT 6", reasoningLevel: "high" };
    await expect(Promise.all([details("thr_1"), details("thr_2")])).resolves.toEqual([named, named]);
    await expect(details("thr_1")).resolves.toEqual(named);
    expect(calls).toBe(2);
    await expect(details("thr_3")).resolves.toEqual(named);
    expect(calls).toBe(3);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
    onTestFinished(() => clock.mockRestore());
    await expect(details("thr_1")).resolves.toEqual(named);
    expect(calls).toBe(4);
  });
});
