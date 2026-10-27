import { test, expect } from "@playwright/test";
import { reportRuntime } from "./report-runtime";
test("real retained results show exact values and textual concerns with whole-report chart scope", async ({
  page
}) => {
  test.setTimeout(60000);
  const runtime = await reportRuntime(page);
  try {
    await page.goto(runtime.address + "/#reports/" + runtime.report.id);
    await expect(page.getByRole("heading", { name: "Full report overview" })).toBeVisible();
    await page.getByLabel("Report view", { exact: true }).selectOption("table");
    const table = page.locator("#dataset-table");
    await expect(table.getByText("9007199254740993", { exact: true }).first()).toBeVisible();
    await expect(
      table.locator("tbody").getByText("Higher concern", { exact: false }).first()
    ).toBeVisible();
    await table.getByLabel("Search table names").fill("absent");
    await expect(table.getByText(/showing 0 of 0 matching/)).toBeVisible();
    await page.getByLabel("Report view", { exact: true }).selectOption("overview");
    await expect(page.getByText(/Full report: DBANALYS/)).toBeVisible();
    await page.getByLabel("Report view", { exact: true }).selectOption("table");
    await table.getByLabel("Search table names").fill("Customer");
    await expect(table.getByText(/showing 1 of 1 matching/)).toBeVisible();
    await table.getByRole("button", { name: "Help for Frag Factor [ratio]", exact: true }).focus();
    await expect(page.getByRole("tooltip")).toContainText("fragmentation");
    await page.screenshot({ path: "/tmp/parkbench-report-results.png", fullPage: true });
  } finally {
    await runtime.close();
  }
});

test("scope, concern explanation and source download walkthrough stays under five minutes", async ({
  page
}) => {
  const runtime = await reportRuntime(page);
  try {
    const started = Date.now();
    await page.goto(runtime.address + "/#reports/" + runtime.report.id);
    await expect(page.getByText(/Full report: DBANALYS/)).toBeVisible();
    await page.getByLabel("Report view", { exact: true }).selectOption("findings");
    await expect(
      page.getByRole("heading", { name: "Higher concern: index-utilization" })
    ).toBeVisible();
    await page.getByRole("link", { name: "Report guide", exact: true }).click();
    await expect(page.getByText(/IDXANALYS includes index and block data/)).toBeVisible();
    await expect(page.getByText(/ParkBench heuristic/).first()).toBeVisible();
    await page.goBack();
    await page.getByLabel("Report view", { exact: true }).selectOption("files");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download full dataset: index.csv", exact: true }).click();
    expect((await download).suggestedFilename()).toContain("index.csv");
    expect(Date.now() - started).toBeLessThan(300000);
    console.log("REPORT_OPERATOR_WALKTHROUGH_MS", Date.now() - started);
  } finally {
    await runtime.close();
  }
});
