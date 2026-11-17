import { renderedScreenshot } from "./browser-zoom";
import { expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { actionFixture, deferred } from "../../fixtures/experiment-actions";
import { buildServer } from "../../../apps/control-plane/src/server";
import { installControlUiFixture } from "./control-ui-fixture";
export async function actionStates(page: Page, kind: "RERUN" | "REMOVE", tag: string) {
  const f = await actionFixture(),
    app = buildServer(f.platform),
    gate = deferred();
  f.terminal();
  let fail = true;
  const admin = f.platform.experimentActions.metricAdmin,
    remove = admin.delete.bind(admin);
  admin.delete = async (selectors) => {
    if (fail) throw Error("experiment_metrics_delete_failed");
    await gate.promise;
    await remove(selectors);
  };
  const out = path.resolve(
    `.parkbench/validation/feature026/ui/${kind === "RERUN" ? "rerun" : "removal"}/${tag}-states`
  );
  fs.mkdirSync(out, { recursive: true });
  try {
    await installControlUiFixture(page, { ...f, app } as any);
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${f.runIds[0]}`, exact: true }).click();
    const label = kind === "RERUN" ? "Rerun experiment" : "Remove experiment";
    await page.getByRole("button", { name: label, exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await expect(dialog).toContainText("Cleanup stopped");
    await expect(dialog).toContainText("experiment_metrics_delete_failed");
    await renderedScreenshot(page, path.join(out, "failure.png"));
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "View failed cleanup", exact: true }).click();
    dialog = page.getByRole("dialog");
    fail = false;
    await dialog.getByRole("button", { name: "Retry cleanup", exact: true }).click();
    await expect(dialog).toContainText("Cleanup in progress");
    await expect(dialog).toContainText("Closing this dialog does not cancel");
    const geometry = await dialog.evaluate((el) => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      buttons: Array.from(el.querySelectorAll("button")).map((b) =>
        b.getBoundingClientRect().toJSON()
      )
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await renderedScreenshot(page, path.join(out, "pending.png"));
    fs.writeFileSync(path.join(out, "geometry.json"), JSON.stringify(geometry, null, 2));
    gate.resolve();
    await f.platform.experimentActions.idle();
  } finally {
    gate.resolve();
    await f.platform.experimentActions.idle();
    await app.close();
    f.close();
  }
}
export async function confirmationEdgeStates(page: Page, kind: "RERUN" | "REMOVE", tag: string) {
  const f = await actionFixture(),
    app = buildServer(f.platform),
    gate = deferred();
  f.terminal();
  const service = f.platform.experimentActions,
    eligibility = service.eligibility.bind(service);
  service.eligibility = (id) => ({
    ...eligibility(id),
    experimentName:
      "A long experiment name with repeated words that should wrap without clipping adjacent controls ".repeat(
        5
      )
  });
  const out = path.resolve(
    `.parkbench/validation/feature026/ui/${kind === "RERUN" ? "rerun" : "removal"}/${tag}-edges`
  );
  fs.mkdirSync(out, { recursive: true });
  try {
    await installControlUiFixture(page, { ...f, app } as any);
    await page.route("**/api/v1/experiments/*/actions", async (route) => {
      if (route.request().method() === "GET") await gate.promise;
      await route.fallback();
    });
    await page.goto("/#history");
    await page.getByRole("button", { name: `Inspect ${f.runIds[0]}`, exact: true }).click();
    const label = kind === "RERUN" ? "Rerun experiment" : "Remove experiment",
      trigger = page.getByRole("button", { name: label, exact: true });
    await expect(page.getByText("Loading experiment actions…", { exact: true })).toBeVisible();
    await expect(trigger).toBeDisabled();
    await renderedScreenshot(page, path.join(out, "loading.png"));
    gate.resolve();
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("A long experiment name");
    await renderedScreenshot(page, path.join(out, "long-name.png"));
    service.repository.replaceRevision(f.submitted.id, "external-new-revision");
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await expect(dialog).toContainText("The experiment changed");
    await expect(dialog.getByRole("button", { name: label, exact: true })).toBeDisabled();
    const geometry = await dialog.evaluate((el) => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      dialog: el.getBoundingClientRect().toJSON(),
      buttons: Array.from(el.querySelectorAll("button")).map((b) =>
        b.getBoundingClientRect().toJSON()
      )
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await renderedScreenshot(page, path.join(out, "stale-revision.png"));
    fs.writeFileSync(path.join(out, "geometry.json"), JSON.stringify(geometry, null, 2));
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    expect(f.platform.repositories.getRun(f.runIds[0])?.state).toBe("FAILED");
    expect(service.repository.pending()).toHaveLength(0);
  } finally {
    gate.resolve();
    await app.close();
    f.close();
  }
}
