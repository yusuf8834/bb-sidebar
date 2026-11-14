import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createTitleRegenerator, PermanentTitleError } from "./regenerate-title";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

function stubThread(sdk: ReturnType<typeof createFakePluginHost>["harness"]["inspection"]["sdk"], changes = {}) {
  sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "target", title: "Original title", visibility: "visible", ...changes }),
  );
}

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
  const sdk = harness.inspection.sdk;
  stubThread(sdk);
  sdk.stub("threads.experimental_regenerateTitle", async () => makeThreadResponse({ title: "Sidebar title service" }));
  await plugin(bb);
  disposers.push(() => harness.lifecycle.dispose());
  return { sdk, run: () => harness.behavior.callRpc("regenerateTitle", { threadId: "target" }) };
}

describe("title regeneration", () => {
  it("asks bb to generate and save the title with the selected service", async () => {
    const { sdk, run } = await setup();
    await expect(run()).resolves.toEqual({ title: "Sidebar title service", changed: true });
    expect(sdk.callsTo("threads.experimental_regenerateTitle")[0]![0]).toMatchObject({ threadId: "target" });
    expect(sdk.callsTo("threads.update")).toHaveLength(0);
    expect(sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("reports when bb keeps the current title", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.experimental_regenerateTitle", async () => makeThreadResponse({ title: "Original title" }));
    await expect(run()).resolves.toEqual({ title: "Original title", changed: false });
  });

  it("passes bb's failure through", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.experimental_regenerateTitle", async () => {
      throw new Error("Thread titles are turned off");
    });
    await expect(run()).rejects.toThrow("Thread titles are turned off");
  });

  it("fails when bb leaves the thread without a title", async () => {
    const { sdk, run } = await setup();
    sdk.stub("threads.get", async () => makeThreadResponse({ id: "target", title: null }));
    sdk.stub("threads.experimental_regenerateTitle", async () => makeThreadResponse({ title: null }));
    await expect(run()).rejects.toThrow("bb did not generate a title");
  });

  it("deduplicates simultaneous requests for the same thread", async () => {
    const { sdk, run } = await setup();
    await Promise.all([run(), run()]);
    expect(sdk.callsTo("threads.experimental_regenerateTitle")).toHaveLength(1);
  });
});

describe("title regeneration for untitled threads only", () => {
  function setupDirect(changes = {}) {
    const { bb, harness } = createFakePluginHost({ pluginId: "bb-sidebar" });
    const sdk = harness.inspection.sdk;
    stubThread(sdk, { title: null, ...changes });
    sdk.stub("threads.experimental_regenerateTitle", async () => makeThreadResponse({ title: "Recovered title" }));
    disposers.push(() => harness.lifecycle.dispose());
    return { sdk, regenerate: createTitleRegenerator(bb) };
  }

  it("names an untitled thread", async () => {
    const { regenerate } = setupDirect();
    await expect(regenerate("target", { onlyIfUntitled: true })).resolves.toEqual({
      title: "Recovered title",
      changed: true,
    });
  });

  it.each([{ title: "Manual title" }, { visibility: "hidden" as const }, { archivedAt: 1 }, { deletedAt: 1 }])(
    "does not call bb for a thread that gained a title or became unavailable: %j",
    async (changes) => {
      const { sdk, regenerate } = setupDirect(changes);
      await expect(regenerate("target", { onlyIfUntitled: true })).rejects.toBeInstanceOf(PermanentTitleError);
      expect(sdk.callsTo("threads.experimental_regenerateTitle")).toHaveLength(0);
    },
  );
});
