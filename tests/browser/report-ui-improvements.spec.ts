import { test, expect } from "@playwright/test";
import { reportRuntime } from "./report-runtime";

test("report views show compact sizes, percentages and a configurable grid with header methodology", async ({
  page
}) => {
  test.setTimeout(90000);
  const runtime = await reportRuntime(page);
  try {
    await page.goto(runtime.address + "/#reports/" + runtime.report.id);
    const view = page.getByLabel("Report view", { exact: true });
    await expect(view).toHaveValue("overview");
    await expect(page.locator("#dataset-table")).toHaveCount(0);
    const charts = page.locator(".report-chart");
    await expect(charts).toHaveCount(2);
    await expect(
      charts.first().getByRole("columnheader", { name: "Content size", exact: true })
    ).toBeVisible();
    await expect(charts.first().locator("tbody td").first()).toContainText(
      /\d+(\.\d{1,2})?[KMGTPEZY]?B/
    );
    await expect(charts.first().locator(".report-distribution").first()).toContainText(/%/);
    await expect(charts.first().locator("[title$=' bytes']").first()).toHaveAttribute(
      "title",
      /^\d+ bytes$/
    );
    await page.screenshot({ path: "/tmp/parkbench-report-overview-improved.png", fullPage: true });

    await view.selectOption("table");
    const table = page.locator("#dataset-table");
    await expect(page.getByRole("heading", { name: "Full report overview" })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: /^Time Stamp/ })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: /^DBUID/ })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: /^DB name/ })).toHaveCount(0);
    for (const name of [
      "Tenancy",
      "Tenancy #",
      "Partition Policy",
      "Partition",
      "Partition #",
      "Owner",
      "Table #",
      "Index #",
      "Area #"
    ]) {
      await expect(
        table.getByRole("button", { name: "Help for " + name, exact: true })
      ).toHaveCount(0);
    }
    const objectHeader = table.getByRole("columnheader", { name: /^Object \/ concern/ });
    await expect(objectHeader).toHaveCSS("position", "sticky");
    await expect(objectHeader.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
    const scrollContainer = table.locator(".MuiTableContainer-root");
    const beforeScroll = await objectHeader.boundingBox();
    await scrollContainer.evaluate((element) => (element.scrollLeft = element.scrollWidth));
    const afterScroll = await objectHeader.boundingBox();
    expect(Math.abs(afterScroll!.x - beforeScroll!.x)).toBeLessThan(2);
    await scrollContainer.evaluate((element) => (element.scrollLeft = 0));
    await expect(table.getByRole("button", { name: "Go to next page", exact: true })).toHaveCount(
      0
    );
    await expect(table.getByText("9007199254740993", { exact: true }).first()).toBeVisible();
    await expect(table.locator("tbody")).not.toContainText("Nonempty tables: review at");
    const help = table.getByRole("button", { name: "Help for Frag Factor [ratio]", exact: true });
    await help.scrollIntoViewIfNeeded();
    await help.hover();
    await expect(page.getByRole("tooltip")).toContainText("Nonempty tables: review at 1.5");
    await page.keyboard.press("Escape");
    await table.getByRole("button", { name: "Show/Hide columns", exact: true }).click();
    await expect(page.getByRole("menu")).toContainText("DBUID");
    await expect(
      page
        .getByRole("menu")
        .getByRole("checkbox", { name: "Toggle visibility Object / concern", exact: true })
    ).toBeDisabled();
    await page.getByRole("menu").getByText("DBUID", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(table.getByRole("columnheader", { name: /^DBUID/ })).toBeVisible();
    await expect(table.getByRole("button", { name: "Move", exact: true }).first()).toBeVisible();
    await table.getByRole("button", { name: "Show/Hide filters", exact: true }).click();
    const sizeFilter = table.getByRole("textbox", { name: "Filter by Size [bytes]", exact: true });
    await sizeFilter.scrollIntoViewIfNeeded();
    await sizeFilter.fill("9007199254740992");
    await expect(table.getByText(/showing 0 of 0 matching/)).toBeVisible();
    await sizeFilter.fill("9007199254740993");
    await expect(table.getByText(/showing 1 of 1 matching/)).toBeVisible();
    await sizeFilter.fill("");
    await table
      .getByRole("button", { name: "Sort by Size [bytes] ascending", exact: true })
      .click();
    await expect(table.getByRole("columnheader", { name: /^Size \[bytes\]/ })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
    await page.screenshot({ path: "/tmp/parkbench-report-grid-improved.png", fullPage: true });
    await table.getByLabel("Search table names").fill("absent");
    await expect(table.getByText(/showing 0 of 0 matching/)).toBeVisible();
    await view.selectOption("findings");
    await expect(page.getByRole("heading", { name: "Review findings", exact: true })).toBeVisible();
    await page
      .getByRole("link", { name: /Open source table row/ })
      .first()
      .click();
    await expect(view).toHaveValue("table");
    await expect(table.getByText("Source object filter active.", { exact: false })).toBeVisible();
    await page.reload();
    await expect(view).toHaveValue("table");
    await view.selectOption("index");
    await expect(
      page.locator("#dataset-index").getByRole("button", { name: "Help for Index #", exact: true })
    ).toHaveCount(0);
    await view.selectOption("files");
    await expect(
      page.getByRole("link", { name: "Download full dataset: table.csv", exact: true })
    ).toBeVisible();
    await expect(page.locator("#dataset-table")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/parkbench-report-ui-improved.png", fullPage: true });
  } finally {
    await runtime.close();
  }
});
