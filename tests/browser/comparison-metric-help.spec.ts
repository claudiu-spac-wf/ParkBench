import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";
import { COMPARISON_METRIC_CATALOG as catalog } from "../../packages/contracts/src/comparison-metric-selection";
test("every metric has adjacent accessible help without changing its selection", async ({
  page
}) => {
  test.setTimeout(180000);
  const fixture = await createControlUiFixture();
  try {
    const seeded = await seedTerminalMatrix(fixture);
    await installControlUiFixture(page, fixture);
    await page.goto(`/#comparison/${seeded.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.mouse.move(0, 0);
      for (const descriptor of catalog) {
        const row = page
          .locator(".metric-choice-row")
          .filter({ has: page.locator(`[data-metric-id="${descriptor.metricId}"]`) });
        const current = page.locator(`[data-metric-id="${descriptor.metricId}"]`).first();
        const checkbox = current.getByRole("checkbox", {
          name: descriptor.displayName,
          exact: true
        });
        const before = await checkbox.isChecked();
        const help = current.getByRole("button", {
          name: `Help for ${descriptor.displayName}`,
          exact: true
        });
        await help.focus();
        await expect(page.getByRole("tooltip")).toContainText(descriptor.description);
        await page.keyboard.press("Escape");
        await expect(checkbox).toBeChecked({ checked: before });
        if (width >= 1280) {
          const text = await current.locator(".metric-title-text").boundingBox(),
            icon = await help.boundingBox();
          expect(text && icon).toBeTruthy();
          const firstLine = await current.locator(".metric-title-text").evaluate((el) => {
            const r = document.createRange();
            r.selectNodeContents(el);
            const rect = r.getClientRects()[0];
            return { y: rect.y, height: rect.height };
          });
          expect(
            Math.abs(firstLine.y + firstLine.height / 2 - icon!.y - icon!.height / 2)
          ).toBeLessThanOrEqual(1);
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      ).toBeLessThanOrEqual(1);
      const output = path.resolve(".parkbench/validation/feature023/metrics");
      fs.mkdirSync(output, { recursive: true });
      await page
        .getByRole("button", { name: `Help for ${catalog[0].displayName}`, exact: true })
        .first()
        .focus();
      await page.screenshot({ path: path.join(output, `help-${width}.png`) });
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: `Help for ${catalog[0].displayName}`, exact: true })
        .first()
        .evaluate((element) => (element as HTMLElement).blur());
      fs.writeFileSync(
        path.join(output, `help-${width}.json`),
        JSON.stringify(
          {
            width,
            metricCount: catalog.length,
            allHelpVerified: true,
            maximumAllowedFirstLineOffsetPx: 1,
            overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
          },
          null,
          2
        )
      );
    }
  } finally {
    await fixture.close();
  }
});

// Native Chrome tab zoom changes layout width; deviceScaleFactor alone does not.
test("metric help stays aligned at native 200 percent browser zoom", async () => {
  const { chromium } = await import("@playwright/test");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-metric-zoom-"));
  const extension = path.join(root, "extension");
  fs.mkdirSync(extension);
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "ParkBench validation zoom",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "background.js" }
    })
  );
  fs.writeFileSync(
    path.join(extension, "background.js"),
    "chrome.runtime.onInstalled.addListener(() => {});"
  );
  const context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      "--window-size=1280,900",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`
    ]
  });
  const fixture = await createControlUiFixture();
  try {
    const page = await context.newPage();
    const seeded = await seedTerminalMatrix(fixture);
    await installControlUiFixture(page, fixture);
    await page.goto(`http://127.0.0.1:4173/#comparison/${seeded.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:4173/*" });
      await chrome.tabs.setZoom(tabs[0].id, 2);
    });
    await page.mouse.move(0, 0);
    const help = page
      .getByRole("button", { name: `Help for ${catalog[0].displayName}`, exact: true })
      .first();
    await help.focus();
    await expect(page.getByRole("tooltip")).toContainText(catalog[0].description);
    const metrics = await page.evaluate(() => ({
      innerWidth,
      outerWidth,
      dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth - innerWidth
    }));
    expect(metrics.innerWidth).toBeLessThan(metrics.outerWidth * 0.6);
    expect(metrics.overflow).toBeLessThanOrEqual(1);
    const geometry = await help.evaluate((el) => {
      const t = el.closest(".metric-title")!.querySelector(".metric-title-text")!;
      const r = document.createRange();
      r.selectNodeContents(t);
      const a = r.getClientRects()[0],
        b = el.getBoundingClientRect();
      return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
    });
    expect(geometry).toBeLessThanOrEqual(1);
    const output = path.resolve(".parkbench/validation/feature023/metrics");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "native-zoom.json"),
      JSON.stringify({ method: "chrome.tabs.setZoom", zoom: 2, metrics, geometry }, null, 2)
    );
    const cdp = await context.newCDPSession(page);
    const screenshot = await cdp.send("Page.captureScreenshot", { fromSurface: false });
    fs.writeFileSync(path.join(output, "native-zoom.png"), Buffer.from(screenshot.data, "base64"));
  } finally {
    await fixture.close();
    await context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
