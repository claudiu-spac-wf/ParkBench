import { test, expect } from "@playwright/test";
import { reportDefinitions } from "../../packages/contracts/src/database-analysis-definitions";
test("guide explains scopes, exact units, concern limits and cleanup", async ({ page }) => {
  await page.route("**/api/v1/reports/definitions*", (r) =>
    r.fulfill({ json: reportDefinitions() })
  );
  await page.goto("/#reports/help");
  await expect(page.getByRole("heading", { name: "Database analysis guide" })).toBeVisible();
  await expect(page.getByText(/no automatic time limit/i)).toBeVisible();
  await expect(page.getByText(/five seconds after each failed attempt/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Metric reference" })).toBeVisible();
  await expect(page.getByText("Size", { exact: true })).toBeVisible();
});
