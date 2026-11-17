import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { actionFixture, deferred } from "../fixtures/experiment-actions";
import { buildServer } from "../../apps/control-plane/src/server";
import { installControlUiFixture } from "./support/control-ui-fixture";
import { atBrowserZoom200, renderedScreenshot } from "./support/browser-zoom";
async function verify(page: Page, tag: string, proof: any = {}) {
  const f = await actionFixture({}, ":memory:", { values: [500, 1000], repetitions: 10 }),
    app = buildServer(f.platform),
    gate = deferred();
  f.terminal();
  const target = f.runIds[0],
    siblings = f.platform.repositories
      .listRuns(f.submitted.id)
      .slice(1)
      .map((r) => JSON.stringify(r));
  let fail = true;
  const admin = f.platform.experimentActions.metricAdmin,
    remove = admin.delete.bind(admin);
  admin.delete = async (s) => {
    if (fail) throw Error("experiment_metrics_delete_failed");
    await gate.promise;
    await remove(s);
  };
  const out = path.resolve(`.parkbench/validation/feature026/ui/individual/${tag}`);
  fs.mkdirSync(out, { recursive: true });
  async function capture(name: string) {
    const dialog = page.getByRole("dialog");
    const geometry = await dialog.evaluate((el) => ({
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      dialog: el.getBoundingClientRect().toJSON(),
      buttons: Array.from(el.querySelectorAll("button")).map((b) =>
        b.getBoundingClientRect().toJSON()
      )
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    for (const b of geometry.buttons) {
      expect(b.width).toBeGreaterThan(0);
      expect(b.left).toBeGreaterThanOrEqual(geometry.dialog.left);
      expect(b.right).toBeLessThanOrEqual(geometry.dialog.right);
    }
    fs.writeFileSync(
      path.join(out, name + ".json"),
      JSON.stringify({ ...geometry, ...proof }, null, 2)
    );
    await renderedScreenshot(page, path.join(out, name + ".png"));
  }
  try {
    await installControlUiFixture(page, { ...f, app } as any);
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${target}`, exact: true }).click();
    const trigger = page.getByRole("button", { name: "Rerun this run", exact: true });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Rerun run?" });
    await expect(dialog).toContainText("1 run");
    await expect(dialog).toContainText("Other runs keep their results");
    for (const text of [
      "workloads",
      "startup.pf",
      "database seed",
      "original ID",
      "saved comparison",
      "inaccurate"
    ])
      await expect(dialog).toContainText(text);
    await expect(dialog).not.toContainText("entire experiment");
    await capture("confirmation");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(f.platform.repositories.getRun(target)?.state).toBe("FAILED");
    await trigger.click();
    await dialog.getByRole("button", { name: "Rerun this run", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("experiment_metrics_delete_failed");
    await capture("failure");
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "View failed cleanup", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toContainText("1 run");
    fail = false;
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Retry cleanup", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Cleanup in progress");
    await capture("pending");
    gate.resolve();
    await expect.poll(() => f.platform.repositories.getRun(target)?.state).toBe("QUEUED");
    expect(
      f.platform.repositories
        .listRuns(f.submitted.id)
        .slice(1)
        .map((r) => JSON.stringify(r))
    ).toEqual(siblings);
    expect(
      f.platform.repositories.listRuns(f.submitted.id).filter((r) => r.state === "QUEUED")
    ).toHaveLength(1);
  } finally {
    gate.resolve();
    await f.platform.experimentActions.idle();
    await app.close();
    f.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`individual-run scope, keyboard, failure and retry at ${width}`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 1000 });
    await verify(page, String(width));
  });
test("individual-run scope and conditional states at actual200 percent browser zoom", async () => {
  test.setTimeout(90000);
  await atBrowserZoom200((page, proof) => verify(page, "zoom200", proof));
});

async function edges(page: Page, tag: string, proof: any = {}) {
  const f = await actionFixture(),
    app = buildServer(f.platform),
    gate = deferred();
  f.terminal();
  const target = f.runIds[0],
    service = f.platform.experimentActions,
    original = service.runEligibility.bind(service);
  service.runEligibility = (id) => ({
    ...original(id),
    runName: "A long selected run name that wraps without clipping its action controls ".repeat(6)
  });
  service.submitRun = () => {
    throw Error("experiment_revision_stale");
  };
  const out = path.resolve(`.parkbench/validation/feature026/ui/individual/${tag}/edges`);
  fs.mkdirSync(out, { recursive: true });
  const capture = async (name: string) => {
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      buttons: Array.from(
        document.querySelectorAll(".experiment-actions button,dialog[open] button")
      )
        .filter((b) => (b as HTMLElement).offsetWidth > 0)
        .map((b) => b.getBoundingClientRect().toJSON())
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    for (const b of geometry.buttons) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(geometry.viewport + 1);
    }
    fs.writeFileSync(
      path.join(out, name + ".json"),
      JSON.stringify({ ...geometry, ...proof }, null, 2)
    );
    await renderedScreenshot(page, path.join(out, name + ".png"));
  };
  try {
    await installControlUiFixture(page, { ...f, app } as any);
    await page.route(`**/api/v1/runs/${target}/actions`, async (route) => {
      if (route.request().method() === "GET") await gate.promise;
      await route.fallback();
    });
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${target}`, exact: true }).click();
    const trigger = page.getByRole("button", { name: "Rerun this run", exact: true });
    await expect(trigger).toBeDisabled();
    await capture("loading");
    gate.resolve();
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByRole("dialog")).toContainText("Other runs keep their results");
    await capture("long-name");
    const confirm = page
      .getByRole("dialog")
      .getByRole("button", { name: "Rerun this run", exact: true });
    await confirm.click();
    await expect(page.getByRole("dialog")).toContainText("experiment changed");
    await expect(confirm).toBeDisabled();
    await capture("stale");
    expect(f.platform.repositories.getRun(target)!.state).toBe("FAILED");
  } finally {
    gate.resolve();
    await app.close();
    f.close();
  }
}
for (const width of [375, 768, 1280, 1440])
  test(`individual scope loading, wrapping and stale response at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await edges(page, String(width));
  });
test("individual scope edges at actual200 percent zoom", async () => {
  test.setTimeout(90000);
  await atBrowserZoom200((page, proof) => edges(page, "zoom200", proof));
});
