import { writeFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { test, fixture, menu, reset, open, link } from "./helpers.mjs";

async function colors(toast) {
  return toast.evaluate((element) => {
    const read = (el) => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, text: css.color, border: css.borderColor };
    };
    const probe = document.createElement("div");
    document.body.append(probe);
    const tokens = (background, text) => {
      probe.style.cssText = `background:var(${background});color:var(${text});border:1px solid var(--border)`;
      return read(probe);
    };
    const surface = tokens("--popover", "--popover-foreground");
    const button = tokens("--secondary", "--secondary-foreground");
    const hover = tokens("--accent", "--accent-foreground");
    const muted = tokens("--popover", "--muted-foreground").text;
    probe.remove();
    const card = element.getAttribute("data-styled") === "false" ? element.firstElementChild : element;
    const action = [...element.querySelectorAll("button")].find((el) => el.textContent === "Undo");
    const description = element.querySelector("[data-description]");
    return {
      toast: read(card),
      action: read(action),
      description: description ? read(description).text : null,
      surface,
      button,
      hover,
      muted,
    };
  });
}

async function capture(page, toast, testInfo, theme, kind) {
  const result = await colors(toast);
  writeFileSync(testInfo.outputPath(`${theme}-${kind}-colors.json`), JSON.stringify(result, null, 2));
  await page.screenshot({ path: testInfo.outputPath(`${theme}-${kind}.png`) });
  console.log(`${theme} ${kind}: ${JSON.stringify(result)}`);
  return result;
}

for (const theme of ["dark", "light"]) {
  test(`sidebar toast matches host surfaces in ${theme}`, async ({ page, request }, testInfo) => {
    await reset(request);
    await open(page, { theme });
    const thread = fixture.threads[0];
    await (await menu(page, thread.title)).getByRole("menuitem", { name: "Settle", exact: true }).click();
    const toast = page.locator("[data-sonner-toast].bb-sidebar-toast").filter({ hasText: "Thread settled" });
    await expect(toast).toBeVisible();
    const settled = await capture(page, toast, testInfo, theme, "sidebar");
    expect(settled.toast).toEqual(settled.surface);
    expect(settled.action).toEqual(settled.button);
    expect(settled.description).toBe(settled.muted);
    const undo = toast.getByRole("button", { name: "Undo", exact: true });
    await undo.hover();
    expect((await colors(toast)).action).toEqual(settled.hover);
    await undo.click();
    await expect(link(page, thread.title)).toBeVisible();

    // This bound SDK action renders BB's custom Archive toast on the same Toaster.
    await (await menu(page, thread.title)).getByRole("menuitem", { name: "Archive", exact: true }).click();
    const native = page.locator("[data-sonner-toast]").filter({ hasText: "Thread archived" });
    await expect(native).toBeVisible();
    await expect(native).not.toHaveClass(/bb-sidebar-toast/);
    const archived = await capture(page, native, testInfo, theme, "native");
    expect(archived.toast).toEqual(archived.surface);
    await native.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(link(page, thread.title)).toBeVisible();
  });
}
