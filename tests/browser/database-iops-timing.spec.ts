import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";
import { resolveDatabaseIops } from "../../packages/contracts/src/database-iops";
import { atBrowserZoom200, renderedScreenshot } from "./support/browser-zoom";

const output = path.resolve(".parkbench/validation/feature026/ui/iops-timing");
async function verify(page: Page, label: string) {
  const fixture = await createControlUiFixture();
  try {
    const seeded = await seedTerminalMatrix(fixture),
      id = seeded.runIds[0];
    const run = fixture.platform.repositories.getRun(id)!;
    const metadata = fixture.platform.controlRepository.getRunMetadata(id)!;
    const condition = resolveDatabaseIops("sata-ssd-t1");
    for (const snapshot of [run.environmentSnapshot, metadata.snapshot] as any[]) {
      snapshot.databaseIops = condition;
      if (snapshot.requestedConfiguration) snapshot.requestedConfiguration.databaseIops = condition;
      if (snapshot.variant) snapshot.variant.databaseIops = condition;
      snapshot.databaseIopsEvidence = {
        condition,
        applicationTiming: "AFTER_SETUP_BEFORE_DATABASE_STARTUP",
        stage: "COMPLETED",
        verification: { status: "MATCHED", checks: 3 },
        deviceCount: 1
      };
    }
    fixture.platform.repositories.saveRun(run);
    fixture.platform.controlRepository.saveRunMetadata({ ...metadata, runId: id });
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    const field = page.locator(".database-iops-field");
    await field.getByRole("button", { name: "Help for Database disk IOPS", exact: true }).focus();
    await expect(page.getByRole("tooltip")).toContainText(
      "All setup scripts finish before limits apply."
    );
    await field.scrollIntoViewIfNeeded();
    const geometry = await field.evaluate((el) => {
      const label = el.querySelector(".database-iops-label")!;
      const range = document.createRange();
      range.selectNodeContents(label.firstChild!);
      return {
        viewport: innerWidth,
        overflow: document.documentElement.scrollWidth - innerWidth,
        label: range.getClientRects()[0].toJSON(),
        help: el.querySelector(".field-help-trigger")!.getBoundingClientRect().toJSON(),
        control: el.querySelector(".database-iops-trigger")!.getBoundingClientRect().toJSON(),
        tooltip: document.querySelector('[role="tooltip"]')!.getBoundingClientRect().toJSON()
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        geometry.label.y + geometry.label.height / 2 - geometry.help.y - geometry.help.height / 2
      )
    ).toBeLessThanOrEqual(4);
    expect(geometry.tooltip.right).toBeLessThanOrEqual(geometry.viewport);
    fs.mkdirSync(output, { recursive: true });
    await renderedScreenshot(page, path.join(output, `${label}-help.png`));
    fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(geometry, null, 2));
    await page.goto(`/#runs/${id}`);
    const summary = page.locator(".database-iops-summary");
    await expect(summary).toContainText(
      "After preparation and all setup scripts; before benchmark database startup."
    );
    await summary.evaluate((el) => {
      const header = document.querySelector(".topbar")!.getBoundingClientRect();
      window.scrollTo(0, el.getBoundingClientRect().top + scrollY - header.height - 12);
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(1);
    await renderedScreenshot(page, path.join(output, `${label}-summary.png`));
    for (const [timing, message] of [
      ["BEFORE_DATABASE_STARTUP", "Before database startup, including native repair and setup."],
      ["AFTER_DATABASE_PREPARATION", "After database preparation."],
      [undefined, "Application timing was not recorded in this historical evidence."]
    ] as const) {
      for (const snapshot of [run.environmentSnapshot, metadata.snapshot] as any[])
        snapshot.databaseIopsEvidence.applicationTiming = timing;
      fixture.platform.repositories.saveRun(run);
      fixture.platform.controlRepository.saveRunMetadata({ ...metadata, runId: id });
      await page.reload();
      await expect(page.locator(".database-iops-summary")).toContainText(message);
    }
  } finally {
    await fixture.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`startup IOPS timing and help wrap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await verify(page, String(width));
  });
test("startup IOPS timing and help at actual 200% browser zoom", async () => {
  test.setTimeout(90000);
  await atBrowserZoom200(async (page, proof) => {
    await verify(page, "actual-200-percent");
    fs.writeFileSync(path.join(output, "actual-200-percent-zoom.json"), JSON.stringify(proof));
  });
});
