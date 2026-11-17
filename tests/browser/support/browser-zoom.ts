import { chromium, expect, Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export async function atBrowserZoom200(
  run: (page: Page, proof: { browserZoom: number; viewport: number }) => Promise<void>
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-zoom-")),
    ext = path.join(root, "extension");
  fs.mkdirSync(ext);
  fs.writeFileSync(
    path.join(ext, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "ParkBench browser zoom verification",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "background.js" }
    })
  );
  fs.writeFileSync(
    path.join(ext, "background.js"),
    "chrome.runtime.onInstalled.addListener(()=>{});"
  );
  const context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      "--window-size=1280,1800",
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`
    ]
  });
  try {
    const page = await context.newPage(),
      origin = process.env.PARKBENCH_CONTROL_UI_URL ?? "http://127.0.0.1:4173";
    await page.goto(origin);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const browserZoom = await worker.evaluate(async (origin) => {
      const chrome = (globalThis as any).chrome;
      const [tab] = await chrome.tabs.query({ url: origin + "/*" });
      await chrome.tabs.setZoom(tab.id, 2);
      return chrome.tabs.getZoom(tab.id);
    }, origin);
    expect(browserZoom).toBe(2);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(768);
    await run(page, { browserZoom, viewport: await page.evaluate(() => innerWidth) });
  } finally {
    await context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
export async function renderedScreenshot(page: Page, file: string): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  if (page.viewportSize()) {
    await page.screenshot({ path: file });
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  try {
    const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: false });
    fs.writeFileSync(file, Buffer.from(capture.data, "base64"));
  } finally {
    await cdp.detach();
  }
}
