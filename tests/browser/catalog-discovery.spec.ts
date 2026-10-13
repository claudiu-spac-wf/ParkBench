import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("Catalog shows five disk categories and one entry per JSON path", async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-browser-catalog-"));
  const scenarios = path.join(root, "scenarios");
  fs.mkdirSync(scenarios);
  fs.writeFileSync(path.join(scenarios, "one.json"), JSON.stringify(scenario));
  fs.writeFileSync(path.join(scenarios, "README.md"), "ignored");
  const fixture = await createControlUiFixture({ discoveryRoots: { scenarios } });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#catalog");
    await expect(page.getByRole("tab")).toHaveCount(5);
    await expect(page.getByRole("tab", { name: /Docker|Configurations/ })).toHaveCount(0);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr")).toContainText("one.json");
    await expect(page.getByRole("button", { name: /Register|Verify|Build/ })).toHaveCount(0);
    fs.rmSync(path.join(scenarios, "one.json"));
    await page.getByRole("button", { name: "Refresh files" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(0);
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Overview verify-all reports each scenario result and Catalog shows latest status", async ({
  page
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-browser-verify-"));
  const scenarios = path.join(root, "scenarios");
  fs.mkdirSync(scenarios);
  fs.writeFileSync(path.join(scenarios, "valid.json"), JSON.stringify(scenario));
  fs.writeFileSync(path.join(scenarios, "broken.json"), "{");
  const fixture = await createControlUiFixture({ discoveryRoots: { scenarios } });
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#");
    await page.getByRole("button", { name: "Verify all scenarios" }).click();
    const action = page.getByRole("region", { name: "Bulk catalog actions" }).getByRole("status");
    await expect(action).toContainText("PARTIAL");
    await expect(action).toContainText("valid.json: PASSED");
    await expect(action).toContainText("broken.json: FAILED");
    await page.goto("/#catalog");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator("tbody tr").filter({ hasText: "broken.json" })).toContainText(
      "FAILED"
    );
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
