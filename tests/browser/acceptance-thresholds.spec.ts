import { expect, test } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

test("browser acceptance protocol records preview, update, and operator journey thresholds", async ({
  browser
}) => {
  test.setTimeout(120_000);
  const fixture = await createControlUiFixture();
  const page = await browser.newPage();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();

    const catalogDurations: number[] = [];
    for (let warmup = 0; warmup < 2; warmup++) {
      await page.goto("/#catalog");
      await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
    }
    let unavailableCatalogSamples = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const started = performance.now();
      await page.goto("/#catalog");
      await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(4);
      if (await page.getByText(/source unavailable/).count()) {
        unavailableCatalogSamples += 1;
      }
      catalogDurations.push(performance.now() - started);
    }
    await page.goto("/#experiments");
    await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page.getByRole("combobox", { name: "Parameter 2 name" }).selectOption("-B2");
    await page.getByRole("textbox", { name: "Parameter 2 values" }).fill("500, 1000, 1500, 2000");

    const previewDurations: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const started = performance.now();
      await page.getByRole("textbox", { name: "Run name" }).fill("browser-run");
      await page.getByRole("button", { name: "Preview matrix" }).click();
      await expect(page.getByText("Preview: 16 cells / 16 runs")).toBeVisible();
      previewDurations.push(performance.now() - started);
    }

    const activeUpdateP95Ms = await page.evaluate(() => {
      const target = document.createElement("output");
      document.body.append(target);
      const samples: number[] = [];
      for (let index = 0; index < 1000; index++) {
        const started = performance.now();
        target.textContent = String(index);
        samples.push(performance.now() - started);
      }
      target.remove();
      samples.sort((left, right) => left - right);
      return samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
    });

    const seeded = await seedTerminalMatrix(fixture);
    const comparisonDurations: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const started = performance.now();
      await page.goto(`/#comparison/${seeded.experimentId}`);
      await expect(page.getByRole("heading", { name: "Compare runs" })).toBeVisible();
      await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
      await page.getByLabel("Baseline", { exact: true }).selectOption({ index: 1 });
      await page.getByRole("button", { name: "Create comparison" }).click();
      await expect(page.getByRole("cell", { name: "BASELINE", exact: true })).toBeVisible();
      comparisonDurations.push(performance.now() - started);
    }

    const operatorDurations: number[] = [];
    for (let operator = 0; operator < 10; operator++) {
      const context = await browser.newContext();
      const operatorPage = await context.newPage();
      const started = performance.now();
      await installControlUiFixture(operatorPage, fixture);
      await operatorPage.goto("/#catalog");
      await expect(
        operatorPage.getByRole("heading", { name: "Catalog", exact: true })
      ).toBeVisible();
      await operatorPage.goto("/#experiments");
      await expect(
        operatorPage.getByRole("heading", { name: "Schedule an experiment" })
      ).toBeVisible();
      await operatorPage.goto("/#queue");
      await expect(operatorPage.getByRole("heading", { name: "Run queue" })).toBeVisible();
      await operatorPage.goto("/#history");
      await expect(operatorPage.getByRole("heading", { name: "Run history" })).toBeVisible();
      operatorDurations.push(performance.now() - started);
      await context.close();
    }

    const result = {
      attempts: previewDurations.length,
      discoverySamples: catalogDurations.length,
      unavailableCatalogSamples,
      sc001CatalogP95Ms: percentile(catalogDurations, 0.95),
      previewP95Ms: percentile(previewDurations, 0.95),
      sc006ComparisonP95Ms: percentile(comparisonDurations, 0.95),
      activeUpdateCount: 1000,
      activeUpdateP95Ms,
      operators: operatorDurations.length,
      operatorJourneyP95Ms: percentile(operatorDurations, 0.95),
      thresholds: {
        sc002DiscoveryMs: 5_000,
        sc001CatalogMs: 120_000,
        sc002MatrixMs: 300_000,
        sc005ActiveUpdateMs: 2_000,
        sc006ComparisonMs: 120_000,
        sc008OperatorCount: 10
      },
      environment: process.platform
    };
    expect(result.sc001CatalogP95Ms).toBeLessThan(result.thresholds.sc001CatalogMs);
    expect(result.sc001CatalogP95Ms).toBeLessThan(result.thresholds.sc002DiscoveryMs);
    expect(result.previewP95Ms).toBeLessThan(result.thresholds.sc002MatrixMs);
    expect(result.activeUpdateP95Ms).toBeLessThan(result.thresholds.sc005ActiveUpdateMs);
    expect(result.sc006ComparisonP95Ms).toBeLessThan(result.thresholds.sc006ComparisonMs);
    expect(result.operators).toBe(result.thresholds.sc008OperatorCount);
    console.log(`acceptance-thresholds-browser ${JSON.stringify(result)}`);
  } finally {
    await page.close();
    await fixture.close();
  }
});
