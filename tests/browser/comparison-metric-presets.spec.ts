import { test, expect } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";
test("three metric presets reuse explicitly after reload in a different comparison", async ({
  page
}) => {
  const f = await createControlUiFixture();
  try {
    const a = await seedTerminalMatrix(f),
      b = await seedTerminalMatrix(f);
    await installControlUiFixture(page, f);
    await page.goto(`/#comparison/${a.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
    await page.getByRole("button", { name: "Clear metrics", exact: true }).click();
    for (const label of [
      "Database · Used memory",
      "Workload · Completed requests",
      "Named latches · Wait naps"
    ])
      await page.getByLabel(label, { exact: true }).check();
    await page.getByLabel("Preset name", { exact: true }).fill("Three metrics");
    await page.getByRole("button", { name: "Save new preset", exact: true }).click();
    await page.getByRole("link", { name: "Reopen saved comparison" }).click();
    await page.reload();
    await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
    await expect(page.getByLabel("Named latches · Wait naps", { exact: true })).not.toBeChecked();
    await page.goto(`/#comparison/${b.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
    await page
      .getByLabel("Saved metric presets", { exact: true })
      .selectOption({ label: "Three metrics" });
    await page.getByRole("button", { name: "Apply preset", exact: true }).click();
    await expect(page.getByText("3 selected metrics", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restore default metrics", exact: true }).click();
    await page.getByRole("button", { name: "Delete preset", exact: true }).click();
    await expect(page.getByRole("option", { name: "Three metrics", exact: true })).toHaveCount(0);
  } finally {
    await f.close();
  }
});

async function openPicker(page: any, f: any) {
  const seeded = await seedTerminalMatrix(f);
  await installControlUiFixture(page, f);
  await page.goto(`/#comparison/${seeded.experimentId}`);
  await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
  await page.getByRole("button", { name: "Create comparison", exact: true }).click();
  await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
}
test("removing stale preset choices preserves overlapping ids and same-id semantic choices without saving", async ({
  page
}) => {
  const f = await createControlUiFixture();
  try {
    await page.addInitScript(() => {
      const now = "2026-10-01T00:00:00Z";
      const selections = [
        { metricId: "resource.platform.cpu.usage", statistics: ["average"], selectors: {} },
        { metricId: "resource.platform.cpu.usage.future", statistics: ["value"], selectors: {} },
        { metricId: "resource.platform.cpu.usage", statistics: ["value"], selectors: {} },
        {
          metricId: "database.db.table.read",
          statistics: ["average"],
          selectors: { table: "Customer" }
        },
        { metricId: "database.db.table.read", statistics: ["value"], selectors: { table: "Order" } }
      ];
      const preset = {
        id: "stale",
        name: "Mixed stale choices",
        revision: "one",
        createdAt: now,
        updatedAt: now,
        catalogVersion: "comparison-metrics.v1",
        descriptorVersions: {},
        selections
      };
      localStorage.setItem(
        "parkbench.comparisonMetricPresets.v1",
        JSON.stringify({
          schemaVersion: 1,
          presets: [preset, { ...preset, id: "unrelated", name: "Unrelated preset" }]
        })
      );
    });
    await openPicker(page, f);
    const stored = await page.evaluate(() =>
      localStorage.getItem("parkbench.comparisonMetricPresets.v1")
    );
    await page
      .getByLabel("Saved metric presets", { exact: true })
      .selectOption({ label: "Mixed stale choices" });
    await page.getByRole("button", { name: "Apply preset", exact: true }).click();
    await expect(page.getByText("5 selected metrics", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove unavailable choice", exact: true })
    ).toHaveCount(3);
    for (const remaining of [4, 3, 2]) {
      await page
        .getByRole("button", { name: "Remove unavailable choice", exact: true })
        .first()
        .click();
      await expect(page.getByText(`${remaining} selected metrics`, { exact: true })).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "Remove unavailable choice", exact: true })
    ).toHaveCount(0);
    await expect(page.getByLabel("Platform · CPU usage", { exact: true })).toBeChecked();
    await expect(page.locator('input[value="Customer"]')).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("parkbench.comparisonMetricPresets.v1"))
    ).toBe(stored);
  } finally {
    await f.close();
  }
});
for (const mode of ["quota", "denied", "corrupt"] as const)
  test(`preset ${mode} storage leaves unsaved selections usable`, async ({ page }) => {
    const f = await createControlUiFixture();
    try {
      await page.addInitScript((mode) => {
        if (mode === "corrupt")
          localStorage.setItem("parkbench.comparisonMetricPresets.v1", "{invalid");
        else if (mode === "denied")
          Object.defineProperty(window, "localStorage", {
            get() {
              throw new Error("Denied");
            }
          });
        else
          Storage.prototype.setItem = function () {
            throw new DOMException("Full", "QuotaExceededError");
          };
      }, mode);
      await openPicker(page, f);
      await page.getByRole("button", { name: "Clear metrics", exact: true }).click();
      await page.getByLabel("Workload · Completed requests", { exact: true }).check();
      await page.getByLabel("Preset name", { exact: true }).fill("Keep selection");
      await page.getByRole("button", { name: "Save new preset", exact: true }).click();
      await expect(
        page.getByText(/storage.*(unavailable|corrupt|full)|Could not save browser presets/i).last()
      ).toBeVisible();
      await expect(page.getByText("1 selected metrics", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Workload · Completed requests", { exact: true })).toBeChecked();
      if (mode === "corrupt")
        expect(
          await page.evaluate(() => localStorage.getItem("parkbench.comparisonMetricPresets.v1"))
        ).toBe("{invalid");
    } finally {
      await f.close();
    }
  });
test("cross-tab preset edits require an explicit retry and refresh only the preset list", async ({
  page
}) => {
  const f = await createControlUiFixture();
  try {
    await openPicker(page, f);
    await page.getByRole("button", { name: "Clear metrics", exact: true }).click();
    await page.getByLabel("Workload · Completed requests", { exact: true }).check();
    await page.getByLabel("Preset name", { exact: true }).fill("Concurrent");
    await page.getByRole("button", { name: "Save new preset", exact: true }).click();
    await page.evaluate(() => {
      const key = "parkbench.comparisonMetricPresets.v1",
        oldValue = localStorage.getItem(key)!;
      const e = JSON.parse(oldValue);
      e.presets[0].revision = "changed-in-other-tab";
      e.presets.push({ ...e.presets[0], id: "other", name: "Unrelated" });
      const newValue = JSON.stringify(e);
      localStorage.setItem(key, newValue);
      window.dispatchEvent(
        new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage })
      );
    });
    await expect(page.getByRole("option", { name: "Unrelated", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Replace preset", exact: true }).click();
    await expect(page.getByText(/Preset conflict/)).toBeVisible();
    await expect(page.getByText("1 selected metrics", { exact: true })).toBeVisible();
    await page
      .getByLabel("Saved metric presets", { exact: true })
      .selectOption({ label: "Unrelated" });
    await page
      .getByLabel("Saved metric presets", { exact: true })
      .selectOption({ label: "Concurrent" });
    await page.getByRole("button", { name: "Replace preset", exact: true }).click();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("parkbench.comparisonMetricPresets.v1")!).presets.length
      )
    ).toBe(2);
  } finally {
    await f.close();
  }
});
test("stale metric ids and isolated invalid records remain visible without fabricating values", async ({
  page
}) => {
  const f = await createControlUiFixture();
  try {
    await page.addInitScript(() =>
      localStorage.setItem(
        "parkbench.comparisonMetricPresets.v1",
        JSON.stringify({
          schemaVersion: 1,
          presets: [
            {
              id: "future",
              name: "Future metrics",
              revision: "one",
              createdAt: "2026-10-01T00:00:00Z",
              updatedAt: "2026-10-01T00:00:00Z",
              catalogVersion: "future.v2",
              descriptorVersions: { "unknown.future": 1 },
              selections: [{ metricId: "unknown.future", statistics: ["value"], selectors: {} }]
            },
            { invalid: true }
          ]
        })
      )
    );
    await openPicker(page, f);
    await expect(page.getByText(/1 invalid preset record/)).toBeVisible();
    await page
      .getByLabel("Saved metric presets", { exact: true })
      .selectOption({ label: "Future metrics" });
    await page.getByRole("button", { name: "Apply preset", exact: true }).click();
    await expect(page.getByText(/Recorded choice unavailable: unknown.future/)).toBeVisible();
    await expect(page.getByText("1 selected metrics", { exact: true })).toBeVisible();
  } finally {
    await f.close();
  }
});

test("a 256-entry preset traverses every definition batch and explicit row page", async ({
  page
}) => {
  const { selectionIdentity } =
    await import("../../packages/contracts/src/comparison-metric-selection");
  const f = await createControlUiFixture();
  let calls = 0;
  try {
    await page.addInitScript(() => {
      const now = "2026-10-01T00:00:00Z";
      localStorage.setItem(
        "parkbench.comparisonMetricPresets.v1",
        JSON.stringify({
          schemaVersion: 1,
          presets: [
            {
              id: "large",
              name: "256 tables",
              revision: "initial",
              createdAt: now,
              updatedAt: now,
              catalogVersion: "comparison-metrics.v1",
              descriptorVersions: { "database.db.table.read": 1 },
              selections: Array.from({ length: 256 }, (_, i) => ({
                metricId: "database.db.table.read",
                statistics: ["average"],
                selectors: { table: `table-${i}` }
              }))
            }
          ]
        })
      );
    });
    await openPicker(page, f);
    // This synthetic large-selection fixture has stable published inputs, not an active summary recomputation.
    await page.route("**/api/v1/comparisons/*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const url = new URL(route.request().url());
      const response = await f.app.inject({ method: "GET", url: url.pathname + url.search });
      const body = response.json();
      delete body.retryAfterSeconds;
      await route.fulfill({ status: response.statusCode, json: body });
    });
    await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Refresh comparison", exact: true })
    ).toBeEnabled();
    await page.route("**/api/v1/comparisons/*/metric-values", async (route) => {
      calls++;
      const r = route.request().postDataJSON(),
        runId = r.runIds[0],
        second = !!r.cursor,
        metrics = r.metrics.slice(second ? 16 : 0, second ? 32 : 16);
      const rows = metrics.map((m: any) => ({
        rowId: m.selectors.table,
        runId,
        runState: "SUCCEEDED",
        measurementValidity: "VALID",
        metricId: m.metricId,
        descriptorVersion: 1,
        statistic: "average",
        unit: "records_per_second",
        dimensions: m.selectors,
        value: 1,
        availability: "available",
        reasons: [],
        sourceReferences: [],
        sourceIdentity: "saved-attempt",
        warnings: [],
        difference: {
          value: 1,
          baseline: null,
          absoluteDifference: null,
          percentageDifference: null,
          reason: "baseline_unavailable"
        }
      }));
      await route.fulfill({
        json: {
          contractVersion: "comparison-metric-selection.v1",
          comparisonId: new URL(route.request().url()).pathname.split("/")[4],
          selectionRevision: r.selectionRevision,
          selectionIdentity: selectionIdentity(r.metrics),
          sourceIdentity: "all-published-attempts",
          rows,
          returnedRowCount: rows.length,
          hasMore: !second,
          ...(!second ? { nextCursor: "next-page" } : {})
        }
      });
    });
    await page
      .getByLabel("Saved metric presets", { exact: true })
      .selectOption({ label: "256 tables" });
    await page.getByRole("button", { name: "Apply preset", exact: true }).click();
    await expect(page.getByText("256 selected metrics", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Load more selected measurements", exact: true })
    ).toBeEnabled();
    expect(calls).toBe(8);
    await page
      .getByRole("button", { name: "Load more selected measurements", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Load more selected measurements", exact: true })
    ).toHaveCount(0);
    expect(calls).toBe(16);
    const first = page.locator("details.comparison-run").first();
    await first.locator("summary").first().click();
    await expect(
      first.getByRole("region", { name: /Selected metrics for/ }).locator("tbody tr")
    ).toHaveCount(256);
  } finally {
    await f.close();
  }
});
