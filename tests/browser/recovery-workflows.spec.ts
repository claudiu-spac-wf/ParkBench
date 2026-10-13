import { expect, test } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { BrowserControlUiFixture, installControlUiFixture } from "./support/control-ui-fixture";
import { seedTerminalMatrix } from "./support/control-ui-fixture";

let fixture: BrowserControlUiFixture;

test.beforeEach(async ({ page }) => {
  fixture = await createControlUiFixture();
  await installControlUiFixture(page, fixture);
});

test.afterEach(async () => {
  await fixture.close();
});

test("catalog request failures keep the workflow recoverable and retry discovery", async ({
  page
}) => {
  await page.unrouteAll();
  await installControlUiFixture(page, fixture, {
    apiFailures: [{ path: "/api/v1/catalog/assets", times: 1 }]
  });
  await page.goto("/#catalog");

  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("crud-rest.json", { exact: false }).first()).toBeVisible();
});

test("overview polling keeps a visible failure until the operator refreshes", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route("**/api/v1/overview", async (route) => {
    reads += 1;
    if (reads === 2) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "overview offline" } })
      });
      return;
    }
    const response = await fixture.app.inject({ method: "GET", url: "/api/v1/overview" });
    await route.fulfill({ status: 200, contentType: "application/json", body: response.body });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ParkBench control center" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("alert")).toContainText("overview offline");
  await page.clock.fastForward(5100);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("alert")).toContainText("overview offline");
});

test("queue start is single-flight while the service request is pending", async ({ page }) => {
  let startRequests = 0;
  await page.route("**/api/v1/queue/start", async (route) => {
    startRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ activeExperiment: "fixture", queued: [] })
    });
  });
  await page.goto("/#queue");
  const startButton = page.getByRole("button", { name: "Start eligible work" });
  await startButton.click();
  await expect(page.getByRole("button", { name: "Starting…" })).toBeDisabled();
  await expect.poll(() => startRequests).toBe(1);
});

test("editing a matrix after preview clears the approval and preserves its inputs", async ({
  page
}) => {
  await page.goto("/#experiments");
  const values = page.getByRole("textbox", { name: "Parameter 1 values" });
  const original = await values.inputValue();
  await page.getByRole("textbox", { name: "Run name" }).fill("browser-run");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  await expect(page.getByRole("button", { name: "Confirm and queue" })).toBeVisible();
  await values.fill("500, 1000");
  await expect(page.getByRole("button", { name: "Confirm and queue" })).toHaveCount(0);
  await expect(values).toHaveValue("500, 1000");
  expect(original).toContain("500");
});

test("matrix validation failure preserves the draft for correction and retry", async ({ page }) => {
  await page.goto("/#experiments");
  const name = page.getByRole("combobox", { name: "Parameter 1 name" });
  const values = page.getByRole("textbox", { name: "Parameter 1 values" });
  const originalValues = await values.inputValue();
  await name.selectOption("");
  await page.getByRole("textbox", { name: "Run name" }).fill("browser-run");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(values).toHaveValue(originalValues);
  await name.selectOption("-B");
  await page.getByRole("textbox", { name: "Run name" }).fill("browser-run");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  await expect(page.getByText("Preview: 4 cells / 4 runs")).toBeVisible();
});

test("active-run source failures retain last-known state and expose a retry", async ({ page }) => {
  await page.unrouteAll();
  await installControlUiFixture(page, fixture);
  let metricRequests = 0;
  await page.route("**/api/v1/runs/run_live", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "run_live", state: "MEASURING", measurementValidity: "PENDING" })
    });
  });
  await page.route("**/api/v1/runs/run_live/metrics**", async (route) => {
    metricRequests += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary_failure" })
    });
  });
  await page.goto("/#runs/run_live");
  await expect(page.getByText(/metrics: stale/)).toBeVisible();
  await expect(page.getByText("State: MEASURING")).toBeVisible();
  await page.getByRole("button", { name: "Retry live data" }).click();
  await expect(page.getByText("State: MEASURING")).toBeVisible();
  await expect.poll(() => metricRequests).toBeGreaterThan(1);
});

test("active-run event polling keeps one cursor request in flight", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  let release = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/runs/run_cursor", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "run_cursor", state: "MEASURING" })
    })
  );
  await page.route("**/api/v1/runs/run_cursor/metrics**", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ samples: [], summaries: [], stale: false })
    })
  );
  await page.route("**/api/v1/runs/run_cursor/events**", async (route) => {
    requests += 1;
    if (requests === 1) await gate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: [{ id: 1, type: "phase" }], latestEventId: 1 })
    });
  });
  await page.goto("/#runs/run_cursor");
  await expect.poll(() => requests).toBe(1);
  await page.clock.fastForward(4200);
  expect(requests).toBe(1);
  release();
  await expect(page.getByText(/1 events/)).toBeVisible();
});

test("active-run stops large status and metric polls after a terminal result", async ({ page }) => {
  await page.clock.install();
  let statusReads = 0;
  let metricReads = 0;
  await page.route("**/api/v1/runs/run_terminal", (route) => {
    statusReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: "run_terminal", state: "SUCCEEDED", cleanupStatus: "COMPLETE" })
    });
  });
  await page.route("**/api/v1/runs/run_terminal/metrics", (route) => {
    metricReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ samples: [], summaries: [], stale: false })
    });
  });
  await page.route("**/api/v1/runs/run_terminal/events**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: [], latestEventId: 0 })
    })
  );
  await page.goto("/#runs/run_terminal");
  await expect(page.getByText("State: SUCCEEDED")).toBeVisible();
  const initialStatus = statusReads;
  const initialMetrics = metricReads;
  await page.clock.fastForward(6_000);
  expect(statusReads).toBe(initialStatus);
  expect(metricReads).toBe(initialMetrics);
});

test("active-run keeps polling until terminal cleanup is recorded", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route("**/api/v1/runs/run_finalizing", (route) => {
    reads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_finalizing",
        state: "SUCCEEDED",
        phase: "finalizing",
        cleanupStatus: reads === 1 ? "PENDING" : "COMPLETE"
      })
    });
  });
  await page.route("**/api/v1/runs/run_finalizing/metrics", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ samples: [], summaries: [], stale: false })
    })
  );
  await page.route("**/api/v1/runs/run_finalizing/events**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: [], latestEventId: 0 })
    })
  );
  await page.goto("/#runs/run_finalizing");
  await expect(page.getByText("Cleanup: PENDING")).toBeVisible();
  await expect(page.getByText("Phase: finalizing")).toBeVisible();
  await page.clock.fastForward(2_200);
  await expect(page.getByText("Cleanup: COMPLETE")).toBeVisible();
  await expect(page.getByText("Phase: succeeded")).toBeVisible();
  expect(reads).toBe(2);
  await page.clock.fastForward(4_000);
  expect(reads).toBe(2);
});

test("an unavailable run detail shows a recoverable failure instead of permanent loading", async ({
  page
}) => {
  await page.route("**/api/v1/runs/run_missing", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "run_not_found" } })
    })
  );
  await page.goto("/#runs/run_missing");
  await expect(page.getByText("status: stale (run_not_found)")).toBeVisible();
  await expect(page.getByText("Loading run status…")).toHaveCount(0);
  await expect(page.getByText(/run_not_found/).first()).toBeVisible();
});

test("comparison retries experiment discovery without a page reload", async ({ page }) => {
  let experimentRequests = 0;
  await page.route("**/api/v1/experiments", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    experimentRequests += 1;
    if (experimentRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary_failure" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/#comparison");
  await expect(page.getByRole("button", { name: "Retry experiments" })).toBeVisible();
  await page.getByRole("button", { name: "Retry experiments" }).click();
  await expect(page.getByText("No experiments are available for comparison yet.")).toBeVisible();
  expect(experimentRequests).toBe(2);
});

test("comparison keeps an eligible run usable when another run detail fails", async ({ page }) => {
  await page.route("**/api/v1/experiments", (route) =>
    route.fulfill({
      status: 200,
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
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_good",
        experimentId: "exp_partial",
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
      body: JSON.stringify({ error: { message: "run_detail_unavailable" } })
    })
  );
  await page.goto("/#comparison/exp_partial");
  await expect(page.getByRole("option", { name: /run_good/ })).toBeEnabled();
  await page.getByRole("checkbox", {name:/run_bad/}).check();
  await expect(page.getByRole("status").filter({hasText:"Details unavailable"}).first()).toContainText("run_detail_unavailable");
});

test("history distinguishes a new installation from filters with no matches", async ({ page }) => {
  await page.goto("/#history");
  await expect(page.getByText("No run history yet.")).toBeVisible();

  await page.getByRole("textbox", { name: "Scenario filter" }).fill("missing-scenario");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("No runs match these filters.")).toBeVisible();
  await page
    .getByRole("region", { name: "History filters" })
    .getByRole("button", { name: "Clear filters" })
    .click();
  await expect(page.getByText("No run history yet.")).toBeVisible();
});

test("overview retries a failed health and activity request", async ({ page }) => {
  await page.unrouteAll();
  await installControlUiFixture(page, fixture, {
    apiFailures: [{ path: "/api/v1/overview", times: 1 }]
  });
  await page.goto("/#");

  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "ParkBench control center" })).toBeVisible();
  await expect(page.getByText("Catalog discovery")).toBeVisible();
});

test("matrix preview and submission failures preserve the draft and can be retried", async ({
  page
}) => {
  await page.unrouteAll();
  await installControlUiFixture(page, fixture, {
    apiFailures: [
      { path: "/api/v1/experiments/preview", method: "POST", times: 1 },
      { path: "/api/v1/experiments/submit", method: "POST", times: 1 }
    ]
  });
  await page.goto("/#experiments");
  const values = page.getByRole("textbox", { name: "Parameter 1 values" });
  await values.fill("500, 1500");

  await page.getByRole("textbox", { name: "Run name" }).fill("browser-run");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  await expect(page.getByRole("button", { name: "Retry preview" })).toBeVisible();
  await expect(values).toHaveValue("500, 1500");
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect(page.getByText("Preview: 2 cells / 2 runs")).toBeVisible();

  await page.getByRole("button", { name: "Confirm and queue" }).click();
  await expect(page.getByRole("button", { name: "Retry queue" })).toBeVisible();
  await expect(values).toHaveValue("500, 1500");
  await page.getByRole("button", { name: "Retry queue" }).click();
  await expect(page.getByText("Experiment queued")).toBeVisible();
  await expect(values).toHaveValue("500, 1500");
});

test("queue start failure has a retry action", async ({ page }) => {
  await page.unrouteAll();
  await installControlUiFixture(page, fixture, {
    apiFailures: [{ path: "/api/v1/queue/start", method: "POST", times: 1 }]
  });
  await page.goto("/#queue");

  await page.getByRole("button", { name: "Start eligible work" }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Start eligible work" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("queue cancellation failure can be retried for the same run", async ({ page }) => {
  let cancelRequests = 0;
  await page.unrouteAll();
  await installControlUiFixture(page, fixture);
  await page.route("**/api/v1/queue", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [{ id: "run_retry_cancel", queueState: "QUEUED" }] })
    })
  );
  await page.route("**/api/v1/queue/runs/run_retry_cancel/cancel", async (route) => {
    cancelRequests += 1;
    await route.fulfill({
      status: cancelRequests === 1 ? 503 : 202,
      contentType: "application/json",
      body: JSON.stringify(
        cancelRequests === 1
          ? { error: { code: "temporary_failure", message: "temporary_failure" } }
          : { id: "run_retry_cancel", state: "CANCELLED" }
      )
    });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/#queue");

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Retry cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Retry cancel" }).click();
  await expect.poll(() => cancelRequests).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("dashboard detail retries a failed context request", async ({ page }) => {
  let requests = 0;
  await page.unrouteAll();
  await installControlUiFixture(page, fixture);
  await page.route("**/api/v1/dashboards/context/retry_context", async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "dashboard_unavailable", message: "dashboard_unavailable" }
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "retry_context",
        runIds: ["run_retry_context"],
        variables: { run_id: ["run_retry_context"] },
        availability: "available",
        grafanaUrl: "http://grafana:3000"
      })
    });
  });
  await page.goto("/#dashboards/retry_context");

  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTitle("ParkBench Grafana dashboard")).toBeVisible();
  expect(requests).toBe(2);
});

test("dashboard selection carries Grafana run variables and the run time range", async ({
  page
}) => {
  const from = "2026-09-26T08:00:00.000Z";
  const to = "2026-09-26T08:01:00.000Z";
  await page.unrouteAll();
  await installControlUiFixture(page, fixture);
  await page.route("**/api/v1/dashboards/context/dashboard_context", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "dashboard_context",
        experimentId: "experiment_dashboard",
        runIds: ["run_a", "run_b"],
        variables: {
          experiment_id: ["experiment_dashboard"],
          run_id: ["run_a", "run_b"],
          phase: ["measurement"]
        },
        timeRange: { from, to },
        availability: "available",
        grafanaUrl: "http://127.0.0.1:13001"
      })
    })
  );
  await page.route("**/grafana-api/search?type=dash-db", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          uid: "parkbench-run-summary",
          title: "ParkBench benchmark overview",
          type: "dash-db"
        },
        { uid: "custom-dashboard", title: "Custom dashboard", type: "dash-db" }
      ])
    })
  );
  await page.goto("/#dashboards/dashboard_context");

  const dashboardPicker = page.getByRole("combobox", { name: "Grafana dashboard" });
  await expect(dashboardPicker).toHaveValue("parkbench-run-summary");
  await dashboardPicker.selectOption("custom-dashboard");
  const iframe = page.getByTitle("ParkBench Grafana dashboard");
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute("src", /\/d\/custom-dashboard\?/);
  const source = new URL((await iframe.getAttribute("src"))!);
  expect(source.pathname).toBe("/d/custom-dashboard");
  expect(source.searchParams.get("from")).toBe(String(Date.parse(from)));
  expect(source.searchParams.get("to")).toBe(String(Date.parse(to)));
  expect(source.searchParams.getAll("var-run_id")).toEqual(["run_a", "run_b"]);
  expect(source.searchParams.get("var-experiment_id")).toBe("experiment_dashboard");
  expect(source.searchParams.get("var-phase")).toBe("measurement");
  expect(source.searchParams.has("var_run_id")).toBe(false);
});

test("history list and selected evidence recover from request failures", async ({ page }) => {
  const seeded = await seedTerminalMatrix(fixture);
  const runId = seeded.runIds[0];
  await page.unrouteAll();
  await installControlUiFixture(page, fixture, {
    apiFailures: [
      { path: "/api/v1/history/runs", method: "GET", times: 1 },
      { path: `/api/v1/history/runs/${runId}`, method: "GET", times: 1 }
    ]
  });
  await page.goto("/#history");

  await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).first().click();
  await expect(page.getByText(runId, { exact: true })).toBeVisible();
  await page.getByText(runId, { exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).last().click();
  await expect(page.getByText("State: SUCCEEDED")).toBeVisible();
  await expect(page.getByText(runId, { exact: true }).last()).toBeVisible();
});

test("expired dashboard metrics explain that saved summaries remain available", async ({
  page
}) => {
  await page.route("**/api/v1/dashboards/context/expired_context", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "expired_context",
        runIds: ["expired_run"],
        variables: { run_id: ["expired_run"] },
        availability: "expired",
        grafanaUrl: "http://grafana:3000"
      })
    })
  );
  await page.goto("/#dashboards/expired_context");
  await expect(page.getByRole("alert")).toContainText("Run metrics have expired from Prometheus");
  await expect(page.getByRole("alert")).toContainText("Saved summaries remain available");
  await expect(page.getByTitle("ParkBench Grafana dashboard")).toHaveCount(0);
});
