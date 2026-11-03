import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { fixture, rpc, shelf, link, reset, open } from "./helpers.mjs";

const filterField = (page) => page.getByRole("combobox", { name: "Filter threads" });
const chips = (page) => page.getByRole("button", { name: / from filter$/ });

/** Types a project query into the filter bar, leaving its suggestions open. */
async function suggestProjects(page, query) {
  const field = filterField(page);
  await field.click();
  await field.fill(`[${query}`);
  return field;
}

test("pinned projects can be drag sorted and keep their order after reload", async ({
  page,
  request,
  secondProject,
}) => {
  await reset(request);
  await open(page, { width: 280 });
  const field = await suggestProjects(page, "");
  for (const name of ["Sidebar smoke", secondProject.name]) {
    await page.getByRole("button", { name: `Pin ${name}`, exact: true }).click();
  }
  await field.press("Escape");
  await field.press("Escape");
  const shortcuts = page.getByRole("group", { name: "Pinned projects" });
  const first = shortcuts.getByRole("button", { name: "Filter by Sidebar smoke", exact: true });
  const second = shortcuts.getByRole("button", { name: `Filter by ${secondProject.name}`, exact: true });
  await expect(shortcuts.getByRole("button")).toHaveText(["Sidebar smoke", secondProject.name]);
  const targetBox = await second.boundingBox();
  await first.dragTo(second, { targetPosition: { x: targetBox.width - 3, y: targetBox.height / 2 } });
  await expect(shortcuts.getByRole("button")).toHaveText([secondProject.name, "Sidebar smoke"]);
  await expect(chips(page)).toHaveCount(0);
  await page.reload();
  await expect(shortcuts.getByRole("button")).toHaveText([secondProject.name, "Sidebar smoke"]);
  await first.dragTo(second, { targetPosition: { x: 3, y: targetBox.height / 2 } });
  await expect(shortcuts.getByRole("button")).toHaveText(["Sidebar smoke", secondProject.name]);
  await first.focus();
  await first.press("Alt+ArrowRight");
  await expect(shortcuts.getByRole("button")).toHaveText([secondProject.name, "Sidebar smoke"]);
  await expect(first).toBeFocused();
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(second).toHaveAttribute("aria-pressed", "false");
  await shortcuts.screenshot({ path: test.info().outputPath("pinned-project-order.png") });
});

test("filter bar picks several projects by keyboard, remembers them per window, and Clear restores every thread", async ({
  page,
  request,
  secondProject,
}) => {
  await reset(request);
  await open(page, { width: 280 });
  await expect(link(page, secondProject.thread.title)).toBeVisible();
  for (const { title } of fixture.threads) await expect(link(page, title)).toBeVisible();

  // Fuzzy: "sidsec" finds "Sidebar second project". Alt+P pins without selecting.
  const field = await suggestProjects(page, "sidsec");
  await expect(page.getByRole("option").first()).toContainText(secondProject.name);
  await field.press("Alt+p");
  await expect(page.getByRole("button", { name: `Unpin ${secondProject.name}`, exact: true })).toBeVisible();
  await expect(chips(page)).toHaveCount(0);
  await page.getByRole("listbox", { name: "Filter suggestions" }).screenshot({
    path: test.info().outputPath("filter-suggestions.png"),
  });
  await field.press("Enter");
  await expect(chips(page)).toHaveText([secondProject.name]);
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(1);
  await expect(link(page, secondProject.thread.title)).toBeVisible();
  for (const { title } of fixture.threads) await expect(link(page, title)).toHaveCount(0);

  // A second project adds to the first.
  await field.fill("[smoke");
  await field.press("Enter");
  await expect(chips(page)).toHaveText([secondProject.name, "Sidebar smoke"]);
  await field.press("Escape");
  await page.reload();
  await expect(chips(page)).toHaveText([secondProject.name, "Sidebar smoke"]);
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);

  // Pinned shortcuts and chips share one selection.
  const shortcut = page.getByRole("button", { name: `Filter by ${secondProject.name}`, exact: true });
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await shortcut.click();
  await expect(chips(page)).toHaveText(["Sidebar smoke"]);
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length);
  await shortcut.click();
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-bb-sidebar-root]").screenshot({ path: test.info().outputPath("pinned-projects.png") });

  // Before typing, the dropdown leads with recent picks.
  await filterField(page).click();
  await expect(page.getByText("Recent", { exact: true })).toBeVisible();
  await filterField(page).press("Escape");

  // Each window keeps its own selection.
  const otherWindow = await page.context().newPage();
  try {
    await open(otherWindow);
    await expect(chips(otherWindow)).toHaveCount(0);
    const otherField = await suggestProjects(otherWindow, "smoke");
    await otherField.press("Enter");
    await expect(chips(otherWindow)).toHaveText(["Sidebar smoke"]);
    await page.reload();
    await expect(chips(page)).toHaveText(["Sidebar smoke", secondProject.name]);
  } finally {
    await otherWindow.close();
  }

  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(shortcut).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  for (const { title } of [...fixture.threads, secondProject.thread]) await expect(link(page, title)).toBeVisible();
  await suggestProjects(page, "sidsec");
  await page.getByRole("button", { name: `Unpin ${secondProject.name}`, exact: true }).click();
  await filterField(page).press("Escape");
  await expect(shortcut).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("group", { name: "Pinned projects" })).toHaveCount(0);
});

test("custom project color styles persist after reload", async ({ page, request }) => {
  await reset(request);
  await open(page);
  try {
    await page.getByRole("button", { name: /^Settings \(/ }).click();
    await page.getByRole("link", { name: "BB Sidebar", exact: true }).click();
    await page.getByRole("switch", { name: "Project colors", exact: true }).check();
    await page.getByRole("combobox", { name: "Show project stripes in", exact: true }).selectOption("full");
    await expect.poll(async () => (await rpc(request, "getSidebarSettings")).projectColorsEnabled).toBe(true);
    await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(fixture.projectId);
    await page.getByLabel("Project color", { exact: true }).fill("#1f4e79");
    await page.getByRole("button", { name: "Save color", exact: true }).click();
    await expect.poll(async () => (await rpc(request, "getProjectColors")).colors[fixture.projectId]).toBe("#1f4e79");
    await page.getByRole("button", { name: "Home", exact: true }).click();
    const row = shelf(page, "Active")
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: fixture.threads[0].title, exact: true }) });
    for (let pass = 0; pass < 2; pass++) {
      await expect(row.getByText("Sidebar smoke", { exact: true })).toHaveCSS("color", "rgb(31, 78, 121)");
      await expect(row.locator("[data-project-stripe]")).toBeVisible();
      await expect(row.locator("[data-project-stripe]")).toHaveCSS("background-color", "rgb(31, 78, 121)");
      if (pass === 0) await page.reload();
    }
    expect((await rpc(request, "getSidebarSettings")).projectColorsEnabled).toBe(true);
    expect((await rpc(request, "getProjectColors")).colors[fixture.projectId]).toBe("#1f4e79");
  } finally {
    await rpc(request, "setProjectColor", { projectId: fixture.projectId, color: null });
    await rpc(request, "updateSidebarSettings", fixture.defaultSettings);
  }
});
