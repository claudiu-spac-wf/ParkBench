import { renderedScreenshot } from "./support/browser-zoom";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { actionFixture } from "../fixtures/experiment-actions";
import { installControlUiFixture } from "./support/control-ui-fixture";
import { buildServer } from "../../apps/control-plane/src/server";
import { atBrowserZoom200 } from "./support/browser-zoom";
async function exercise(page: any, proof: any = {}) {
  const f = await actionFixture(),
    app = buildServer(f.platform);
  f.terminal();
  try {
    await installControlUiFixture(page, { ...f, app } as any);
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${f.runIds[0]}`, exact: true }).click();
    const trigger = page.getByRole("button", { name: "Remove experiment", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Remove experiment?" });
    await expect(dialog).toContainText("4 runs");
    await expect(dialog).toContainText("permanently deleted");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(f.platform.repositories.listRuns(f.submitted.id)).toHaveLength(4);
    await trigger.click();
    const geometry = await dialog.evaluate((root: any) => ({
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      buttons: Array.from(root.querySelectorAll("button")).map((b: any) =>
        b.getBoundingClientRect().toJSON()
      )
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    const out = path.resolve(
      `.parkbench/validation/feature026/ui/removal/${proof.browserZoom ? "zoom200" : geometry.viewport}`
    );
    fs.mkdirSync(out, { recursive: true });
    await renderedScreenshot(page, path.join(out, "confirmation.png"));
    fs.writeFileSync(
      path.join(out, "geometry.json"),
      JSON.stringify({ ...geometry, ...proof }, null, 2)
    );
    await dialog.getByRole("button", { name: "Remove experiment", exact: true }).click();
    await expect.poll(() => f.platform.repositories.getExperiment(f.submitted.id)).toBeUndefined();
    await expect(
      page.getByRole("button", { name: `Inspect ${f.runIds[0]}`, exact: true })
    ).toHaveCount(0);
  } finally {
    await f.platform.experimentActions.idle();
    await app.close();
    f.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`remove entire experiment, cancel, keyboard and alignment at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await exercise(page);
  });
test("removal at actual 200 percent browser zoom", async () => {
  await atBrowserZoom200(exercise);
});
for (const width of [375, 768, 1280, 1440])
  test(`removal failure, refreshed progress and retry at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await (await import("./support/action-states")).actionStates(page, "REMOVE", String(width));
  });
for (const width of [375, 768, 1280, 1440])
  test(`removal eligibility loading, long name and stale confirmation at ${width}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await (
      await import("./support/action-states")
    ).confirmationEdgeStates(page, "REMOVE", String(width));
  });
test("removal conditional states at actual 200 percent browser zoom", async () => {
  const { actionStates, confirmationEdgeStates } = await import("./support/action-states");
  await atBrowserZoom200(async (page) => {
    await confirmationEdgeStates(page, "REMOVE", "zoom200");
    await page.unrouteAll();
    await page.goto("about:blank");
    await actionStates(page, "REMOVE", "zoom200");
  });
});
