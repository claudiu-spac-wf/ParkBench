import { test, expect } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";
test("schedule edits ordered multi-target setup without adding matrix runs", async ({ page }) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await page.getByLabel("Setup operation", { exact: true }).selectOption("tablereorg");
    await page.getByRole("button", { name: "Add setup step", exact: true }).click();
    const step = page.locator(".database-setup-step").first();
    await step.getByLabel("Table", { exact: true }).fill("PUB.Customer");
    await step.getByLabel("Ordering index", { exact: true }).fill("CustNum");
    await step.getByRole("button", { name: "Add settings", exact: true }).click();
    const sets = step.locator(".database-setup-set");
    await expect(sets).toHaveCount(2);
    await sets.nth(1).getByLabel("Table", { exact: true }).fill("PUB.Order");
    await sets.nth(1).getByLabel("Ordering index", { exact: true }).fill("OrderNum");
    await sets.nth(1).getByRole("button", { name: "Move settings up", exact: true }).click();
    await expect(sets.first().getByLabel("Table", { exact: true })).toHaveValue("PUB.Order");
    await page.getByRole("textbox", { name: "Run name", exact: true }).fill("setup-matrix");
    await page.getByRole("button", { name: "Preview matrix", exact: true }).click();
    await expect(page.getByText(/Preview: 4 cells \/ 4 runs/)).toBeVisible();
    await expect(page.locator(".preview-panel")).toContainText("PUB.Order");
    await sets.first().getByLabel("Table", { exact: true }).fill("PUB.Updated");
    await expect(page.locator(".preview-panel")).toHaveCount(0);
    await sets.first().getByRole("button", { name: "Remove settings", exact: true }).click();
    await sets.first().getByRole("button", { name: "Remove settings", exact: true }).click();
    await expect(step).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
