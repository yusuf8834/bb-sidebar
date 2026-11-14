import { expect } from "@playwright/test";
import { test, fixture, cli, rpc, shelf, link, menu, expand, reset, open } from "./helpers.mjs";

const [atlas, birch, cedar, delta] = fixture.threads;

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await open(page);
});

test("selected sidebar renders all seeded threads in Active", async ({ page }) => {
  const settings = await cli(["settings", "ui", "get", "sidebar.threadListProvider"]);
  expect(settings.value).toBe("bb-sidebar/inbox");
  for (const thread of fixture.threads) {
    await expect(link(page, thread.title)).toBeVisible();
    const state = await cli(["thread", "get", thread.id]);
    expect(state.thread.status).toBe("idle");
    expect(state.thread.environmentId).toBeTruthy();
  }
});

test("pin and pinned keyboard order persist after reload", async ({ page }) => {
  await (await menu(page, atlas.title)).getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(link(page, atlas.title, "Pinned")).toBeVisible();
  await expect(link(page, atlas.title)).toHaveCount(0);
  await expect.poll(async () => (await cli(["thread", "get", atlas.id])).thread.pinnedAt).not.toBeNull();
  await page.reload();
  await expect(link(page, atlas.title, "Pinned")).toBeVisible();

  // The app saves pinned order through bb's own threads.reorderPinned.
  await cli(["thread", "pin", birch.id]);
  const pinned = shelf(page, "Pinned");
  const order = () => pinned.getByRole("link").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  await expect.poll(async () => (await order()).toSorted()).toEqual([atlas.title, birch.title]);
  const [first, second] = await order();
  await link(page, second, "Pinned").focus();
  await link(page, second, "Pinned").press("Alt+ArrowUp");
  await expect.poll(order).toEqual([second, first]);
  await page.reload();
  await expect.poll(order).toEqual([second, first]);
});

// Rows link to the thread and bb routes the click in place. navigate.toThread
// would also clear the thread's saved Full Screen, which bb keeps in this key.
test("a row click opens the thread in place and keeps its Full Screen", async ({ page }) => {
  const fullScreenKey = `bb.thread.conversation.collapsed-${encodeURIComponent(atlas.id)}`;
  const row = link(page, atlas.title);
  await expect(row).toHaveAttribute("href", new RegExp(`/threads/${atlas.id}$`));
  await page.evaluate((key) => {
    window.localStorage.setItem(key, "true");
    window.__bbSidebarSamePage = true;
  }, fullScreenKey);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/threads/${atlas.id}$`));
  await expect(row).toHaveAttribute("aria-current", "page");
  // A full page load would mean the click escaped bb's routing.
  expect(await page.evaluate(() => window.__bbSidebarSamePage)).toBe(true);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), fullScreenKey)).toBe("true");
});

// bb owns the hold delay, numbering, and pill; the sidebar draws what it assigns.
test("holding the shortcut modifier shows bb's jump keys on sidebar rows", async ({ page }) => {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const sidebar = page.locator("[data-bb-sidebar-root]");
  await expect(link(page, atlas.title)).toBeVisible();
  await page.mouse.move(1000, 750);
  await page.keyboard.down(modifier);
  try {
    const hints = sidebar.locator("kbd");
    await expect(hints).toHaveCount(fixture.threads.length);
    await expect(hints.first()).toContainText("1");
    await expect(link(page, atlas.title)).toHaveAttribute("aria-keyshortcuts", /1/);
  } finally {
    await page.keyboard.up(modifier);
  }
  await expect(sidebar.locator("kbd")).toHaveCount(0);
});

test("manual keyboard reorder persists after reload", async ({ page, request }) => {
  const active = shelf(page, "Active");
  await expect(active.getByRole("link").first()).toHaveAttribute("aria-keyshortcuts", /Alt\+ArrowUp/);
  await link(page, birch.title).focus();
  await link(page, birch.title).press("Alt+ArrowUp");
  const expected = [birch, atlas, cedar, delta];
  await expect
    .poll(async () => active.getByRole("link").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))))
    .toEqual(expected.map(({ title }) => title));
  await expect
    .poll(async () => (await rpc(request, "listInboxOrder")).inboxThreadIds)
    .toEqual(expected.map(({ id }) => id));
  await page.reload();
  await expect
    .poll(async () => active.getByRole("link").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))))
    .toEqual(expected.map(({ title }) => title));
});

test("snooze moves to Snoozed and wake returns to Active", async ({ page, request }) => {
  const row = shelf(page, "Active")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: birch.title, exact: true }) });
  await link(page, birch.title).hover();
  await row.getByRole("combobox", { name: "Snooze thread" }).click();
  await page.getByRole("option", { name: "1 hour", exact: true }).click();
  await expect(shelf(page, "Snoozed")).toBeVisible();
  await expand(page, "Snoozed");
  await expect(link(page, birch.title, "Snoozed")).toBeVisible();
  await expect(link(page, birch.title)).toHaveCount(0);
  const rows = (await rpc(request, "listLifecycle")).rows;
  expect(rows.find((row) => row.threadId === birch.id).snoozedUntil).toBeGreaterThan(Date.now());
  await (await menu(page, birch.title, "Snoozed")).getByRole("menuitem", { name: "Wake now", exact: true }).click();
  await expect(link(page, birch.title)).toBeVisible();
  expect(
    (await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === birch.id)?.snoozedUntil ?? null,
  ).toBeNull();
});

test("settle moves to Settled and Undo restores Active", async ({ page, request }) => {
  await (await menu(page, cedar.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
  await expect(shelf(page, "Settled")).toBeVisible();
  await expand(page, "Settled");
  await expect(link(page, cedar.title, "Settled")).toBeVisible();
  await expect(link(page, cedar.title)).toHaveCount(0);
  expect((await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === cedar.id).settledAt).not.toBeNull();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(link(page, cedar.title)).toBeVisible();
  expect((await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === cedar.id).settledAt).toBeNull();
});

test("right-click menu matches the sidebar action list", async ({ page, context }) => {
  await cli(["thread", "unread", delta.id]);
  await page.reload();
  const actions = await menu(page, delta.title);
  await expect(actions.getByRole("menuitem")).toHaveText([
    "Open in split",
    "Parent",
    "Project",
    "Pin",
    "Snooze",
    "Park thread",
    "Settle",
    "Rename",
    "Regenerate title",
    "Mark read",
    "Copy",
    "Archive",
    "Delete",
  ]);
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);

  // Copy thread link runs bb's own Copy link action.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.url });
  await (await menu(page, delta.title)).getByRole("menuitem", { name: "Copy", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy thread link", exact: true }).click();
  await expect(page.getByText("Thread link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    new URL(`/projects/${fixture.projectId}/threads/${delta.id}`, fixture.url).href,
  );
});
