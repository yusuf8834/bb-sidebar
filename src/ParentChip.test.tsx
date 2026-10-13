// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./test-slot";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { idleSidebarThreadFields } from "./test-fixtures";
import type { SidebarProvider } from "./ProviderGlyph";
import { cacheSidebarSettings, DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { SIDEBAR_SETTINGS_CHANNEL } from "./realtime-channels";

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime.
const app = await loadPluginApp(() => import("../app"));
const parentChip = app.threadHeaderActions.find((slot) => slot.id === "parent")!;

const codex: SidebarProvider = {
  id: "codex",
  pluginId: "provider-codex",
  displayName: "Codex",
  available: true,
  completedTurnDisplay: "collapse",
  maintenance: { health: true, usage: false, installation: true },
  logoUrl: "/api/v1/system/providers/codex/logo",
  capabilities: {
    modelCatalogScope: "workspace",
    permissionModes: ["full"],
    supportsFork: true,
    supportsNativeUserQuestion: false,
    supportsServiceTier: false,
    supportsSessionRewind: true,
    supportsThreadArchive: false,
    supportsThreadRename: false,
  },
  composerActions: [],
};

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

function render(
  threads: PluginSidebarThread[],
  threadId: string,
  isCompactViewport = false,
  options: RenderSlotOptions = {},
) {
  return renderSlot(
    parentChip,
    { threadId, projectId: "proj_1", isCompactViewport },
    {
      ...options,
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
    },
  );
}

afterEach(cleanup);

describe("ParentChip", () => {
  it.each([false, true])("keeps the parent disc in disc mode, compact=%s", async (compact) => {
    const rendered = render(
      [thread({ id: "parent", title: "Parent" }), thread({ id: "child", parentThreadId: "parent" })],
      "child",
      compact,
      {
        providers: { status: "ready", providers: [codex] },
        rpc: { getSidebarSettings: () => DEFAULT_SIDEBAR_SETTINGS },
      },
    );
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "getSidebarSettings", input: {} }));
    const button = screen.getByRole("button", { name: "Back to parent: Parent" });
    expect(within(button).queryByRole("img")).toBeNull();
    const disc = button.querySelector<HTMLElement>("span.rounded-full");
    expect(disc?.className).toBe("inline-block size-3.5 shrink-0 rounded-full border border-background");
    expect(disc?.style.backgroundColor).toBe("oklch(0.72 0.13 290)");
  });

  it.each([false, true])("shows the parent's provider rather than the child's, compact=%s", async (compact) => {
    render(
      [
        thread({ id: "parent", title: "Parent", providerId: "codex" }),
        thread({ id: "child", parentThreadId: "parent", providerId: "claude-code" }),
      ],
      "child",
      compact,
      {
        providers: { status: "ready", providers: [codex] },
        rpc: { getSidebarSettings: () => ({ ...DEFAULT_SIDEBAR_SETTINGS, childIconStyle: "provider" }) },
      },
    );
    const glyph = await screen.findByRole("img", { name: "Codex" });
    expect(glyph.querySelector<HTMLElement>("span")?.style.maskImage).toBe(`url("${codex.logoUrl}")`);
    expect(screen.getByRole("button").querySelector("span.rounded-full")).toBeNull();
    expect(screen.getByRole("button").textContent).toBe(compact ? "" : "Parent");
  });

  it("falls back to the parent's disc for an unknown provider", async () => {
    const rendered = render(
      [thread({ id: "parent", providerId: "unknown" }), thread({ id: "child", parentThreadId: "parent" })],
      "child",
      false,
      {
        providers: { status: "ready", providers: [codex] },
        rpc: { getSidebarSettings: () => ({ ...DEFAULT_SIDEBAR_SETTINGS, childIconStyle: "provider" }) },
      },
    );
    await rendered.emitRealtime(SIDEBAR_SETTINGS_CHANNEL, {});
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button").querySelector<HTMLElement>("span.rounded-full")?.style.backgroundColor).toBe(
      "oklch(0.72 0.13 290)",
    );
  });

  it("uses cached provider mode before settings can load", () => {
    cacheSidebarSettings({}, { ...DEFAULT_SIDEBAR_SETTINGS, childIconStyle: "provider" });
    render([thread({ id: "parent" }), thread({ id: "child", parentThreadId: "parent" })], "child", false, {
      providers: { status: "ready", providers: [codex] },
    });
    expect(screen.getByRole("img", { name: "Codex" })).toBeDefined();
  });

  it("updates the icon when settings change while mounted", async () => {
    let settings = DEFAULT_SIDEBAR_SETTINGS;
    const rendered = render(
      [thread({ id: "parent", title: "Parent" }), thread({ id: "child", parentThreadId: "parent" })],
      "child",
      false,
      {
        providers: { status: "ready", providers: [codex] },
        rpc: { getSidebarSettings: () => settings },
      },
    );
    const button = screen.getByRole("button", { name: "Back to parent: Parent" });
    expect(button.querySelector("span.rounded-full")).not.toBeNull();
    settings = { ...settings, childIconStyle: "provider" };
    await rendered.emitRealtime(SIDEBAR_SETTINGS_CHANNEL, {});
    expect(await within(button).findByRole("img", { name: "Codex" })).toBeDefined();
    expect(screen.getByRole("button")).toBe(button);
    settings = { ...settings, childIconStyle: "disc" };
    await rendered.emitRealtime(SIDEBAR_SETTINGS_CHANNEL, {});
    await waitFor(() => expect(within(button).queryByRole("img")).toBeNull());
    expect(button.querySelector("span.rounded-full")).not.toBeNull();
  });

  // The whole reason the chip exists: the list hides the child, so this is its
  // only route back.
  it("opens the parent on click", () => {
    const rendered = render(
      [thread({ id: "parent", title: "Parent thread" }), thread({ id: "child", parentThreadId: "parent" })],
      "child",
    );
    fireEvent.click(screen.getByRole("button"));
    expect(rendered.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "parent",
      options: undefined,
    });
  });

  it("renders nothing on a root thread", () => {
    render([thread({ id: "root" })], "root");
    expect(screen.queryByRole("button")).toBeNull();
  });

  // An archived parent is out of the list but still the way back.
  it("names an archived parent", () => {
    render(
      [
        thread({ id: "parent", title: "Archived parent", isArchived: true }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Back to parent: Archived parent");
  });

  // The header row is short: a phone shows the chevron and the disc only, but
  // the control keeps its name.
  it("drops the title on a compact viewport", () => {
    render(
      [thread({ id: "parent", title: "Parent thread" }), thread({ id: "child", parentThreadId: "parent" })],
      "child",
      true,
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toBe("Back to parent: Parent thread");
  });
});
