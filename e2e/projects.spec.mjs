import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { fixture, rpc, shelf, link, reset, open } from "./helpers.mjs";

test("pinned projects can be drag sorted and keep their order after reload", async ({
  page,
  request,
  secondProject,
}) => {
  await reset(request);
  await open(page, { width: 280 });
  await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
  for (const name of ["Sidebar smoke", secondProject.name]) {
    await page.getByRole("button", { name: `Pin ${name}`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const shortcuts = page.getByRole("group", { name: "Pinned projects" });
  const first = shortcuts.getByRole("button", { name: "Filter by Sidebar smoke", exact: true });
  const second = shortcuts.getByRole("button", { name: `Filter by ${secondProject.name}`, exact: true });
  await expect(shortcuts.getByRole("button")).toHaveText(["Sidebar smoke", secondProject.name]);
  const targetBox = await second.boundingBox();
  await first.dragTo(second, { targetPosition: { x: targetBox.width - 3, y: targetBox.height / 2 } });
  await expect(shortcuts.getByRole("button")).toHaveText([secondProject.name, "Sidebar smoke"]);
  await expect(page.getByRole("button", { name: "Project scope: All projects", exact: true })).toBeVisible();
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

test("project filter remembers multiple projects per window and All projects restores every thread", async ({
  page,
  request,
  secondProject,
}) => {
  await reset(request);
  await open(page, { width: 280 });
  await expect(link(page, secondProject.thread.title)).toBeVisible();
  for (const { title } of fixture.threads) await expect(link(page, title)).toBeVisible();
  await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
  const filter = page.getByRole("combobox", { name: "Filter projects" });
  await filter.fill(secondProject.name);
  await filter.press("Tab");
  await expect(page.getByRole("button", { name: `Pin ${secondProject.name}`, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Unpin ${secondProject.name}`, exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Project scope: All projects", exact: true })).toBeVisible();
  await filter.fill("");
  await page.getByRole("row", { name: "Sidebar smoke", exact: true }).hover();
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("project-picker.png") });
  const pickerWidth = await page.getByRole("dialog").evaluate((element) => element.getBoundingClientRect().width);
  const scopeLayout = async () => ({
    headerHeight: await page
      .getByRole("button", { name: /^Project scope:/ })
      .evaluate((element) => element.getBoundingClientRect().height),
    pinsTop: await page
      .getByRole("group", { name: "Pinned projects" })
      .evaluate((element) => element.getBoundingClientRect().top),
  });
  const unfilteredLayout = await scopeLayout();
  await page.getByRole("row", { name: secondProject.name, exact: true }).click();
  await expect(page.getByRole("button", { name: "Project scope: 1 project", exact: true })).toBeVisible();
  expect(await scopeLayout()).toEqual(unfilteredLayout);
  await expect(page.getByRole("button", { name: "Reset project filter", exact: true })).toBeVisible();
  await expect
    .poll(() => page.getByRole("dialog").evaluate((element) => element.getBoundingClientRect().width))
    .toBe(pickerWidth);
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("project-picker-selected.png") });
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(1);
  await expect(link(page, secondProject.thread.title)).toBeVisible();
  for (const { title } of fixture.threads) await expect(link(page, title)).toHaveCount(0);

  // The picker stays open for a second choice; Enter toggles the filtered result.
  await page.getByRole("combobox", { name: "Filter projects" }).fill("Sidebar smoke");
  await page.getByRole("combobox", { name: "Filter projects" }).press("Enter");
  const selectedLabel = "Project scope: Sidebar smoke + 1 project";
  await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  const shortcut = page.getByRole("button", { name: `Filter by ${secondProject.name}`, exact: true });
  await expect(shortcut).toBeVisible();
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await shortcut.click();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length);
  await expect(shortcut).toHaveAttribute("aria-pressed", "false");
  await shortcut.click();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-bb-sidebar-root]").screenshot({ path: test.info().outputPath("pinned-projects.png") });
  await page.getByRole("button", { name: "Reset project filter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Project scope: All projects", exact: true })).toBeVisible();
  await expect(shortcut).toHaveAttribute("aria-pressed", "false");
  // Both pinned shortcuts toggle independently and share their state with the picker.
  expect(await scopeLayout()).toEqual(unfilteredLayout);
  await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
  await page.getByRole("button", { name: "Pin Sidebar smoke", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await shortcut.click();
  expect(await scopeLayout()).toEqual(unfilteredLayout);
  await page.getByRole("button", { name: "Filter by Sidebar smoke", exact: true }).click();
  await expect(page.getByRole("button", { name: "Project scope: 2 projects", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter by Sidebar smoke", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Project scope: 2 projects", exact: true }).click();
  await expect(page.getByRole("row", { name: secondProject.name, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("row", { name: "Sidebar smoke", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Unpin Sidebar smoke", exact: true }).click();
  await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();

  const otherWindow = await page.context().newPage();
  try {
    await open(otherWindow);
    await expect(otherWindow.getByRole("button", { name: "Project scope: All projects", exact: true })).toBeVisible();
    await otherWindow.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
    await otherWindow.getByRole("row", { name: secondProject.name, exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: selectedLabel, exact: true })).toBeVisible();
  } finally {
    await otherWindow.close();
  }

  await page.getByRole("button", { name: selectedLabel, exact: true }).click();
  await page.getByRole("row", { name: "Sidebar smoke", exact: true }).click();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(1);
  await page.getByRole("row", { name: "All projects", exact: true }).click();
  await expect
    .poll(() => page.getByRole("dialog").evaluate((element) => element.getBoundingClientRect().width))
    .toBe(pickerWidth);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Project scope: All projects", exact: true })).toBeVisible();
  await expect(shelf(page, "Active").getByRole("link")).toHaveCount(fixture.threads.length + 1);
  for (const { title } of [...fixture.threads, secondProject.thread]) await expect(link(page, title)).toBeVisible();
  await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
  await page.getByRole("button", { name: `Unpin ${secondProject.name}`, exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(shortcut).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("group", { name: "Pinned projects" })).toHaveCount(0);
});

test("project headings share filter and pin actions with the picker", async ({ page, request, secondProject }) => {
  await reset(request);
  await open(page, { width: 280 });
  const name = secondProject.name;
  const group = page.getByRole("region", { name: `${name} project`, exact: true });
  const pin = group.getByRole("button", { name: `Pin ${name} to top` });
  const filter = group.getByRole("button", { name: `Filter by ${name}` });
  await expect(pin).toHaveCount(0);
  await page.getByRole("button", { name: "Sort active threads: Manual order" }).click();
  await page.getByRole("dialog", { name: "Sort active threads" }).getByText("Project", { exact: true }).click();
  await page.keyboard.press("Escape");
  const heading = group.getByRole("button", { expanded: true });
  await heading.hover();
  await expect(pin).toBeInViewport();
  await expect(pin.locator("..")).toHaveCSS("opacity", "1");
  await group.screenshot({ path: test.info().outputPath("project-header-actions.png") });
  await pin.click();
  await expect(page.getByRole("button", { name: "Project scope: All projects" })).toBeVisible();
  await heading.focus();
  await heading.press("Tab");
  await expect(filter).toBeFocused();
  await filter.press("Enter");
  await expect(heading).toBeVisible();
  await expect(link(page, fixture.threads[0].title)).toHaveCount(0);
  const shortcut = page
    .getByRole("group", { name: "Pinned projects" })
    .getByRole("button", { name: `Filter by ${name}` });
  await expect(shortcut).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Project scope: 1 project" }).click();
  const row = page.getByRole("row", { name, exact: true });
  await expect(row).toHaveAttribute("aria-selected", "true");
  await row.getByRole("button", { name: `Unpin ${name}` }).click();
  await row.click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(shortcut).toHaveCount(0);
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await expect(link(page, fixture.threads[0].title)).toBeVisible();
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
