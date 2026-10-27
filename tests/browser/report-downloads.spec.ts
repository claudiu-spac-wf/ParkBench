import { test, expect } from "@playwright/test";
import { reportRuntime } from "./report-runtime";
test("full unit-bearing CSV stays downloadable after filtering and per-file errors leave other files reachable", async ({
  page
}) => {
  const runtime = await reportRuntime(page);
  try {
    await page.goto(runtime.address + "/#reports/" + runtime.report.id);
    await page.getByLabel("Report view", { exact: true }).selectOption("table");
    const table = page.locator("#dataset-table");
    await table.getByLabel("Search table names").fill("absent");
    await expect(table.getByText(/showing 0 of 0 matching/)).toBeVisible();
    await page.getByLabel("Report view", { exact: true }).selectOption("files");
    const link = page.getByRole("link", { name: "Download full dataset: table.csv", exact: true });
    const downloadPromise = page.waitForEvent("download");
    await link.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("table.csv");
    const stream = await download.createReadStream();
    let csv = "";
    for await (const chunk of stream!) csv += chunk;
    expect(csv).toContain('"Size [bytes]"');
    expect(csv).toContain('"9007199254740993"');
    expect(csv).toContain('"Customer"');
    await page.route(
      "**/api/v1/reports/*/artifacts/" +
        runtime.report.artifacts.find((a) => a.filename === "table.csv").id,
      (route) =>
        route.fulfill({ status: 410, json: { error: { code: "report_artifact_unavailable" } } })
    );
    await link.click();
    await expect(page.getByRole("alert")).toContainText("missing");
    await expect(
      page.getByRole("link", { name: "Download full dataset: index.csv", exact: true })
    ).toBeVisible();
  } finally {
    await runtime.close();
  }
});
