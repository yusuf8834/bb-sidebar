import { expect } from "@playwright/test";
import { test, fixture, rpc, shelf, reset, open } from "./helpers.mjs";

/**
 * Put bb's realtime sockets under the test's control. `drop()` closes every
 * open socket and refuses new ones, so the page misses whatever the server
 * signals meanwhile; `restore()` lets bb's own reconnect through.
 */
async function controlRealtime(page) {
  const sockets = new Set();
  let down = false;
  await page.routeWebSocket(/.*/, (ws) => {
    if (down) {
      void ws.close({ code: 4000, reason: "e2e: connection down" });
      return;
    }
    const server = ws.connectToServer();
    sockets.add(ws);
    ws.onClose(() => {
      sockets.delete(ws);
      void server.close();
    });
  });
  return {
    async drop() {
      down = true;
      await Promise.all([...sockets].map((ws) => ws.close({ code: 4000, reason: "e2e: connection down" })));
      sockets.clear();
    },
    restore() {
      down = false;
    },
  };
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("project colors changed while the connection is down refresh after it reconnects", async ({ page, request }) => {
  test.setTimeout(60_000);
  const realtime = await controlRealtime(page);
  try {
    await rpc(request, "updateSidebarSettings", {
      ...fixture.defaultSettings,
      projectColorsEnabled: true,
      projectColorDisplay: "full",
    });
    await open(page);
    const row = shelf(page, "Active")
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: fixture.threads[0].title, exact: true }) });
    await expect(row.locator("[data-project-stripe]")).toBeVisible();
    await realtime.drop();
    await rpc(request, "setProjectColor", { projectId: fixture.projectId, color: "#1f4e79" });
    await page.waitForTimeout(1_500);
    await expect(row.locator("[data-project-stripe]")).not.toHaveCSS("background-color", "rgb(31, 78, 121)");
    realtime.restore();
    await expect(row.locator("[data-project-stripe]")).toHaveCSS("background-color", "rgb(31, 78, 121)", {
      timeout: 30_000,
    });
  } finally {
    await rpc(request, "setProjectColor", { projectId: fixture.projectId, color: null });
    await rpc(request, "updateSidebarSettings", fixture.defaultSettings);
  }
});

test("a project color saved elsewhere shows without a reload", async ({ page, request }) => {
  try {
    await rpc(request, "updateSidebarSettings", {
      ...fixture.defaultSettings,
      projectColorsEnabled: true,
      projectColorDisplay: "full",
    });
    await open(page);
    const row = shelf(page, "Active")
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: fixture.threads[0].title, exact: true }) });
    await expect(row.locator("[data-project-stripe]")).toBeVisible();
    await rpc(request, "setProjectColor", { projectId: fixture.projectId, color: "#1f4e79" });
    await expect(row.locator("[data-project-stripe]")).toHaveCSS("background-color", "rgb(31, 78, 121)");
  } finally {
    await rpc(request, "setProjectColor", { projectId: fixture.projectId, color: null });
    await rpc(request, "updateSidebarSettings", fixture.defaultSettings);
  }
});
