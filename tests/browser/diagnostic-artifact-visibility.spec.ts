import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { actionFixture } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
import { installControlUiFixture } from "./support/control-ui-fixture";
import { atBrowserZoom200, renderedScreenshot } from "./support/browser-zoom";
import { reportRuntime } from "./report-runtime";

async function verify(page: Page, tag: string, proof: any = {}) {
  const f = await actionFixture(),
    app = buildServer(f.platform);
  f.terminal();
  const id = f.runIds[0];
  const hidden = f.platform.artifacts.write(id, "diagnostics", "internal.json", "{}"),
    visible = f.platform.artifacts.write(id, "load_summary", "summary.json", "{}");
  const out = path.resolve(".parkbench/validation/feature026/diagnostic-visibility", tag);
  fs.mkdirSync(out, { recursive: true });
  try {
    await installControlUiFixture(page, { ...f, app } as any);
    // Defend against a stale server response as well as the current filtered API.
    await page.route(`**/api/v1/history/runs/${id}`, async (route) => {
      const detail = f.platform.controlUi.historyDetail(id)!;
      await route.fulfill({
        json: {
          ...detail,
          artifacts: [
            ...(detail.artifacts as any[]),
            { ...hidden, downloadUrl: `/api/v1/runs/${id}/artifacts/${hidden.id}` }
          ]
        }
      });
    });
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${id}`, exact: true }).click();
    await expect(
      page.getByRole("link", { name: "load_summary artifact", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "diagnostics artifact", exact: true })).toHaveCount(
      0
    );
    await expect(page.locator(`a[href*="${hidden.id}"]`)).toHaveCount(0);
    await page
      .getByRole("link", { name: "load_summary artifact", exact: true })
      .scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      links: Array.from(document.querySelectorAll("a"))
        .filter((a) => (a.textContent ?? "").includes("artifact"))
        .map((a) => ({ text: a.textContent, box: a.getBoundingClientRect().toJSON() }))
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await renderedScreenshot(page, path.join(out, "history.png"));
    fs.writeFileSync(
      path.join(out, "history.json"),
      JSON.stringify({ ...geometry, ...proof }, null, 2)
    );
    expect(f.platform.repositories.listArtifacts(id).some((a) => a.id === hidden.id)).toBe(true);
    expect(fs.existsSync(f.platform.storage.safePath(hidden.path))).toBe(true);
  } finally {
    await app.close();
    f.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`diagnostic files stay hidden while result downloads remain at ${width}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await verify(page, String(width));
  });
test("diagnostic visibility at actual200 percent zoom", async () => {
  test.setTimeout(90000);
  await atBrowserZoom200((page, proof) => verify(page, "zoom200", proof));
});

async function verifyReport(page: Page, tag: string, proof: any = {}) {
  const runtime = await reportRuntime(page);
  const out = path.resolve(".parkbench/validation/feature026/diagnostic-visibility", tag);
  fs.mkdirSync(out, { recursive: true });
  try {
    await page.route(`**/api/v1/reports/${runtime.report.id}`, async (route) => {
      const response = await route.fetch(),
        value = await response.json();
      value.report.artifacts.push({
        id: "hidden-diagnostic",
        kind: "DIAGNOSTIC",
        filename: "internal-diagnostic.txt",
        byteLength: 10,
        complete: true,
        mediaType: "text/plain"
      });
      await route.fulfill({ response, json: value });
    });
    await page.goto(runtime.address + "/#reports/" + runtime.report.id);
    await page.getByLabel("Report view", { exact: true }).selectOption("files");
    const normal = page.getByRole("link", {
      name: "Download full dataset: table.csv",
      exact: true
    });
    await expect(normal).toBeVisible();
    await expect(page.getByRole("link", { name: /Download diagnostic/ })).toHaveCount(0);
    await expect(page.getByText("internal-diagnostic.txt")).toHaveCount(0);
    await normal.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      links: Array.from(document.querySelectorAll(".report-artifacts a")).map((a) =>
        a.getBoundingClientRect().toJSON()
      )
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await renderedScreenshot(page, path.join(out, "reports.png"));
    fs.writeFileSync(
      path.join(out, "reports.json"),
      JSON.stringify({ ...geometry, ...proof }, null, 2)
    );
  } finally {
    await runtime.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`report diagnostic files stay hidden at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await verifyReport(page, String(width));
  });
test("report diagnostic visibility at actual200 percent zoom", async () => {
  test.setTimeout(90000);
  await atBrowserZoom200((page, proof) => verifyReport(page, "zoom200", proof));
});
