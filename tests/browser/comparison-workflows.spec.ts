import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";

test("three simultaneous experiments preserve an explicit basket after filtering and deselection", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    const experiments = await Promise.all([
      seedTerminalMatrix(fixture),
      seedTerminalMatrix(fixture),
      seedTerminalMatrix(fixture)
    ]);
    await installControlUiFixture(page, fixture);
    await page.goto("/#comparison");
    await page
      .getByRole("listbox", { name: "Experiments" })
      .selectOption(experiments.map((e) => e.experimentId));
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByLabel("Baseline", { exact: true }).selectOption(experiments[0].runIds[0]);
    await page.getByLabel("Filter candidate runs").fill("no matching candidate");
    await page
      .getByRole("listbox", { name: "Experiments" })
      .selectOption([experiments[2].experimentId]);
    await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(
      experiments[0].runIds[0]
    );
    const response = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/comparisons")
    );
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    const saved = await (await response).json();
    expect(saved.totalSelectedRunCount).toBe(48);
    expect(
      new Set(fixture.platform.controlUi.getDashboard(saved.dashboardContextId)!.runIds)
    ).toEqual(new Set(experiments.flatMap((e) => e.runIds)));
  } finally {
    await fixture.close();
  }
});

test("mixed-experiment selection survives browsing and proceeds with only a scenario notice", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    const first = await seedTerminalMatrix(fixture);
    const second = await seedTerminalMatrix(fixture);
    const failed = fixture.platform.repositories.getRun(second.runIds[0])!;
    failed.state = "FAILED";
    failed.measurementValidity = "INCOMPLETE";
    fixture.platform.repositories.saveRun(failed);
    await installControlUiFixture(page, fixture);
    await page.route("**/api/v1/grafana/dashboards**", (route) =>
      route.fulfill({
        json: {
          dashboards: [
            { uid: "run-summary", title: "Run Summary", url: "http://localhost:3000/d/run-summary" }
          ]
        }
      })
    );
    await page.goto(`/#comparison/${first.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    const baseline = page.getByLabel("Baseline", { exact: true });
    await baseline.selectOption(first.runIds[0]);
    await page
      .getByRole("listbox", { name: "Experiments" })
      .selectOption([first.experimentId, second.experimentId]);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await expect(baseline).toHaveValue(first.runIds[0]);
    await expect(page.getByRole("checkbox", { name: new RegExp(second.runIds[0]) })).toBeEnabled();
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/api/v1/comparisons")
    );
    await page.getByRole("button", { name: "Create comparison" }).click();
    const saved = await (await createdResponse).json();
    expect(saved.totalSelectedRunCount).toBe(32);
    expect(saved.baselineRunId).toBe(first.runIds[0]);
    expect(saved.warnings).toEqual([]);
    const context = fixture.platform.controlUi.getDashboard(saved.dashboardContextId)!;
    expect(context.runIds).toHaveLength(32);
    expect(new Set(context.variables.experiment_id)).toEqual(
      new Set([first.experimentId, second.experimentId])
    );
    const other = fixture.platform.repositories.getRun(second.runIds.at(-1)!)!;
    other.environmentSnapshot = {
      ...other.environmentSnapshot,
      scenario: { id: "other", version: "1" }
    };
    fixture.platform.repositories.saveRun(other);
    await page.getByRole("button", { name: "Create comparison" }).click();
    await expect(
      page.getByText(
        "Selected runs use different scenarios. Interpret this comparison with that difference in mind."
      )
    ).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /different scenarios|comparison.*eligible|override/i })
    ).toHaveCount(0);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download comparison CSV" }).click()
    ]);
    expect(download.suggestedFilename()).toMatch(/^comparison-/);
    await expect(page.getByRole("link", { name: "Open dashboard" })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("unknown contextual experiment requires an explicit available selection", async ({ page }) => {
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ experiments: [{ id: "exp_known", status: "QUEUED", runs: [] }] })
    })
  );
  await page.goto("/#comparison/exp_missing");
  await expect(page.getByRole("alert")).toContainText("exp_missing");
  const experiment = page.getByRole("listbox", { name: "Experiments" });
  await expect(experiment).toHaveValues([]);
  await experiment.selectOption("exp_known");
  await expect(experiment).toHaveValues(["exp_known"]);
});

test("comparison identifies repeated experiment names by their numbered runs", async ({ page }) => {
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        experiments: [
          {
            id: "exp_first",
            name: "db-cache",
            status: "SUCCEEDED",
            runCount: 1,
            runs: [{ id: "run_first", name: "run_db-cache-1" }]
          },
          {
            id: "exp_second",
            name: "db-cache",
            status: "QUEUED",
            runCount: 2,
            runs: [
              { id: "run_second", name: "run_db-cache-2" },
              { id: "run_third", name: "run_db-cache-3" }
            ]
          },
          { id: "exp_legacy", status: "SUCCEEDED", runs: [] }
        ]
      })
    })
  );
  await page.route("**/api/v1/runs/*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: route.request().url().split("/").pop(),
        state: "QUEUED",
        measurementValidity: "PENDING"
      })
    })
  );
  await page.goto("/#comparison");
  const selector = page.getByRole("listbox", { name: "Experiments" });
  await expect(selector.getByRole("option", { name: /db-cache.*run_db-cache-1/ })).toHaveCount(1);
  await expect(selector.getByRole("option", { name: /db-cache.*run_db-cache-2.*\+1/ })).toHaveCount(
    1
  );
  await expect(selector.getByRole("option", { name: /exp_legacy/ })).toHaveCount(1);
  await selector.selectOption("exp_second");
  await expect(selector).toHaveValues(["exp_second"]);
});

test("late details from the previous experiment cannot replace current choices", async ({
  page
}) => {
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        experiments: [
          { id: "exp_old", status: "SUCCEEDED", runs: [{ id: "run_old" }] },
          { id: "exp_new", status: "SUCCEEDED", runs: [{ id: "run_new" }] }
        ]
      })
    })
  );
  let releaseOld = () => undefined;
  let oldRequested = false;
  const gate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route("**/api/v1/runs/run_old", async (route) => {
    oldRequested = true;
    await gate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_old",
        state: "SUCCEEDED",
        measurementValidity: "VALID",
        completeness: { complete: true, requiredGaps: [] }
      })
    });
  });
  await page.route("**/api/v1/runs/run_new", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_new",
        state: "SUCCEEDED",
        measurementValidity: "VALID",
        completeness: { complete: true, requiredGaps: [] }
      })
    })
  );
  await page.goto("/#comparison/exp_old");
  await expect.poll(() => oldRequested).toBe(true);
  await page.getByRole("listbox", { name: "Experiments" }).selectOption("exp_new");
  await expect(page.getByRole("option", { name: /run_new/ })).toBeEnabled();
  releaseOld();
  await expect(page.getByRole("option", { name: /run_old/ })).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "Experiments" })).toHaveValues(["exp_new"]);
});

test("comparison permits incomplete inspection, creates an exact baseline result, and downloads CSV", async ({
  page
}) => {
  const fixture = await createControlUiFixture();
  try {
    const seeded = await seedTerminalMatrix(fixture);
    const incompleteId = seeded.runIds[1];
    const incomplete = fixture.platform.repositories.getRun(incompleteId)!;
    incomplete.state = "INCOMPLETE";
    incomplete.measurementValidity = "INCOMPLETE";
    incomplete.completeness = {
      complete: false,
      requiredGaps: [
        { observerId: "workload", phase: "measurement", expected: 1, observed: 0, missing: 1 }
      ],
      optionalWarnings: []
    };
    fixture.platform.repositories.saveRun(incomplete);
    await installControlUiFixture(page, fixture);
    await page.goto(`/#comparison/${seeded.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    const baseline = page.getByLabel("Baseline", { exact: true });
    await expect(baseline.getByRole("option", { name: new RegExp(incompleteId) })).toBeEnabled();
    await baseline.selectOption(seeded.runIds[0]);
    await expect(page.getByRole("checkbox", { name: new RegExp(incompleteId) })).toBeEnabled();
    await page.getByRole("button", { name: "Create comparison" }).click();
    await expect(page.getByRole("cell", { name: "BASELINE", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open dashboard" })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download comparison CSV" }).click()
    ]);
    expect(download.suggestedFilename()).toMatch(/^comparison-cmp_[^/]+\.csv$/);
  } finally {
    await fixture.close();
  }
});

test("comparison keeps a usable variant when another run detail fails", async ({ page }) => {
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        experiments: [
          { id: "exp_partial", status: "SUCCEEDED", runs: [{ id: "run_good" }, { id: "run_bad" }] }
        ]
      })
    })
  );
  await page.route("**/api/v1/runs/run_good", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_good",
        state: "SUCCEEDED",
        measurementValidity: "VALID",
        completeness: { complete: true, requiredGaps: [] }
      })
    })
  );
  await page.route("**/api/v1/runs/run_bad", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "detail unavailable" } })
    })
  );
  await page.goto("/#comparison/exp_partial");
  await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
  await expect(page.getByText("Details unavailable: detail unavailable").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Selected runs (2)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create comparison", exact: true })).toBeEnabled();
  await expect(
    page.getByLabel("Baseline", { exact: true }).getByRole("option", { name: /run_good/ })
  ).toBeEnabled();
});

import { summaryHeader, summaryRow } from "../helpers/summary";
import { compareSummaryRow } from "../../apps/control-plane/src/comparisons/comparison-service";
for (const state of ["SUCCEEDED", "FAILED"])
  test(`numeric ${state} comparison retains values without table details or invalid numeric differences`, async ({
    page
  }) => {
    const h = summaryHeader("run_variant"),
      b = summaryHeader("run_base"),
      metric = summaryRow();
    metric.statistics.average.value = 3;
    const baseline = summaryRow();
    baseline.statistics.average.value = 0;
    h.run.state = state;
    const first = summaryRow("FirstTable");
    const cmp = {
      contractVersion: "comparison.v2",
      id: "cmp_numeric",
      baselineRunId: "run_base",
      selectionRevision: 1,
      totalSelectedRunCount: 2,
      selectionEndpoint: "/api/v1/comparisons/cmp_numeric/selection",
      selectionPage: {
        runIds: ["run_base", "run_variant"],
        returnedRunCount: 2,
        totalSelectedRunCount: 2,
        hasMore: false
      },
      createdAt: "now",
      page: { hasMore: false, returnedRunCount: 1, totalSelectedRunCount: 2 },
      runs: [
        {
          runId: "run_variant",
          name: "Variant numeric",
          role: "VARIANT",
          state,
          measurementValidity: "VALID",
          summary: { status: "READY", header: h, attemptToken: "saved-v1" },
          rows: [
            compareSummaryRow(metric, baseline, h, b, false),
            compareSummaryRow(first, first, h, b, false)
          ],
          tablePage: {
            hasMore: true,
            nextCursor: "table-next",
            returnedRowCount: 1,
            totalRowCount: 101
          },
          context: { cleanupStatus: "COMPLETE" }
        }
      ]
    };
    await page.route("**/api/v1/experiments", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          experiments: [
            {
              id: "exp_numeric",
              status: "SUCCEEDED",
              runs: [{ id: "run_base" }, { id: "run_variant" }]
            }
          ]
        })
      })
    );
    await page.route("**/api/v1/runs/*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: route.request().url().split("/").pop(),
          state: "SUCCEEDED",
          measurementValidity: "VALID"
        })
      })
    );
    await page.route("**/api/v1/comparisons", (route) => {
      const body = route.request().postDataJSON();
      expect(body.baselineRunId).toBe("run_base");
      expect(body.variantRunIds).toEqual(["run_variant"]);
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(cmp)
      });
    });
    let tableRequests = 0;
    await page.route("**/api/v1/comparisons/cmp_numeric/runs/run_variant/tables?**", (route) => {
      tableRequests++;
      return route.fulfill({ status: 500, json: { error: "table fetch is outside this view" } });
    });
    await page.goto("/#comparison/exp_numeric");
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByLabel("Baseline", { exact: true }).selectOption("run_base");
    await page.getByRole("button", { name: "Create comparison" }).click();
    await page.locator('details[data-run-id="run_variant"] > summary').click();
    await expect(page.getByText("3 bytes", { exact: true })).toBeVisible();
    await expect(page.getByText("Difference: 3 bytes", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Difference unavailable: zero baseline", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("All measured tables (101 metric rows)", { exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /tables/ })).toHaveCount(0);
    await expect(page.locator("[data-tone]")).toHaveCount(0);
    expect(tableRequests).toBe(0);
    await expect(page.getByRole("link", { name: "Download comparison CSV" })).toHaveAttribute(
      "href",
      "/api/v1/comparisons/cmp_numeric/export"
    );
  });

test("selection revision restart and baseline changes retain every selected ID beyond the displayed pages", async ({
  page
}) => {
  const ids = Array.from({ length: 120 }, (_, i) => `run-${i}`);
  let revision = 1,
    posts = 0,
    firstBaseline = ids[0];
  const result = () => ({
    contractVersion: "comparison.v2",
    id: "cmp-pages",
    baselineRunId: firstBaseline,
    selectionRevision: revision,
    totalSelectedRunCount: 120,
    selectionEndpoint: "/api/v1/comparisons/cmp-pages/selection",
    selectionPage: {
      runIds: ids.slice(0, 100),
      hasMore: true,
      nextCursor: `selection-${revision}`,
      returnedRunCount: 100,
      totalSelectedRunCount: 120
    },
    createdAt: "now",
    runs: [],
    page: { hasMore: false, returnedRunCount: 0, totalSelectedRunCount: 120 }
  });
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      json: {
        experiments: [{ id: "exp-pages", status: "SUCCEEDED", runs: ids.map((id) => ({ id })) }]
      }
    })
  );
  await page.route("**/api/v1/runs/*", (route) =>
    route.fulfill({
      json: {
        id: route.request().url().split("/").pop(),
        state: "SUCCEEDED",
        measurementValidity: "VALID"
      }
    })
  );
  await page.route("**/api/v1/comparisons", (route) => {
    const body = route.request().postDataJSON();
    firstBaseline = body.baselineRunId;
    expect(new Set(body.variantRunIds)).toEqual(new Set(ids.filter((id) => id !== firstBaseline)));
    posts++;
    return route.fulfill({ status: 201, json: result() });
  });
  await page.route("**/api/v1/comparisons/cmp-pages/selection?**", (route) => {
    revision = 2;
    return route.fulfill({
      status: 400,
      json: {
        error: {
          code: "comparison_selection_cursor_stale",
          message: "comparison_selection_cursor_stale"
        }
      }
    });
  });
  await page.route("**/api/v1/comparisons/cmp-pages", (route) => route.fulfill({ json: result() }));
  await page.goto("/#comparison/exp-pages");
  await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
  await page.getByLabel("Baseline", { exact: true }).selectOption(ids[0]);
  await page.getByRole("button", { name: "Create comparison" }).click();
  await page.getByText("Selected run IDs", { exact: true }).click();
  await page.getByRole("button", { name: "Next selected runs" }).click();
  await expect(page.getByText(/Baseline: run-0. Selected runs: 120/)).toBeVisible();
  await page.getByLabel("Baseline", { exact: true }).selectOption(ids[119]);
  await page.getByRole("button", { name: "Create comparison" }).click();
  await expect(page.getByText(/Baseline: run-119. Selected runs: 120/)).toBeVisible();
  expect(posts).toBe(2);
});

test("pending saved summaries poll to READY without changing the saved comparison selection", async ({
  page
}) => {
  let polls = 0;
  const cmp = {
    contractVersion: "comparison.v2",
    id: "cmp-pending",
    selectionRevision: 1,
    totalSelectedRunCount: 1,
    selectionPage: { runIds: ["run-pending"], hasMore: false },
    createdAt: "now",
    retryAfterSeconds: 2,
    runs: [
      {
        runId: "run-pending",
        role: "VARIANT",
        state: "FAILED",
        measurementValidity: "UNAVAILABLE",
        summary: { status: "RECOMPUTING" },
        rows: [],
        tablePage: { totalRowCount: 0 }
      }
    ],
    page: { hasMore: false }
  };
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      json: {
        experiments: [{ id: "exp-pending", status: "FAILED", runs: [{ id: "run-pending" }] }]
      }
    })
  );
  await page.route("**/api/v1/runs/run-pending", (route) =>
    route.fulfill({
      json: { id: "run-pending", state: "FAILED", measurementValidity: "UNAVAILABLE" }
    })
  );
  await page.route("**/api/v1/comparisons", (route) => route.fulfill({ status: 201, json: cmp }));
  await page.route("**/api/v1/comparisons/cmp-pending", (route) => {
    polls++;
    return route.fulfill({
      json: {
        ...cmp,
        retryAfterSeconds: undefined,
        runs: [{ ...cmp.runs[0], summary: { status: "READY" } }]
      }
    });
  });
  await page.goto("/#comparison/exp-pending");
  await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
  await page.getByRole("button", { name: "Create comparison" }).click();
  await expect(page.getByRole("cell", { name: "RECOMPUTING", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "READY", exact: true })).toBeVisible({
    timeout: 10000
  });
  expect(polls).toBe(1);
  await expect(page.getByRole("link", { name: "Download comparison CSV" })).toHaveAttribute(
    "href",
    "/api/v1/comparisons/cmp-pending/export"
  );
});

test("saved route restores 130 exact IDs after a revision restart without selecting candidates", async ({
  page
}) => {
  const ids = Array.from({ length: 130 }, (_, i) => `saved-${i}`);
  let revision = 1,
    restarted = false,
    posts = 0;
  const result = () => ({
    id: "cmp-saved",
    selectionRevision: revision,
    baselineRunId: ids[129],
    totalSelectedRunCount: 130,
    runs: [],
    page: { hasMore: false },
    selectionPage: { runIds: ids.slice(0, 5), hasMore: true, nextCursor: "header-page" }
  });
  await page.route("**/api/v1/experiments", (r) =>
    r.fulfill({
      json: {
        experiments: [{ id: "exp-saved", status: "FAILED", runs: ids.map((id) => ({ id })) }]
      }
    })
  );
  await page.route("**/api/v1/runs/*", (r) =>
    r.fulfill({
      json: {
        id: r.request().url().split("/").pop(),
        state: "FAILED",
        measurementValidity: "INCOMPLETE",
        experimentId: "exp-saved"
      }
    })
  );
  await page.route("**/api/v1/comparisons/cmp-saved", (r) => r.fulfill({ json: result() }));
  await page.route("**/api/v1/comparisons/cmp-saved/selection?**", (r) => {
    const cursor = new URL(r.request().url()).searchParams.get("cursor");
    if (cursor && !restarted) {
      restarted = true;
      revision = 2;
      return r.fulfill({
        status: 400,
        json: { error: { code: "comparison_selection_cursor_stale" } }
      });
    }
    return r.fulfill({
      json: {
        selectionRevision: revision,
        selectionPage: {
          runIds: cursor ? ids.slice(100) : ids.slice(0, 100),
          hasMore: !cursor,
          nextCursor: cursor ? undefined : "last"
        }
      }
    });
  });
  await page.route("**/api/v1/comparisons", (r) => {
    const body = r.request().postDataJSON();
    expect(body.baselineRunId).toBe(ids[129]);
    expect(body.variantRunIds).toEqual(ids.slice(0, 129));
    posts++;
    return r.fulfill({ status: 201, json: result() });
  });
  await page.goto("/#comparison?comparisonId=cmp-saved");
  await expect(
    page.getByRole("heading", { name: "Selected runs (130)", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Experiments" })).toHaveValues([]);
  await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(ids[129]);
  await page.getByRole("button", { name: "Create comparison", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  expect(restarted).toBe(true);
  await expect(page.getByRole("link", { name: "Reopen saved comparison" })).toHaveAttribute(
    "href",
    "#comparison?comparisonId=cmp-saved"
  );
  await expect(page.getByRole("link", { name: "Download comparison CSV" })).toHaveAttribute(
    "href",
    "/api/v1/comparisons/cmp-saved/export"
  );
});

test("delayed saved restoration guards every basket mutation until all pages arrive", async ({
  page
}) => {
  const ids = Array.from({ length: 130 }, (_, i) => `guard-${i}`);
  let release = () => {};
  let waiting = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = {
    id: "cmp-guard",
    selectionRevision: 1,
    baselineRunId: ids[129],
    totalSelectedRunCount: 130,
    runs: [],
    page: { hasMore: false },
    selectionPage: { runIds: ids.slice(0, 5), hasMore: true }
  };
  await page.route("**/api/v1/experiments", (r) =>
    r.fulfill({ json: { experiments: [{ id: "exp-guard", runs: ids.map((id) => ({ id })) }] } })
  );
  await page.route("**/api/v1/runs/*", (r) =>
    r.fulfill({
      json: {
        id: r.request().url().split("/").pop(),
        experimentId: "exp-guard",
        state: "FAILED",
        measurementValidity: "INCOMPLETE"
      }
    })
  );
  await page.route("**/api/v1/comparisons/cmp-guard", (r) => r.fulfill({ json: result }));
  await page.route("**/api/v1/comparisons/cmp-guard/selection?**", async (r) => {
    const cursor = new URL(r.request().url()).searchParams.get("cursor");
    if (cursor) {
      waiting = true;
      await gate;
    }
    await r.fulfill({
      json: {
        selectionRevision: 1,
        selectionPage: {
          runIds: cursor ? ids.slice(100) : ids.slice(0, 100),
          hasMore: !cursor,
          nextCursor: cursor ? undefined : "last"
        }
      }
    });
  });
  await page.goto("/#comparison/exp-guard");
  await page.getByRole("checkbox", { name: new RegExp(ids[0] + " —") }).check();
  await page.evaluate(() => {
    window.location.hash = "comparison?comparisonId=cmp-guard";
  });
  await expect.poll(() => waiting).toBe(true);
  await page.getByRole("listbox", { name: "Experiments" }).selectOption("exp-guard");
  const controls = [
    page.getByRole("button", { name: "Select all candidates", exact: true }),
    page.getByLabel("Baseline", { exact: true }),
    page.getByRole("checkbox", { name: new RegExp(ids[1] + " —") }),
    page.getByRole("button", { name: `Remove ${ids[0]}`, exact: true })
  ];
  try {
    for (const control of controls) {
      await expect(control).toBeDisabled();
      await control.evaluate((element: HTMLElement) => element.click());
    }
    await expect(
      page.getByRole("heading", { name: "Selected runs (1)", exact: true })
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(
    page.getByRole("heading", { name: "Selected runs (130)", exact: true })
  ).toBeVisible();
  await expect(page.getByLabel("Baseline", { exact: true })).toHaveValue(ids[129]);
  await page.getByRole("button", { name: `Remove ${ids[0]}`, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Selected runs (129)", exact: true })
  ).toBeVisible();
});

// Seven selected runs exercise real five-run result paging without a benchmark workload.
async function installPresentationFixture(page: Page) {
  const ids = Array.from({ length: 7 }, (_, index) => `presentation-${index}`);
  const requests: string[] = [];
  const state = {
    baselineStatus: "READY",
    baselineAttempt: "baseline-v1",
    failBaseline: false,
    changeBetweenReads: false,
    holdBaseline: undefined as Promise<void> | undefined,
    percent: 25,
    variantState: "SUCCEEDED",
    incomplete: false,
    missing: false,
    zeroBaseline: false
  };
  let metadataReads = 0;
  const descriptors: Array<[string, string, string, Record<string, string>?]> = [
    ["platform", "cpu.usage", "Platform CPU"],
    ["platform", "memory.used", "Platform memory"],
    ["database", "cpu.usage", "Database CPU"],
    ["database", "memory.used", "Database memory"],
    ["database", "disk.read.operations", "Disk reads"],
    ["database", "disk.write.operations", "Disk writes"],
    ["pas", "cpu.usage", "PAS CPU"],
    ["database", "db.records.read", "Record reads"],
    ["database", "db.records.write", "Record writes"],
    ["database", "db.buffer.logical.read", "Logical reads", { pool: "primary" }],
    ["database", "db.buffer.logical.write", "Logical writes", { pool: "alternate" }],
    ["database", "db.blocks.read", "Physical reads"],
    ["database", "db.blocks.write", "Physical writes"],
    ["platform", "network.receive", "Excluded network"],
    ["pas", "memory.used", "Excluded PAS memory"],
    ["database", "disk.read.bytes", "Excluded disk bytes"],
    ["database", "db.records.create", "Excluded record creates"],
    ["database", "db.table.read", "Excluded table reads", { table: "customer" }]
  ];
  const row = (descriptor: (typeof descriptors)[number], value: number) => {
    const [group, definitionId, displayName, dimensions = {}] = descriptor;
    const base = summaryRow();
    const unit =
      definitionId === "cpu.usage"
        ? "percent_one_core"
        : definitionId === "memory.used"
          ? "bytes"
          : definitionId.includes("blocks")
            ? "blocks_per_second"
            : definitionId.startsWith("disk.") || definitionId.includes("buffer.logical")
              ? "operations_per_second"
              : "records_per_second";
    const totalUnit = definitionId.startsWith("db.")
      ? definitionId.includes("blocks")
        ? "blocks"
        : definitionId.includes("buffer.logical")
          ? "operations"
          : "records"
      : null;
    return {
      ...base,
      group,
      definitionId,
      displayName,
      dimensions,
      rowKey: JSON.stringify([group, definitionId, dimensions]),
      rateOrLevelUnit: unit,
      totalUnit,
      statistics: {
        ...Object.fromEntries(
          Object.entries(base.statistics).map(([key, stat]: [string, any]) => [
            key,
            {
              ...stat,
              unit,
              value: state.missing ? null : value,
              status: state.missing ? "unavailable" : "available",
              reasons: state.missing ? ["unsupported_metric"] : []
            }
          ])
        ),
        ...(totalUnit
          ? {
              total: {
                ...base.statistics.average,
                unit: totalUnit,
                value: state.missing ? null : value * 10,
                status: state.missing ? "unavailable" : "available",
                reasons: state.missing ? ["unsupported_metric"] : []
              }
            }
          : {})
      }
    };
  };
  const run = (id: string) => {
    const header = summaryHeader(id),
      baselineHeader = summaryHeader(ids[0]);
    header.quality.complete = !state.incomplete;
    return {
      runId: id,
      name: `Readable ${id}`,
      experimentId: "exp-presentation",
      role: id === ids[0] ? "BASELINE" : "VARIANT",
      state: id === ids[0] ? "SUCCEEDED" : state.variantState,
      measurementValidity: "VALID",
      summary: {
        status: id === ids[0] ? state.baselineStatus : "READY",
        header,
        attemptToken: id === ids[0] ? state.baselineAttempt : `saved-${id}`,
        artifactId: "summary.json"
      },
      rows: descriptors.map((descriptor) => {
        const compared = compareSummaryRow(
          row(descriptor, 100 + state.percent),
          row(descriptor, state.zeroBaseline ? 0 : 100),
          header,
          baselineHeader,
          id === ids[0]
        );
        // Explicit fixture percentages test presentation of exact server halfway values,
        // rather than floating-point subtraction in the comparison builder.
        if (id !== ids[0] && !state.zeroBaseline && !state.missing)
          for (const difference of Object.values(compared.differences))
            if (difference && !difference.reason) difference.percentageDifference = state.percent;
        return compared;
      }),
      tablePage: { hasMore: true, totalRowCount: 100, returnedRowCount: 1, nextCursor: "excluded" },
      context: { cleanupStatus: "COMPLETE" }
    };
  };
  const result = (cursor?: string, limit?: number) => {
    const selected = cursor ? ids.slice(5) : ids.slice(0, limit ?? 5);
    return {
      contractVersion: "comparison.v2",
      id: "cmp-presentation",
      baselineRunId: ids[0],
      selectionRevision: 1,
      totalSelectedRunCount: ids.length,
      createdAt: "now",
      warnings: [],
      selectionPage: {
        runIds: ids,
        hasMore: false,
        returnedRunCount: ids.length,
        totalSelectedRunCount: ids.length
      },
      runs: selected.map(run),
      page: {
        hasMore: !cursor && limit !== 1,
        nextCursor: !cursor ? "second" : undefined,
        returnedRunCount: selected.length,
        totalSelectedRunCount: ids.length
      },
      retryAfterSeconds: state.baselineStatus === "RECOMPUTING" ? 2 : undefined
    };
  };
  const snapshot = (index: number) => {
    if (index === 1)
      return {
        requestedConfiguration: {
          parameters: {},
          databaseStartup: {
            contractVersion: "db-startup-parameters.v1",
            databaseName: "metadata",
            parameters: []
          }
        }
      };
    if (index === 2) return { requestedConfiguration: { parameters: { retained: "scheduled" } } };
    if (index === 3)
      return { variant: { parameters: { historical: "saved" } }, databaseStartup: {} };
    if (index === 6)
      return {
        requestedConfiguration: { parameters: {} },
        variant: { parameters: { newer: "must not appear" } }
      };
    return {
      requestedConfiguration: {
        parameters: { "-B": "1000", same: "value", zero: 0, flag: false, blank: "" },
        databaseStartup: {
          contractVersion: "db-startup-parameters.v1",
          databaseName: "metadata",
          parameters: [
            { name: "-B", displayValue: "2000", observedValue: "9999" },
            { name: "same", displayValue: "value" }
          ]
        }
      }
    };
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/experiments")
      return route.fulfill({
        json: {
          experiments: [
            { id: "exp-presentation", status: "SUCCEEDED", runs: ids.map((id) => ({ id })) }
          ]
        }
      });
    if (url.pathname.startsWith("/api/v1/runs/")) {
      const id = url.pathname.split("/").pop()!,
        index = ids.indexOf(id);
      if (index === 5)
        return route.fulfill({
          status: 503,
          json: { error: { message: "retained detail unavailable" } }
        });
      return route.fulfill({
        json: {
          id,
          state: "SUCCEEDED",
          measurementValidity: "VALID",
          environmentSnapshot: snapshot(index)
        }
      });
    }
    if (url.pathname === "/api/v1/comparisons" && route.request().method() === "POST")
      return route.fulfill({ status: 201, json: result() });
    if (url.pathname === "/api/v1/comparisons/cmp-presentation") {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      requests.push(limit === 1 ? "baseline" : (cursor ?? "first"));
      if (limit === 1) {
        metadataReads++;
        if (state.holdBaseline) await state.holdBaseline;
        if (state.failBaseline)
          return route.fulfill({ status: 503, json: { error: { message: "quality offline" } } });
        if (state.changeBetweenReads && metadataReads % 2 === 0)
          state.baselineAttempt += "-changed";
      }
      return route.fulfill({ json: result(cursor, limit) });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: "unexpected fixture request" } }
    });
  });
  await page.goto("/#comparison/exp-presentation");
  await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
  await page.getByLabel("Baseline", { exact: true }).selectOption(ids[0]);
  await page.getByRole("button", { name: "Create comparison", exact: true }).click();
  return { ids, state, requests, result };
}

test("feature020 paged runs start collapsed and display only requested measurements and saved Parameters", async ({
  page
}) => {
  const { ids, requests } = await installPresentationFixture(page);
  const sections = page.locator("details[data-run-id]");
  await expect(sections).toHaveCount(5);
  expect(
    await sections.evaluateAll((items) => items.every((item) => !(item as HTMLDetailsElement).open))
  ).toBe(true);
  expect(
    await sections.evaluateAll((items) => items.map((item) => item.getAttribute("data-run-id")))
  ).toEqual(ids.slice(0, 5));
  const baseline = sections.first();
  await baseline.locator("summary").first().click();
  await expect(baseline).toContainText("BASELINE");
  for (const name of [
    "Platform CPU",
    "Platform memory",
    "Database CPU",
    "Database memory",
    "Disk reads",
    "Disk writes",
    "PAS CPU",
    "Record reads",
    "Record writes",
    "Logical reads",
    "Logical writes",
    "Physical reads",
    "Physical writes"
  ])
    await expect(baseline.getByRole("rowheader", { name: new RegExp(name) })).toBeVisible();
  await expect(baseline.getByRole("rowheader", { name: /Excluded/ })).toHaveCount(0);
  await expect(baseline.getByRole("button", { name: /tables/ })).toHaveCount(0);
  const parameters = baseline.getByRole("region", { name: `Parameters for ${ids[0]}` });
  await expect(parameters).toContainText("1000");
  await expect(parameters).toContainText("2000");
  await expect(parameters).toContainText("Ordinary parameters");
  await expect(parameters).toContainText("Database startup");
  await expect(parameters).toContainText("false");
  await expect(parameters).not.toContainText("9999");
  await expect(parameters).not.toContainText("db-startup-parameters.v1");
  const none = sections.nth(1);
  await none.locator("summary").first().click();
  await expect(none.getByRole("region", { name: `Parameters for ${ids[1]}` })).toContainText(
    "None set"
  );
  const partial = sections.nth(2);
  await partial.locator("summary").first().click();
  await expect(partial.getByRole("region", { name: `Parameters for ${ids[2]}` })).toContainText(
    "scheduled"
  );
  await expect(partial.getByRole("region", { name: `Parameters for ${ids[2]}` })).toContainText(
    /unavailable/i
  );
  const historic = sections.nth(3);
  await historic.locator("summary").first().click();
  await expect(historic.getByRole("region", { name: `Parameters for ${ids[3]}` })).toContainText(
    "historical"
  );
  expect(requests).toEqual([]); // Expanding a run is purely local.
  await page.getByRole("button", { name: "Next runs", exact: true }).click();
  await expect(sections).toHaveCount(2);
  expect(
    await sections.evaluateAll((items) => items.map((item) => item.getAttribute("data-run-id")))
  ).toEqual(ids.slice(5));
  expect(
    await sections.evaluateAll((items) => items.every((item) => !(item as HTMLDetailsElement).open))
  ).toBe(true);
  await sections.first().locator("summary").first().click();
  await expect(
    sections.first().getByRole("region", { name: `Parameters for ${ids[5]}` })
  ).toContainText(/unavailable/i);
  await expect(sections.first().getByRole("rowheader", { name: /Record reads/ })).toBeVisible();
  await sections.last().locator("summary").first().click();
  await expect(
    sections.last().getByRole("region", { name: `Parameters for ${ids[6]}` })
  ).not.toContainText("must not appear");
  await page.getByRole("button", { name: "Previous runs", exact: true }).click();
  await expect(sections).toHaveCount(5);
  expect(
    await sections.evaluateAll((items) => items.every((item) => !(item as HTMLDetailsElement).open))
  ).toBe(true);
});

test("feature020 badges preserve signs, precision and metric-specific improvement colors", async ({
  page
}) => {
  const { state } = await installPresentationFixture(page);
  const variant = page.locator('details[data-run-id="presentation-1"]');
  await variant.locator("summary").first().click();
  const recordBadge = variant
    .getByRole("row", { name: /Record reads/ })
    .locator("[data-tone]")
    .first();
  const resourceBadge = variant
    .getByRole("row", { name: /Platform CPU/ })
    .locator("[data-tone]")
    .first();
  await expect(recordBadge).toHaveText("↑ +25.00%");
  await expect(recordBadge).toHaveAttribute("data-tone", "improvement");
  const recordTotal = variant
    .getByRole("row", { name: /Record reads/ })
    .getByRole("cell")
    .last();
  await expect(recordTotal.locator("strong")).toHaveText("1,250 records");
  await expect(recordTotal.locator("[data-tone]")).toHaveText("↑ +25.00%");
  await expect(resourceBadge).toHaveAttribute("data-tone", "deterioration");
  const evidence = path.resolve(".parkbench/validation/feature020/comparison-ui");
  fs.mkdirSync(evidence, { recursive: true });
  await variant.screenshot({ path: path.join(evidence, "baseline-badges-and-parameters.png") });
  for (const [percent, text, tone] of [
    [0.004, "↑ +<0.01%", "improvement"],
    [-0.004, "↓ -<0.01%", "deterioration"],
    [0.01, "↑ +0.01%", "improvement"],
    [-0.01, "↓ -0.01%", "deterioration"],
    [1.235, "↑ +1.24%", "improvement"],
    [-1.235, "↓ -1.24%", "deterioration"],
    [0, "↔ 0%", "neutral"]
  ] as const) {
    state.percent = percent;
    await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
    await expect(recordBadge).toHaveText(text);
    await expect(recordBadge).toHaveAttribute("data-tone", tone);
    await expect(variant).toHaveAttribute("open", ""); // Same-page refresh retains disclosure state.
  }
});

test("quality warnings retain numeric badges while invalid numeric pairs withhold them", async ({
  page
}) => {
  const { state } = await installPresentationFixture(page);
  const variant = page.locator('details[data-run-id="presentation-1"]');
  await variant.locator("summary").first().click();
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  for (const setting of ["variantState", "incomplete", "zeroBaseline", "missing"] as const) {
    state.variantState = setting === "variantState" ? "FAILED" : "SUCCEEDED";
    state.incomplete = setting === "incomplete";
    state.zeroBaseline = setting === "zeroBaseline";
    state.missing = setting === "missing";
    await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Refresh comparison", exact: true })
    ).toBeEnabled();
    if (setting === "variantState" || setting === "incomplete") {
      await expect(variant.locator("[data-tone]").first()).toBeVisible();
      await expect(variant.locator(".comparison-warning").first()).toBeVisible();
      await expect(variant.getByText(/Difference unavailable/)).toHaveCount(0);
    } else {
      await expect(variant.locator("[data-tone]")).toHaveCount(0);
      await expect(variant.getByText(/Difference unavailable/).first()).toBeVisible();
    }
    if (!state.missing)
      await expect(variant.getByText("125 records/s", { exact: true }).first()).toBeVisible();
    else await expect(variant.getByText("unsupported_metric").first()).toBeVisible();
  }
});

test("feature020 off-page quality brackets results, suppresses loading/errors/changes and recovers", async ({
  page
}) => {
  const { state, requests } = await installPresentationFixture(page);
  await page.getByRole("button", { name: "Next runs", exact: true }).click();
  await expect(page.locator("details[data-run-id]")).toHaveCount(2);
  expect(requests).toEqual(["baseline", "second", "baseline"]);
  const variant = page.locator('details[data-run-id="presentation-6"]');
  await variant.locator("summary").first().click();
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  // Basket edits do not reinterpret saved results using a different baseline.
  await page.getByLabel("Baseline", { exact: true }).selectOption("presentation-6");
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  let release = () => {};
  state.holdBaseline = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(variant.locator("[data-tone]")).toHaveCount(0);
  await expect(variant.getByText("125 records/s", { exact: true }).first()).toBeVisible();
  release();
  state.holdBaseline = undefined;
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  state.failBaseline = true;
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh comparison", exact: true })).toBeEnabled();
  await expect(variant.locator("[data-tone]")).toHaveCount(0);
  await expect(variant.getByText(/Difference unavailable.*quality offline/).first()).toBeVisible();
  await expect(variant.getByText("125 records/s", { exact: true }).first()).toBeVisible();
  state.failBaseline = false;
  state.changeBetweenReads = true;
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(
    variant.getByText(/Difference unavailable.*changed while loading/).first()
  ).toBeVisible();
  await expect(variant.locator("[data-tone]")).toHaveCount(0);
  state.changeBetweenReads = false;
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  expect(requests.length % 3).toBe(0);
});

test("feature020 off-page recomputing baseline polls even when variants are ready", async ({
  page
}) => {
  const { state, requests } = await installPresentationFixture(page);
  state.baselineStatus = "RECOMPUTING";
  await page.getByRole("button", { name: "Next runs", exact: true }).click();
  const variant = page.locator('details[data-run-id="presentation-6"]');
  await variant.locator("summary").first().click();
  await expect(variant.locator("[data-tone]")).toHaveCount(0);
  await expect(variant.getByText(/Difference unavailable.*recomputing/).first()).toBeVisible();
  expect(requests).toEqual(["baseline", "second", "baseline"]);
  state.baselineStatus = "READY";
  await expect(variant.locator("[data-tone]").first()).toBeVisible({ timeout: 10000 });
  expect(requests).toEqual(["baseline", "second", "baseline", "baseline", "second", "baseline"]);
  await expect(variant).toHaveAttribute("open", "");
});

test("feature020 late result refresh cannot replace a newly created comparison page", async ({
  page
}) => {
  const { state, result, requests } = await installPresentationFixture(page);
  await page.getByRole("button", { name: "Next runs", exact: true }).click();
  await expect(page.locator("details[data-run-id]")).toHaveCount(2);
  const oldResult = result("second");
  let release = () => {};
  let waiting = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/comparisons/cmp-presentation?cursor=second", async (route) => {
    waiting = true;
    await gate;
    await route.fulfill({ json: oldResult });
  });
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect.poll(() => waiting).toBe(true);
  state.percent = 75;
  await page.getByRole("button", { name: "Create comparison", exact: true }).click();
  await expect(page.locator("details[data-run-id]")).toHaveCount(5);
  const variant = page.locator('details[data-run-id="presentation-1"]');
  await variant.locator("summary").first().click();
  await expect(variant.locator("[data-tone]").first()).toHaveText("↑ +75.00%");
  const response = page.waitForResponse(
    (item) => new URL(item.url()).searchParams.get("cursor") === "second"
  );
  release();
  await response;
  await expect(page.locator("details[data-run-id]")).toHaveCount(5);
  await expect(variant.locator("[data-tone]").first()).toHaveText("↑ +75.00%");
  // Superseded requested-page response must not dispatch its baseline-after read.
  expect(requests).toEqual(["baseline", "second", "baseline", "baseline"]);
});

test("feature020 requested-page refresh errors keep values and offer a retry with unavailable quality", async ({
  page
}) => {
  await installPresentationFixture(page);
  await page.getByRole("button", { name: "Next runs", exact: true }).click();
  const variant = page.locator('details[data-run-id="presentation-6"]');
  await variant.locator("summary").first().click();
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  let fail = true;
  await page.route("**/api/v1/comparisons/cmp-presentation?cursor=second", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: { message: "requested page offline" } } })
      : route.fallback()
  );
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("requested page offline");
  await expect(variant.locator("[data-tone]")).toHaveCount(0);
  await expect(
    variant.getByText(/Difference unavailable.*refresh unavailable/).first()
  ).toBeVisible();
  await expect(variant.getByText("125 records/s", { exact: true }).first()).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry comparison", exact: true }).click();
  await expect(variant.locator("[data-tone]").first()).toBeVisible();
  await expect(variant).toHaveAttribute("open", "");
});

test("feature020 failed saved-route restoration retries the new route instead of the old comparison", async ({
  page
}) => {
  const { ids, requests, result } = await installPresentationFixture(page);
  let fail = true,
    reads = 0;
  await page.route("**/api/v1/comparisons/cmp-new", (route) => {
    reads++;
    return route.fulfill(
      fail
        ? { status: 503, json: { error: { message: "new saved result unavailable" } } }
        : { json: { ...result(), id: "cmp-new" } }
    );
  });
  await page.route("**/api/v1/comparisons/cmp-new/selection?**", (route) =>
    route.fulfill({
      json: {
        id: "cmp-new",
        selectionRevision: 1,
        selectionPage: {
          runIds: ids,
          hasMore: false,
          returnedRunCount: ids.length,
          totalSelectedRunCount: ids.length
        }
      }
    })
  );
  await page.evaluate(() => {
    window.location.hash = "comparison?comparisonId=cmp-new";
  });
  await expect(page.getByRole("alert")).toContainText("new saved result unavailable");
  await expect(page.locator("details[data-run-id]")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry comparison", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Reopen saved comparison", exact: true })
  ).toHaveAttribute("href", "#comparison?comparisonId=cmp-new");
  await expect(page.locator("details[data-run-id]")).toHaveCount(5);
  expect(reads).toBe(2);
  expect(requests).toEqual([]);
});

for (const stale of [false, true])
  test(`feature020 late selected-ID page ${stale ? "error" : "response"} cannot restore an older comparison`, async ({
    page
  }) => {
    const { result } = await installPresentationFixture(page);
    let release = () => {},
      waiting = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    await page.route("**/api/v1/comparisons", (route) => {
      posts++;
      const comparison = result();
      if (posts === 1)
        comparison.selectionPage = {
          ...comparison.selectionPage,
          hasMore: true,
          nextCursor: "old-selected-page"
        } as any;
      else comparison.id = "cmp-replacement";
      return route.fulfill({ status: 201, json: comparison });
    });
    await page.route("**/api/v1/comparisons/cmp-presentation/selection?**", async (route) => {
      waiting = true;
      await gate;
      await route.fulfill(
        stale
          ? { status: 400, json: { error: { code: "comparison_selection_cursor_stale" } } }
          : {
              json: {
                selectionRevision: 1,
                selectionPage: { runIds: ["old-id-must-not-appear"], hasMore: false }
              }
            }
      );
    });
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.getByText("Selected run IDs", { exact: true }).click();
    await page.getByRole("button", { name: "Next selected runs", exact: true }).click();
    await expect.poll(() => waiting).toBe(true);
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Reopen saved comparison", exact: true })
    ).toHaveAttribute("href", "#comparison?comparisonId=cmp-replacement");
    const response = page.waitForResponse((item) => item.url().includes("/selection?"));
    release();
    await response;
    await expect(
      page.getByRole("link", { name: "Reopen saved comparison", exact: true })
    ).toHaveAttribute("href", "#comparison?comparisonId=cmp-replacement");
    await expect(page.getByText("old-id-must-not-appear", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh comparison", exact: true })
    ).toBeEnabled();
  });

test("100 to 120 shows an orange baseline warning alongside +20% without changing failed-run inspection", async ({
  page
}) => {
  const { state } = await installPresentationFixture(page);
  state.percent = 20;
  state.incomplete = true;
  state.variantState = "FAILED";
  await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  const run = page.locator('details[data-run-id="presentation-1"]');
  await run.locator("summary").first().click();
  await expect(run.locator("[data-tone]").first()).toHaveText("↑ +20.00%");
  const warning = run.getByText(/Warning: Baseline measurements are incomplete/).first();
  await expect(warning).toBeVisible();
  await expect(warning).toHaveCSS("color", "rgb(180, 83, 9)");
  await expect(run.locator("summary").first()).toContainText("FAILED");
  await expect(run.getByText(/Difference unavailable/)).toHaveCount(0);
  const root = path.join(process.cwd(), ".parkbench/validation/feature021/p3");
  fs.mkdirSync(root, { recursive: true });
  await run.screenshot({ path: path.join(root, "orange-warning-and-percentage.png") });
});

test("selected metrics keep +20% and orange warnings; empty selection and defaults preserve the comparison", async ({
  page
}) => {
  const { selectionIdentity } =
    await import("../../packages/contracts/src/comparison-metric-selection");
  const { state } = await installPresentationFixture(page);
  await page.route("**/api/v1/comparisons/*/metric-values", async (route) => {
    const request = route.request().postDataJSON();
    const rows = request.runIds.map((runId: string) => ({
      rowId: runId + "-selected",
      runId,
      runState: "FAILED",
      measurementValidity: "INCOMPLETE",
      metricId: "resource.database.memory.used",
      descriptorVersion: 1,
      statistic: "average",
      unit: "bytes",
      dimensions: {},
      value: 120,
      availability: "partial",
      reasons: [],
      sourceReferences: [{ source: "saved_summary" }],
      sourceIdentity: "published",
      warnings: ["Baseline measurements are incomplete or ineligible for comparison."],
      baseline: {
        runId: "presentation-0",
        value: 100,
        availability: "partial",
        sourceIdentity: "baseline-published"
      },
      difference: { value: 120, baseline: 100, absoluteDifference: 20, percentageDifference: 20 }
    }));
    await route.fulfill({
      json: {
        contractVersion: "comparison-metric-selection.v1",
        comparisonId: "cmp-presentation",
        selectionRevision: request.selectionRevision,
        selectionIdentity: selectionIdentity(request.metrics),
        sourceIdentity: "stable",
        rows,
        returnedRowCount: rows.length,
        hasMore: false
      }
    });
  });
  const comparisonLink = await page
    .getByRole("link", { name: "Download comparison CSV" })
    .getAttribute("href");
  await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
  await page.getByRole("button", { name: "Clear metrics", exact: true }).click();
  await expect(
    page.getByText("No metrics selected. Choose metrics or restore defaults.", { exact: true })
  ).toBeVisible();
  await page.getByLabel("Database · Used memory", { exact: true }).check();
  const run = page.locator('details[data-run-id="presentation-1"]');
  await run.locator("summary").first().click();
  await expect(run.locator("[data-tone]")).toHaveText("↑ +20.00%");
  await expect(run.locator(".comparison-warning")).toContainText(
    "Warning: Baseline measurements are incomplete"
  );
  await expect(run.getByText(/Difference unavailable/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download comparison CSV" })).toHaveAttribute(
    "href",
    comparisonLink!
  );
  await page.getByRole("button", { name: "Restore default metrics", exact: true }).click();
  await expect(run.getByRole("region", { name: "Resources for presentation-1" })).toBeVisible();
});
