import { expect } from "@playwright/test";
import { test, fixture, cli, rpc, shelf, link, menu, expand, reset, open } from "./helpers.mjs";

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await open(page);
});

test("park and resume persist across reload", async ({ page, request }) => {
  const thread = fixture.threads[0];
  await (await menu(page, thread.title)).getByRole("menuitem", { name: "Park thread", exact: true }).click();
  await expect(shelf(page, "Parked")).toBeVisible();
  await expand(page, "Parked");
  await expect(link(page, thread.title, "Parked")).toBeVisible();
  await expect(link(page, thread.title)).toHaveCount(0);
  await expect
    .poll(async () => (await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === thread.id)?.parkedAt)
    .toBeGreaterThan(0);
  await page.reload();
  await expand(page, "Parked");
  await expect(link(page, thread.title, "Parked")).toBeVisible();
  await expect(link(page, thread.title)).toHaveCount(0);
  await (await menu(page, thread.title, "Parked")).getByRole("menuitem", { name: "Resume", exact: true }).click();
  await expect(link(page, thread.title)).toBeVisible();
  await expect(link(page, thread.title, "Parked")).toHaveCount(0);
  expect(
    (await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === thread.id)?.parkedAt ?? null,
  ).toBeNull();
  await page.reload();
  await expect(link(page, thread.title)).toBeVisible();
  await expect(link(page, thread.title, "Parked")).toHaveCount(0);
});

test("Clean preview shows zero resources and empty cleanup changes nothing", async ({ page, request }) => {
  const thread = fixture.threads[0];
  await (await menu(page, thread.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
  await expect(link(page, thread.title)).toHaveCount(0);
  // All seeds share a checkout. Settle the rest so workspace protection does
  // not hide resources merely because another fixture is still in Active.
  for (const { id } of fixture.threads.slice(1)) await rpc(request, "settle", { threadId: id });
  await expand(page, "Settled");
  await expect(shelf(page, "Settled").getByRole("link")).toHaveCount(fixture.threads.length);
  const lifecycle = await rpc(request, "listLifecycle");
  const states = [];
  for (const { id } of fixture.threads) {
    states.push((await cli(["thread", "get", id])).thread);
    expect((await cli(["terminal", "list", "--thread", id])).sessions).toEqual([]);
  }
  const [previewResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/rpc/previewSettledCleanup")),
    shelf(page, "Settled")
      .getByRole("button", { name: "Close terminals and ports of settled threads", exact: true })
      .click(),
  ]);
  const dialog = page.getByRole("dialog", { name: "Clean settled resources?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Review the live resources found on settled threads before closing them.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("No live terminals or thread-owned listening ports found.", { exact: true }),
  ).toBeVisible();
  const { result: preview } = await previewResponse.json();
  expect(preview.threads).toEqual([]);
  expect(preview.skipped).toEqual([]);
  await expect(dialog.getByRole("button", { name: "Clean resources", exact: true })).toHaveCount(0);
  // Empty previews offer Cancel only. Verify the same empty plan via the real
  // cleanup RPC rather than inventing a UI confirmation for zero resources.
  expect(await rpc(request, "cleanSettled", { token: preview.token })).toEqual({
    closedTerminals: 0,
    signalledPorts: [],
    remainingPorts: [],
    skipped: [],
    failed: [],
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await rpc(request, "listLifecycle")).toEqual(lifecycle);
  for (const [index, { id, title }] of fixture.threads.entries()) {
    await expect(link(page, title, "Settled")).toBeVisible();
    expect((await cli(["thread", "get", id])).thread).toEqual(states[index]);
    expect((await cli(["terminal", "list", "--thread", id])).sessions).toEqual([]);
  }
});

test("palette commands snooze and unsnooze the thread in view", async ({ page, request }) => {
  const thread = fixture.threads[0];
  const snoozedUntil = async () =>
    (await rpc(request, "listLifecycle")).rows.find((row) => row.threadId === thread.id)?.snoozedUntil ?? null;
  const runCommand = async (title) => {
    // bb hands commands the thread in view as the palette opens, and only once
    // the thread's page has rendered; a palette opened right after a click on
    // a row lists no thread commands.
    await expect(page.getByRole("textbox", { name: /^Ask for a follow-up/ })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    // The palette can open on thread search, where Escape returns to its
    // commands; on the commands themselves Escape would close it.
    const search = palette.getByRole("combobox", { name: "Search commands" });
    if (!(await search.isVisible())) await page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    await search.fill(title);
    await palette.getByRole("option", { name: title }).click();
  };

  test.setTimeout(120_000);
  await link(page, thread.title).click();
  await expect(page).toHaveURL(new RegExp(thread.id));
  // Opening a seeded thread may start its runtime, and a working thread cannot be snoozed.
  const working = shelf(page, "Active")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: new RegExp(`${thread.title}$`) }) })
    .getByLabel("Thread working");
  await expect(async () => {
    if (await working.count()) await cli(["thread", "stop", thread.id]);
    await expect(working).toHaveCount(0);
    await runCommand("BB Sidebar: Snooze this thread for 1 hour");
    await expect.poll(snoozedUntil, { timeout: 3_000 }).not.toBeNull();
  }).toPass({ timeout: 60_000 });
  await expand(page, "Snoozed");
  await expect(link(page, thread.title, "Snoozed")).toBeVisible();
  await expect(link(page, thread.title)).toHaveCount(0);
  await expect.poll(snoozedUntil).toBeGreaterThan(Date.now() + 59 * 60_000);

  await link(page, thread.title, "Snoozed").click();
  await expect(page).toHaveURL(new RegExp(thread.id));
  await runCommand("BB Sidebar: Unsnooze this thread");
  await expect(link(page, thread.title)).toBeVisible();
  await expect.poll(snoozedUntil).toBeNull();
});
