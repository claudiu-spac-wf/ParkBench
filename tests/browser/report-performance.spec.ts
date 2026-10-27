import { test, expect } from "@playwright/test";
import { reportRuntime } from "./report-runtime";
test("10k real-query retained report meets initial usability and p95 interaction budgets", async ({
  page
}) => {
  test.setTimeout(120000);
  const runtime = await reportRuntime(page, true);
  let rowRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/datasets/table/rows")) rowRequests++;
  });
  try {
    const started = Date.now();
    await page.goto(runtime.address + "/#reports/" + runtime.report.id);
    await expect(page.getByRole("heading", { name: "Full report overview" })).toBeVisible({
      timeout: 5000
    });
    const firstMs = Date.now() - started;
    const gridStarted = Date.now();
    await page.getByLabel("Report view", { exact: true }).selectOption("table");
    const table = page.locator("#dataset-table");
    await expect(table.getByText(/of 10000 matching rows/)).toBeVisible({ timeout: 5000 });
    expect(firstMs).toBeLessThanOrEqual(5000);
    const firstBatchMs = Date.now() - gridStarted;
    await expect(table.getByText(/showing 10000 of 10000 matching rows/)).toBeVisible({
      timeout: 60000
    });
    const allRowsMs = Date.now() - gridStarted;
    const loadedRequests = rowRequests;
    console.log("REPORT_ALL_ROWS_LOADED_MS", allRowsMs);
    await expect(table.getByRole("button", { name: "Go to next page", exact: true })).toHaveCount(
      0
    );
    await expect(table.getByRole("combobox", { name: "Rows per page", exact: true })).toHaveCount(
      0
    );
    // All rows are loaded, while only the visible rows occupy DOM nodes.
    expect(await table.locator("tbody tr").count()).toBeLessThan(100);
    const container = table.locator(".MuiTableContainer-root");
    await container.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await expect(table.getByText("Table_09999", { exact: false }).first()).toBeVisible();
    await container.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/parkbench-report-scrolling-grid.png" });
    await container.evaluate((element) => (element.scrollTop = 0));
    await expect(table.getByText("Table_00000", { exact: false }).first()).toBeVisible();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const begin = Date.now();
      await table.getByLabel("Search table names").fill(i % 2 ? "Table_099" : "Table_0");
      await expect(
        table.getByText(i % 2 ? /of 100 matching rows/ : /of 10000 matching rows/)
      ).toBeVisible({ timeout: 2000 });
      times.push(Date.now() - begin);
    }
    times.sort((a, b) => a - b);
    expect(rowRequests).toBe(loadedRequests);
    expect(times[18]).toBeLessThanOrEqual(2000);
    console.log(
      "REPORT_BROWSER_PERFORMANCE",
      JSON.stringify({
        rows: 10000,
        firstMs,
        firstBatchMs,
        allRowsMs,
        p95InteractionMs: times[18],
        queryTransport: "real Fastify/SQLite loading, then shared exact local queries"
      })
    );
  } finally {
    await runtime.close();
  }
});
