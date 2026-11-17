import { renderedScreenshot } from "./support/browser-zoom";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { actionFixture, deferred } from "../fixtures/experiment-actions";
import { installControlUiFixture } from "./support/control-ui-fixture";
import { buildServer } from "../../apps/control-plane/src/server";
for (const width of [375, 768, 1280, 1440])
  test(`rerun warning, cancellation, progress and alignment at ${width}`, async ({ page }) => {
    const f = await actionFixture();
    const app = buildServer(f.platform);
    try {
      f.terminal();
      await installControlUiFixture(page, { ...f, app } as any);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/#history");
      await page.getByRole("button", { name: `Inspect ${f.runIds[0]}`, exact: true }).click();
      await page.getByRole("button", { name: "Rerun experiment", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Rerun experiment?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("startup.pf");
      await expect(dialog).toContainText("database seed");
      await expect(dialog).toContainText("workloads");
      await expect(dialog).toContainText("new comparison");
      await expect(dialog).toContainText("4 runs");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.platform.repositories.getRun(f.runIds[0])!.state).toBe("FAILED");
      await page.getByRole("button", { name: "Rerun experiment", exact: true }).click();
      const geometry = await dialog.evaluate((root) => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        buttons: Array.from(root.querySelectorAll("button")).map((b) => {
          const r = b.getBoundingClientRect();
          return { x: r.x, y: r.y, height: r.height, width: r.width };
        })
      }));
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      for (const b of geometry.buttons) expect(b.width).toBeGreaterThan(0);
      const out = path.resolve(`.parkbench/validation/feature026/ui/rerun/${width}`);
      fs.mkdirSync(out, { recursive: true });
      await renderedScreenshot(page, path.join(out, "confirmation.png"));
      fs.writeFileSync(path.join(out, "geometry.json"), JSON.stringify(geometry, null, 2));
      await dialog.getByRole("button", { name: "Rerun experiment", exact: true }).click();
      await expect.poll(() => f.platform.repositories.getRun(f.runIds[0])?.state).toBe("QUEUED");
    } finally {
      await (f.platform as any).experimentActions?.idle();
      await app.close();
      f.close();
    }
  });

test("rerun confirmation uses actual 200 percent browser zoom", async () => {
  const { atBrowserZoom200 } = await import("./support/browser-zoom");
  const f = await actionFixture(),
    app = buildServer(f.platform);
  f.terminal();
  try {
    await atBrowserZoom200(async (page, proof) => {
      await installControlUiFixture(page, { ...f, app } as any);
      await page.goto("/#history");
      await page.getByRole("button", { name: `Inspect ${f.runIds[0]}`, exact: true }).click();
      const trigger = page.getByRole("button", { name: "Rerun experiment", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Rerun experiment?" });
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      const geometry = await dialog.evaluate((el) => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        dialog: el.getBoundingClientRect().toJSON(),
        buttons: Array.from(el.querySelectorAll("button")).map((b) =>
          b.getBoundingClientRect().toJSON()
        )
      }));
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      const out = path.resolve(".parkbench/validation/feature026/ui/rerun/zoom200");
      fs.mkdirSync(out, { recursive: true });
      await renderedScreenshot(page, path.join(out, "confirmation.png"));
      fs.writeFileSync(
        path.join(out, "geometry.json"),
        JSON.stringify({ ...geometry, ...proof }, null, 2)
      );
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(f.platform.repositories.getRun(f.runIds[0])?.state).toBe("FAILED");
    });
  } finally {
    await app.close();
    f.close();
  }
});
for (const width of [375, 768, 1280, 1440])
  test(`rerun failure, refreshed progress and retry at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await (await import("./support/action-states")).actionStates(page, "RERUN", String(width));
  });
for (const width of [375, 768, 1280, 1440])
  test(`rerun eligibility loading, long name and stale confirmation at ${width}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await (
      await import("./support/action-states")
    ).confirmationEdgeStates(page, "RERUN", String(width));
  });
test("rerun conditional states at actual 200 percent browser zoom", async () => {
  const { atBrowserZoom200 } = await import("./support/browser-zoom");
  const { actionStates, confirmationEdgeStates } = await import("./support/action-states");
  await atBrowserZoom200(async (page) => {
    await confirmationEdgeStates(page, "RERUN", "zoom200");
    await page.unrouteAll();
    await page.goto("about:blank");
    await actionStates(page, "RERUN", "zoom200");
  });
});

async function delayedAcceptance(page: import("@playwright/test").Page, tag: string) {
  const f = await actionFixture(),
    app = buildServer(f.platform),
    gate = deferred();
  try {
    f.terminal();
    const other = f.additional().runs[0].id;
    const otherHeading = `Run ${JSON.parse((await app.inject({ method: "GET", url: `/api/v1/runs/${other}` })).body).name ?? other}`;
    await installControlUiFixture(page, { ...f, app } as any);
    await page.route("**/api/v1/experiments/*/actions", async (route) => {
      if (route.request().method() === "POST") await gate.promise;
      await route.fallback();
    });
    await page.goto(`/#runs/${f.runIds[0]}`);
    await page.getByRole("button", { name: "Rerun experiment", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Rerun experiment", exact: true }).click();
    await expect(dialog).toContainText("Closing this dialog does not cancel the request");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    const out = path.resolve(`.parkbench/validation/feature026/ui/rerun/${tag}`);
    fs.mkdirSync(out, { recursive: true });
    const geometry = await dialog.evaluate((el) => ({
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      dialog: el.getBoundingClientRect().toJSON(),
      buttons: Array.from(el.querySelectorAll("button")).map((b) =>
        b.getBoundingClientRect().toJSON()
      )
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await renderedScreenshot(page, path.join(out, "accepting.png"));
    fs.writeFileSync(path.join(out, "accepting-geometry.json"), JSON.stringify(geometry, null, 2));
    await page.goto(`/#runs/${other}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(otherHeading);
    gate.resolve();
    await expect.poll(() => f.platform.repositories.getRun(f.runIds[0])?.state).toBe("QUEUED");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(otherHeading);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("Experiment queued for rerun.", { exact: true })).toHaveCount(0);
  } finally {
    gate.resolve();
    await f.platform.experimentActions.idle();
    await app.close();
    f.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`late acceptance cannot replace a newly opened experiment at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await delayedAcceptance(page, String(width));
  });
test("accepting confirmation at actual 200 percent zoom survives navigation", async () => {
  await (
    await import("./support/browser-zoom")
  ).atBrowserZoom200((page) => delayedAcceptance(page, "zoom200"));
});
