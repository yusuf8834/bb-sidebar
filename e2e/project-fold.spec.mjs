import { expect } from "@playwright/test";
import { seededTest as test } from "./seeds.mjs";
import { fixture, open, reset, rpc, shelf } from "./helpers.mjs";

test.use({ reducedMotion: "no-preference" });

test("folding a project keeps its heading still and the next project clear of its rows", async ({
  page,
  request,
  secondProject,
}) => {
  await reset(request);
  await rpc(request, "reorderInbox", {
    inboxThreadIds: [...fixture.threads, secondProject.thread].map(({ id }) => id),
  });
  await open(page);
  await page.getByRole("button", { name: "Sort active threads: Manual order" }).click();
  await page.getByRole("dialog").getByText("Project", { exact: true }).click();
  await page.keyboard.press("Escape");
  const groups = shelf(page, "Active").getByRole("region", { name: / project$/ });
  await expect(groups).toHaveCount(2);
  const heading = groups.first().getByRole("button", { expanded: true });
  await heading.hover();
  // Measure the rendered positions after each commit, including the intervening animation frames.
  for (const expanded of [false, true, false, true]) {
    const sample = await groups.first().evaluate(async (group, expanded) => {
      const next = group.closest("li").nextElementSibling;
      const button = group.querySelector("button[aria-expanded]");
      const label = button.querySelector(".truncate");
      const before = label.getBoundingClientRect().top;
      let drift = 0;
      let overlap = 0;
      button.click();
      const start = performance.now();
      while (performance.now() - start < 300) {
        await new Promise(requestAnimationFrame);
        if (button.getAttribute("aria-expanded") !== String(expanded)) continue;
        drift = Math.max(drift, Math.abs(label.getBoundingClientRect().top - before));
        overlap = Math.max(overlap, group.getBoundingClientRect().bottom - next.getBoundingClientRect().top);
      }
      return { drift, overlap, expanded: button.getAttribute("aria-expanded") };
    }, expanded);
    expect(sample).toEqual({ drift: 0, overlap: 0, expanded: String(expanded) });
  }
});
