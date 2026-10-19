import { expect, test } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

test("disk catalog and Overview expose bulk actions without asset editing", async ({ page }) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#catalog");
    await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(4);
    await expect(page.getByRole("tab", { name: /Observers/ })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /Docker|Configurations/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Register|Verify|Build/ })).toHaveCount(0);
    await page.goto("/#");
    await expect(page.getByRole("button", { name: "Verify all scenarios" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compile all workloads" })).toBeVisible();
    await page.getByRole("textbox", { name: "Archive name" }).fill("browser-archive");
    await expect(page.getByRole("button", { name: "Rebuild archive" })).toBeEnabled();
  } finally {
    await fixture.close();
  }
});

test("disk scenario expands a 16-run matrix and queues named runs", async ({ page }) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
    await page.getByRole("textbox", { name: "Run name" }).fill("DB Cache");
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page.getByRole("combobox", { name: "Parameter 2 name" }).selectOption("-B2");
    await page.getByRole("textbox", { name: "Parameter 2 values" }).fill("500, 1000, 1500, 2000");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.getByText("Preview: 16 cells / 16 runs")).toBeVisible();
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    await expect(page.getByText("Experiment queued")).toBeVisible();
    const runs = fixture.platform.controlUi.listQueue();
    expect(runs).toHaveLength(16);
    expect(runs.every((run) => /^db-cache-\d+-[0-9a-f]{4}$/.test(run.id))).toBe(true);
    expect(runs.map((run) => Number(run.id.split("-").at(-2))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1)
    );
    await page.goto("/#queue");
    await expect(page.getByRole("heading", { name: "Run queue" })).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Nonterminal run activity" }).locator("tbody tr")
    ).toHaveCount(16);
  } finally {
    await fixture.close();
  }
});

test("completed runs leave Queue and remain reachable with a dashboard from History", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    const preview = fixture.platform.controlUi.preview({
      runName: "History Run",
      scenario: { id: "crud-rest", version: "1.0.0" },
      dimensions: [{ name: "-B", values: [500] }],
      repetitions: 1
    });
    const experiment = fixture.platform.controlUi.submit({
      previewId: preview.previewId,
      confirm: true
    });
    const run = fixture.platform.repositories.getRun(experiment.runs[0].id)!;
    run.state = "SUCCEEDED";
    run.measurementValidity = "VALID";
    run.cleanupStatus = "COMPLETE";
    run.finishedAt = new Date().toISOString();
    run.completeness = { complete: true, requiredGaps: [], optionalWarnings: [] };
    fixture.platform.repositories.saveRun(run);
    await page.goto("/#queue");
    await expect(
      page.getByRole("table", { name: "Nonterminal run activity" }).locator("tbody tr")
    ).toHaveCount(0);
    await page.goto("/#history");
    const row = page.locator("tbody tr").filter({ hasText: run.id });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: /Open dashboard/ })).toHaveAttribute(
      "href",
      /#dashboards\//
    );
  } finally {
    await fixture.close();
  }
});
