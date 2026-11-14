import { expect } from "@playwright/test";
import { test, fixture, rpc, shelf, link, menu, reset, open } from "./helpers.mjs";

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

test("shelf rows changed while the connection is down refresh after it reconnects", async ({ page, request }) => {
  test.setTimeout(60_000);
  const thread = fixture.threads[0];
  const realtime = await controlRealtime(page);
  await open(page);
  await expect(link(page, thread.title)).toBeVisible();
  await realtime.drop();
  await rpc(request, "settle", { threadId: thread.id });
  // The page cannot have heard about the settle: the row is still in Active.
  await page.waitForTimeout(1_500);
  await expect(link(page, thread.title)).toBeVisible();
  realtime.restore();
  await expect(link(page, thread.title)).toHaveCount(0, { timeout: 30_000 });
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

const activeTitles = (page) =>
  shelf(page, "Active")
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")));

test("an inbox order saved elsewhere shows without a reload", async ({ page, request }) => {
  await open(page);
  await expect.poll(() => activeTitles(page)).toEqual(fixture.threads.map(({ title }) => title));
  const reversed = [...fixture.threads].reverse();
  await rpc(request, "reorderInbox", { inboxThreadIds: reversed.map(({ id }) => id) });
  await expect.poll(() => activeTitles(page)).toEqual(reversed.map(({ title }) => title));
});

test("a reorder right after the sidebar loads shows at once and survives the reread", async ({ page }) => {
  const [first, second, ...rest] = fixture.threads;
  const expected = [second, first, ...rest].map(({ title }) => title);
  await open(page);
  // Inside the cache's two-second freshness window of the first read.
  await shelf(page, "Active").getByRole("link", { name: second.title, exact: true }).press("Alt+ArrowUp");
  await expect.poll(() => activeTitles(page), { timeout: 1_000 }).toEqual(expected);
  await page.waitForTimeout(2_500);
  expect(await activeTitles(page)).toEqual(expected);
});

test("a thread settled in one window leaves Active in another open window", async ({ page }) => {
  const thread = fixture.threads[0];
  const other = await page.context().newPage();
  await open(page);
  await open(other);
  await expect(link(other, thread.title)).toBeVisible();
  await (await menu(page, thread.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
  await expect(link(page, thread.title)).toHaveCount(0);
  await expect(link(other, thread.title)).toHaveCount(0);
  await expect(shelf(other, "Settled")).toBeVisible();
  await other.close();
});

test("a settle right after the sidebar loads shows at once and survives the reread", async ({ page }) => {
  const thread = fixture.threads[1];
  await open(page);
  // Inside the cache's two-second freshness window of the first read.
  await (await menu(page, thread.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
  await expect(link(page, thread.title)).toHaveCount(0, { timeout: 1_000 });
  await page.waitForTimeout(2_500);
  await expect(link(page, thread.title)).toHaveCount(0);
  await expect(shelf(page, "Settled")).toBeVisible();
});
