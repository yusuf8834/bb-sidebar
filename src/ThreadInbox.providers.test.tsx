// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, defaultSidebarSettings, thread, listProps, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("ThreadInbox", () => {
  it.each(["full", "compact-working", "compact-all", "working-shelf"])(
    "renders provider names, and logos and theme tints through bb's provider icon (%s)",
    async (display) => {
      const view = renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ providerId: "pi", title: "Pi thread", indicator: "runtime", indicatorLabel: "Working" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
        },
        providers: {
          status: "ready",
          providers: [
            {
              id: "pi",
              pluginId: "provider-pi",
              displayName: "Pi",
              available: true,
              completedTurnDisplay: "collapse",
              maintenance: {
                health: true,
                usage: false,
                installation: true,
              },
              logoUrl: "/api/v1/system/providers/pi/logo",
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
              strings: {
                signInHint: "Run pi to sign in.",
                expiredHint: "Run pi to sign in again.",
                installUrl: "https://pi.dev",
                iconTint: { light: "#6D5DFB", dark: "#A99EFF" },
              },
            },
          ],
        },
        rpc: {
          listLifecycle: () => ({ rows: [] }),
          getSidebarSettings: () => ({
            ...defaultSidebarSettings,
            inactiveThreadsEnabled: false,
            threadDisplay: display === "working-shelf" ? "full" : display,
            workingShelf: display === "working-shelf",
          }),
        },
      });

      await waitFor(() => {
        const row = screen.getByRole("link", { name: "Pi thread" }).closest("[data-parent-card]")!;
        expect(row.classList.contains("h-8")).toBe(display !== "full");
      });
      const region = screen.getByRole("region", { name: display === "working-shelf" ? "Working" : "Active" });
      const glyph = within(region).getByRole("img", { name: "Pi" });
      const row = glyph.closest("[data-parent-card]")! as HTMLElement;
      expect(within(row).getByText("Working")).toBeDefined();
      // bb's ProviderIcon draws the logo and picks the tint for the theme;
      // the sidebar hands it the directory record unchanged.
      const mark = glyph.querySelector<HTMLElement>("[data-provider-id]")!;
      expect(mark.dataset.providerKind).toBe("agent");
      expect(mark.dataset.providerId).toBe("pi");
      expect(mark.dataset.providerLogo).toBe("/api/v1/system/providers/pi/logo");
      expect(JSON.parse(mark.dataset.providerTint!)).toEqual({ light: "#6D5DFB", dark: "#A99EFF" });
      expect(view.container.querySelector('[aria-label="pi"]')).toBeNull();
    },
  );

  it("labels each provider glyph once and hides bb's provider icon inside it", () => {
    render([thread({ providerId: "codex" })]);

    const glyph = screen.getByRole("img", { name: "Codex" });
    const mark = glyph.querySelector<HTMLElement>("[data-provider-id]")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.hasAttribute("aria-label")).toBe(false);
    // Untinted logos keep the sidebar's muted ink; bb paints its mask in currentColor.
    expect(mark.classList.contains("text-muted-foreground/70")).toBe(true);
    expect(screen.getAllByRole("img", { name: "Codex" })).toHaveLength(1);
  });

  it("falls back to the provider id when the directory has no match", () => {
    render([thread({ providerId: "custom-agent" })]);

    const glyph = screen.getByRole("img", { name: "custom-agent" });
    expect(glyph.querySelector(".rounded-full")).not.toBeNull();
  });

  it("loads a project favicon beside the project name", async () => {
    const view = render([
      thread({
        id: "icon-thread",
        environment: {
          id: "env_1",
          name: "main",
          branchName: "main",
          workspaceDisplayKind: "other",
          path: null,
          isWorktree: null,
          providerId: null,
        },
      }),
    ]);

    const preload = await waitFor(() => {
      const image = view.container.querySelector<HTMLImageElement>('img[src*="project-icon"]');
      expect(image).not.toBeNull();
      return image!;
    });
    expect(preload.src).toContain("projectId=proj_1");
    expect(preload.src).not.toContain("environmentId");
    fireEvent.load(preload);
    expect(view.container.querySelector('img.object-contain[src*="project-icon"]')).not.toBeNull();
  });
});
