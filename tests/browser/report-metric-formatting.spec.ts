import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { reportRuntime } from "./report-runtime";

test("plain metric headers, padded index numbers and concern-only cells stay consistent across datasets", async ({
  page
}) => {
  test.setTimeout(60000);
  const runtime = await reportRuntime(page, false, (h) => {
    const execute = h.runner.execute.bind(h.runner);
    h.runner.execute = async (...args: any[]) => {
      const result = await execute(...args);
      const replaceRows = (file: string, changes: Record<string, string>[]) => {
        const target = path.join(args[1].directory, "raw", file);
        const [header, original] = fs.readFileSync(target, "utf8").trim().split(/\r?\n/);
        const headers = header.split(",");
        const rows = changes.map((values) => {
          const cells = original.split(",");
          for (const [name, value] of Object.entries(values)) cells[headers.indexOf(name)] = value;
          return cells.join(",");
        });
        fs.writeFileSync(target, header + "\r\n" + rows.join("\r\n") + "\r\n");
      };
      replaceRows("report.ix.txt", [
        { Index: "Balanced", Utilization: "   56.5", Factor: "   1.0", Size: "123", Blocks: "100" },
        {
          Index: "ReviewIndex",
          Utilization: "   24.5",
          Factor: "   1.0",
          Size: "100",
          Blocks: "100"
        },
        { Index: "SmallIndex", Utilization: "   2.0", Factor: "   1.0", Size: "3", Blocks: "1" }
      ]);
      replaceRows("report.tab.txt", [
        { Table: "Normal", Records: "1000", "Frag Factor": "1.0", "Scatter Factor": "1.0" },
        { Table: "ReviewTable", Records: "1000", "Frag Factor": "1.5", "Scatter Factor": "2.0" },
        { Table: "Empty", Records: "0", "Frag Factor": "2.0", "Scatter Factor": "2.0" }
      ]);
      return result;
    };
  });
  try {
    await page.goto(runtime.address + "/#reports/" + runtime.report.id + "?view=index");
    const view = page.getByLabel("Report view", { exact: true });
    const index = page.locator("#dataset-index");
    await expect(index.getByText(/showing 3 of 3 matching/)).toBeVisible();
    await expect(index.locator("tbody")).not.toContainText("Unavailable: invalid measurement");
    await expect(index.getByText("56.5%", { exact: true })).toBeVisible();
    await expect(index.getByText("123b", { exact: true })).toBeVisible();
    await expect(
      index.getByRole("button", { name: "Help for Partition Type", exact: true })
    ).toHaveCount(0);
    await index.getByLabel("Search index names").fill("Balanced");
    await expect(index.getByText(/showing 1 of 1 matching/)).toBeVisible();
    await expect(index.locator("tbody .report-concern")).toHaveCount(0);
    await index.getByLabel("Search index names").fill("SmallIndex");
    await expect(index.getByText(/showing 1 of 1 matching/)).toBeVisible();
    await expect(index.locator("tbody .report-concern")).toHaveCount(0);
    await index.getByLabel("Search index names").fill("ReviewIndex");
    await expect(index.locator("tbody").getByText("Higher concern", { exact: true })).toHaveCount(
      2
    );
    await view.selectOption("table");
    const table = page.locator("#dataset-table");
    for (const name of ["Normal", "Empty"]) {
      await table.getByLabel("Search table names").fill(name);
      await expect(table.getByText(/showing 1 of 1 matching/)).toBeVisible();
      await expect(table.locator("tbody .report-concern")).toHaveCount(0);
    }
    await table.getByLabel("Search table names").fill("ReviewTable");
    await expect(table.locator("tbody").getByText("Review", { exact: true })).toHaveCount(1);
    await expect(table.locator("tbody").getByText("Higher concern", { exact: true })).toHaveCount(
      2
    );
    for (const kind of ["chain", "block", "index", "table", "lob"]) {
      await view.selectOption(kind);
      const dataset = page.locator("#dataset-" + kind);
      await expect(
        dataset.getByRole("heading", { name: kind + " dataset", exact: true })
      ).toBeVisible();
      const labels = await dataset.locator("thead .report-column-label").allTextContents();
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((label) => !/\[[^\]]+\]/.test(label))).toBe(true);
      await expect(dataset.locator("tbody")).not.toContainText(/Neutral|Not assessed/i);
    }
    await view.selectOption("index");
    await expect(index.getByText(/showing 3 of 3 matching/)).toBeVisible();
    await page
      .locator("#dataset-index .MuiTableContainer-root")
      .evaluate((element) => (element.scrollLeft = element.scrollWidth));
    await page.screenshot({ path: "/tmp/parkbench-report-clean-metrics.png", fullPage: true });
  } finally {
    await runtime.close();
  }
});
