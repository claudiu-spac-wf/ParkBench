import os from "node:os";
import { createSeedFixture } from "../helpers/seed";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";
test("disk preset dropdown supports keyboard, empty validation, matrix preview and responsive wrapping", async ({
  page
}) => {
  test.setTimeout(90000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-ui-"));
  createSeedFixture(root, "iops-seed");
  const fixture = await createControlUiFixture({ discoveryRoots: { seeds: root } });
  const out = path.resolve(".parkbench/validation/feature025/ui");
  fs.mkdirSync(out, { recursive: true });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    const field = page.locator(".database-iops-field");
    const trigger = page.getByRole("button", { name: /^Database disk IOPS:/ });
    await expect(trigger).toContainText("Unlimited", { timeout: 30000 });
    await trigger.click();
    await page.getByRole("checkbox", { name: /^HDD/ }).check();
    await expect(page.getByRole("checkbox", { name: /^Unlimited/ })).toBeChecked();
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: path.join(out, `${width}-mixed.png`), fullPage: true });
      const geometry = await field.evaluate((el) => ({
        field: el.getBoundingClientRect().toJSON(),
        overflow: document.documentElement.scrollWidth - innerWidth,
        controls: Array.from(el.querySelectorAll("button,input")).map((x) =>
          x.getBoundingClientRect().toJSON()
        )
      }));
      fs.writeFileSync(path.join(out, `${width}.json`), JSON.stringify(geometry));
      expect(geometry.overflow).toBeLessThanOrEqual(1);
    }
    await page.getByRole("textbox", { name: "Run name", exact: true }).fill("iops-browser");
    await page.getByRole("combobox").nth(1).selectOption("input:seeds/iops-seed");
    await page
      .getByRole("combobox", { name: "Parameter 1 name" })
      .selectOption("network.databaseLatencyMs");
    await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("0, 5");
    await page.getByRole("spinbutton", { name: "Repetitions", exact: true }).fill("2");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.locator(".preview-panel tbody tr")).toHaveCount(8);
    await expect(page.locator(".database-iops-preview").first()).toContainText(
      "150 read / 150 write"
    );
    await page.getByRole("checkbox", { name: /^HDD/ }).uncheck();
    await expect(page.locator(".preview-panel")).toHaveCount(0);
    await page.getByRole("checkbox", { name: /^Unlimited/ }).uncheck();
    await expect(field.getByRole("alert")).toContainText("Select at least one");
    await expect(page.getByRole("button", { name: "Preview matrix" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /^HDD/ }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("checkbox", { name: /^HDD/ })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("disk presets preserve alignment at actual 200 percent browser zoom", async () => {
  test.setTimeout(150000);
  const zoomOrigin = process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:4173";
  const { chromium } = await import("@playwright/test");
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-zoom-"));
  const ext = path.join(root, "extension");
  fs.mkdirSync(ext);
  fs.writeFileSync(
    path.join(ext, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "IOPS layout zoom validation",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "background.js" }
    })
  );
  fs.writeFileSync(
    path.join(ext, "background.js"),
    "chrome.runtime.onInstalled.addListener(()=>{});"
  );
  const fixture = await createControlUiFixture();
  const context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      "--window-size=1280,2000",
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`
    ]
  });
  try {
    const page = await context.newPage();
    await installControlUiFixture(page, fixture);
    await page.goto(zoomOrigin + "/#experiments", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^Database disk IOPS:/ }).click();
    for (const name of ["HDD", "SATA SSD", "Slow NVME", "Fast NVME"])
      await page.getByRole("checkbox", { name: new RegExp("^" + name) }).check();
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(async (zoomOrigin) => {
      const chrome = (globalThis as any).chrome;
      const tabs = await chrome.tabs.query({ url: zoomOrigin + "/*" });
      await chrome.tabs.setZoom(tabs[0].id, 2);
    }, zoomOrigin);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(768);
    const geometry = await page.locator(".database-iops-field").evaluate((el) => ({
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      field: el.getBoundingClientRect().toJSON()
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    const out = path.resolve(".parkbench/validation/feature025/ui");
    fs.mkdirSync(out, { recursive: true });
    await page.locator(".database-iops-field").scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const cdp = await context.newCDPSession(page);
    const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: false });
    fs.writeFileSync(path.join(out, "actual-200-percent.png"), Buffer.from(capture.data, "base64"));
    fs.writeFileSync(
      path.join(out, "actual-200-percent.json"),
      JSON.stringify({ ...geometry, browserZoom: 2 })
    );
  } finally {
    await context.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
