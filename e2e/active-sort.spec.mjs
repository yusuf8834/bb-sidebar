import { expect } from "@playwright/test";
import { test, reset, open } from "./helpers.mjs";

test.beforeEach(async ({ request, page }) => {
  await reset(request);
  await open(page);
});

test("Active sort arrow keys keep the picker open until Enter commits", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /^Sort active threads:/ });
  const picker = page.getByRole("dialog", { name: "Sort active threads" });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(picker).toHaveAttribute("data-state", "open");
  const manual = picker.getByRole("radio", { name: "Manual order" });
  await expect(manual).toBeChecked();
  await expect(manual).toBeFocused();
  await manual.press("ArrowDown");
  await expect(picker).toHaveAttribute("data-state", "open");
  const activity = picker.getByRole("radio", { name: "Recent activity" });
  await expect(activity).toBeChecked();
  await expect(activity).toBeFocused();
  await activity.press("Space");
  await expect(picker).toHaveAttribute("data-state", "open");
  await activity.press("ArrowDown");
  await expect(picker).toHaveAttribute("data-state", "open");
  const waiting = picker.getByRole("radio", { name: "Waiting longest" });
  await expect(waiting).toBeChecked();
  await expect(waiting).toBeFocused();
  await waiting.press("ArrowDown");
  const created = picker.getByRole("radio", { name: "Date created" });
  await expect(created).toBeChecked();
  await expect(created).toBeFocused();
  await created.press("Enter");
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(trigger).toHaveAccessibleName("Sort active threads: Date created");
  await trigger.press("Enter");
  await expect(created).toBeChecked();
  await expect(created).toBeFocused();
  await created.press("Escape");
  await expect(picker).toBeHidden();
});

test("Active sort keeps Project open and dismisses other pointer choices", async ({ page }) => {
  await page.getByRole("button", { name: "Sort active threads: Manual order" }).click();
  const picker = page.getByRole("dialog", { name: "Sort active threads" });
  await picker.getByText("Project", { exact: true }).click();
  const project = picker.getByRole("radio", { name: "Project", exact: true });
  await expect(project).toBeChecked();
  await project.press("Enter");
  await expect(picker).toHaveAttribute("data-state", "open");
  const toggle = picker.getByRole("checkbox", { name: "Group by worktree" });
  await expect(toggle).toBeVisible();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
  await picker.getByText("Manual order", { exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("button", { name: "Sort active threads: Manual order" })).toBeVisible();
});
