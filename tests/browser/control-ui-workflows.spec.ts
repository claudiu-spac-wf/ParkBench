import { expect, Page, test } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture } from "./support/control-ui-fixture";

const scenarioDocument = {
  schemaVersion: "scenario.v1",
  id: "crud-rest",
  version: "1.0.0",
  name: "CRUD REST",
  target: {
    restPath: "/api",
    databaseService: "database",
    pasService: "pas",
    pasReplicas: 1
  },
  workload: {
    operations: [{ id: "read", method: "GET", path: "/work", weight: 1 }],
    load: { mode: "constant-concurrency", concurrency: 1, seed: 7 }
  },
  phases: { warmupSeconds: 0, measurementSeconds: 1, cooldownSeconds: 0 },
  observers: []
};

const parameterDefinitions = [
  {
    id: "param_B",
    canonicalName: "-B",
    type: "integer",
    minimum: 10,
    maximum: 5000,
    defaultValue: 500,
    unit: "blocks",
    allowedValues: [500, 1000, 1500, 2000],
    step: 500,
    description: "Database buffer",
    source: "fixture",
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  }
];

const assets = [
  {
    id: "asset_db_configured",
    kind: "database_image",
    category: "docker_images",
    name: "Configured database",
    version: "12.8",
    immutableRef: "parkbench/database:configured",
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    compatibility: { runtime: "openedge" },
    provenance: { source: "configured-local-input", reference: "parkbench/database:configured" }
  },
  {
    id: "asset_db_other",
    kind: "database_image",
    category: "docker_images",
    name: "Other database",
    version: "12.8",
    immutableRef: "parkbench/database:other",
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    compatibility: { runtime: "openedge" },
    provenance: { source: "fixture", reference: "parkbench/database:other" }
  },
  {
    id: "asset_db_unready",
    kind: "database_image",
    category: "docker_images",
    name: "Unready database",
    immutableRef: "parkbench/database:unready",
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "NOT_READY",
    classificationState: "CLASSIFIED",
    compatibility: { runtime: "openedge" },
    provenance: { reference: "parkbench/database:unready" }
  },
  {
    id: "asset_pas_a",
    kind: "pas_image",
    category: "docker_images",
    name: "PAS image A",
    version: "12.8",
    immutableRef: "parkbench/pas:fixture-a",
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    compatibility: { runtime: "openedge" },
    provenance: { reference: "parkbench/pas:fixture-a" }
  },
  {
    id: "asset_pas_b",
    kind: "pas_image",
    category: "docker_images",
    name: "PAS image B",
    version: "12.8",
    immutableRef: "parkbench/pas:fixture-b",
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    compatibility: { runtime: "openedge" },
    provenance: { reference: "parkbench/pas:fixture-b" }
  },
  {
    id: "asset_platform",
    kind: "observer_image",
    category: "docker_images",
    name: "Platform observer",
    immutableRef: "parkbench/observer:fixture",
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    provenance: { reference: "parkbench/observer:fixture" }
  },
  {
    id: "asset_workload",
    kind: "workload",
    category: "workloads",
    name: "crud_cycle.p",
    immutableRef: `input:workloads/fixture-2`,
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    sourceRef: `input:workloads/fixture-2`,
    provenance: { source: "filesystem", relativePath: "crud_cycle.p" }
  },
  {
    id: "asset_workload_zip",
    kind: "workload",
    category: "workloads",
    name: "workloads.zip",
    immutableRef: `input:workloads/fixture-3`,
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    sourceRef: `input:workloads/fixture-3`,
    provenance: { source: "filesystem", relativePath: "workloads.zip" }
  },
  {
    id: "asset_seed",
    kind: "seed",
    category: "seeds",
    name: "Sports2020 seed",
    immutableRef: `input:seeds/fixture-4`,
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    sourceRef: `input:seeds/fixture-4`,
    provenance: { source: "filesystem" }
  },
  {
    id: "asset_archive",
    kind: "archive",
    category: "archives",
    name: "Sports2020 application",
    immutableRef: `input:archives/fixture-5`,
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    sourceRef: `input:archives/fixture-5`,
    provenance: { source: "filesystem" }
  }
];

function previewCells(count = 16) {
  return Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    values: { "-B": 500 + ordinal },
    repetition: 1,
    effectiveConfiguration: { "-B": 500 + ordinal }
  }));
}

async function installApiFixture(page: Page) {
  let cancellationRequested = false;
  let queueStarted = false;
  let configuredDatabaseAvailable = true;
  let lastPreflightInputs: Record<string, unknown> | undefined;
  let lastPreviewInputs: Record<string, unknown> | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/v1/catalog/assets" && request.method() === "GET")
      return json({
        items: assets.map((asset) =>
          asset.id === "asset_db_configured" && !configuredDatabaseAvailable
            ? {
                ...asset,
                availability: "STALE",
                readiness: "NOT_READY",
                verificationState: "STALE"
              }
            : asset
        ),
        hasMore: false
      });
    if (path === "/api/v1/ui-options")
      return json({
        contractVersion: "ui-options.v1",
        credentialReferences: [{ reference: "credential:pas-readonly", label: "pas-readonly" }]
      });
    if (path === "/api/v1/preflight" && request.method() === "POST") {
      const payload = request.postDataJSON();
      lastPreflightInputs = payload.inputs;
      if (
        !configuredDatabaseAvailable &&
        payload.inputs?.databaseImage === "parkbench/database:configured"
      )
        return json(
          {
            error: { code: "asset_not_selectable", message: "asset_not_selectable:databaseImage" }
          },
          422
        );
      return json({ valid: true, checks: [] });
    }
    if (path === "/api/v1/environments/bootstrap" && request.method() === "POST")
      return json({ environmentId: "env_fixture", state: "READY" }, 202);
    if (path === "/api/v1/environments/env_fixture")
      return json({ environmentId: "env_fixture", state: "READY" });
    if (path === "/api/v1/catalog/assets/asset_db_configured/verify" && request.method() === "POST")
      return json({ operationId: "imgop_fixture", state: "SUCCEEDED" }, 202);
    if (path === "/api/v1/image-operations/imgop_fixture")
      return json({
        id: "imgop_fixture",
        state: "SUCCEEDED",
        progress: { phase: "complete", percent: 100 },
        diagnostics: []
      });
    if (path === "/api/v1/scenarios" && request.method() === "GET")
      return json({ scenarios: [{ ...scenarioDocument, state: "READY" }] });
    if (path === "/api/v1/scenarios/crud-rest/1.0.0")
      return json({
        id: "crud-rest",
        version: "1.0.0",
        document: scenarioDocument,
        parameterDefinitions,
        state: "READY"
      });
    if (path === "/api/v1/scenarios/crud-rest/versions" && request.method() === "POST") {
      const payload = request.postDataJSON();
      const document = { ...payload.scenario, version: payload.scenario.version };
      return json(
        {
          id: "crud-rest",
          version: document.version,
          document,
          parameterDefinitions: payload.parameterDefinitions,
          state: "READY"
        },
        201
      );
    }
    if (path === "/api/v1/experiments/preview" && request.method() === "POST") {
      const payload = request.postDataJSON();
      lastPreviewInputs = payload.inputs;
      if (
        !configuredDatabaseAvailable &&
        payload.inputs?.databaseImage === "parkbench/database:configured"
      )
        return json(
          {
            error: { code: "asset_not_selectable", message: "asset_not_selectable:databaseImage" }
          },
          422
        );
      const count = (payload?.dimensions ?? []).reduce(
        (total: number, dimension: { values?: unknown[] }) =>
          total * (dimension.values?.length ?? 0),
        1
      );
      return json({
        previewId: "preview_fixture",
        scenario: { id: "crud-rest", version: "1.0.0" },
        cellCount: count,
        runCount: count,
        confirmationRequired: true,
        warning: {
          code: "matrix_submission_confirmation",
          message: "This submission will queue 16 runs."
        },
        cells: { items: previewCells(count), hasMore: false },
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      });
    }
    if (path === "/api/v1/experiments/submit" && request.method() === "POST")
      return json(
        { id: "exp_fixture", runCount: 16, status: "QUEUED", runs: [{ id: "run_fixture" }] },
        202
      );
    if (path === "/api/v1/queue" && request.method() === "GET")
      return json({
        items: [
          {
            id: "run_fixture",
            experimentId: "exp_fixture",
            queueState: queueStarted ? "MEASURING" : "QUEUED",
            cellOrdinal: 0,
            repetition: 1,
            retryCount: 0
          }
        ]
      });
    if (path === "/api/v1/queue/start" && request.method() === "POST") {
      queueStarted = true;
      return json({ activeExperiment: "exp_fixture", queued: [] }, 202);
    }
    if (path === "/api/v1/experiments" && request.method() === "GET")
      return json({
        experiments: [
          {
            id: "exp_fixture",
            status: "SUCCEEDED",
            runs: [
              { id: "run_fixture", cellOrdinal: 0, values: { "-B": 500 } },
              { id: "run_variant", cellOrdinal: 1, values: { "-B": 1000 } }
            ]
          }
        ]
      });
    if (path === "/api/v1/runs/run_live/cancel" && request.method() === "POST") {
      cancellationRequested = true;
      return json({ id: "run_live", state: "CANCELLED" }, 202);
    }
    if (path === "/api/v1/runs/run_live")
      return json({
        id: "run_live",
        state: "MEASURING",
        measurementValidity: "PENDING",
        phase: "measurement",
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        completeness: { complete: false, requiredGaps: [] }
      });
    if (path === "/api/v1/runs/run_fixture" || path === "/api/v1/runs/run_variant")
      return json({
        id: path.endsWith("run_variant") ? "run_variant" : "run_fixture",
        state: "SUCCEEDED",
        measurementValidity: "VALID",
        summary: { requests: { completed: 10 }, summaries: [] },
        completeness: { complete: true, requiredGaps: [] },
        cleanupStatus: "COMPLETE",
        phaseBoundaries: {}
      });
    if (path.endsWith("/events")) return json({ events: [], latestEventId: 0 });
    if (path.endsWith("/metrics"))
      return json({ samples: [], stale: false, health: { status: "healthy", services: {} } });
    if (path === "/api/v1/comparisons" && request.method() === "POST")
      return json(
        {
          id: "comparison_fixture",
          contractVersion: "comparison.v2",
          selectionRevision: 1,
          totalSelectedRunCount: 2,
          selectionPage: {
            runIds: ["run_fixture", "run_variant"],
            hasMore: false,
            returnedRunCount: 2,
            totalSelectedRunCount: 2
          },
          page: { hasMore: false, returnedRunCount: 2, totalSelectedRunCount: 2 },
          eligibility: "VALID",
          eligibilityReasons: [],
          variantRunIds: ["run_variant"],
          runs: [
            {
              runId: "run_fixture",
              role: "BASELINE",
              state: "SUCCEEDED",
              measurementValidity: "VALID",
              effectiveConfiguration: {},
              summary: { status: "LEGACY", reason: "legacy_semantics" },
              rows: [],
              tablePage: { hasMore: false, returnedRowCount: 0, totalRowCount: 0 }
            },
            {
              runId: "run_variant",
              role: "VARIANT",
              state: "SUCCEEDED",
              measurementValidity: "VALID",
              effectiveConfiguration: {},
              summary: { status: "LEGACY", reason: "legacy_semantics" },
              rows: [],
              tablePage: { hasMore: false, returnedRowCount: 0, totalRowCount: 0 }
            }
          ],
          dashboardContextId: "dashboard_fixture"
        },
        201
      );
    if (path === "/api/v1/dashboards/context/dashboard_fixture")
      return json({
        id: "dashboard_fixture",
        runIds: ["run_fixture", "run_variant"],
        variables: { run_id: ["run_fixture", "run_variant"] },
        availability: "unavailable",
        metricScope: ["workload"],
        dashboardRefs: [],
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      });
    if (path === "/api/v1/history/runs" && request.method() === "GET")
      return json({
        items: [
          {
            id: "run_fixture",
            scenario: { id: "crud-rest", version: "1.0.0" },
            workload: { operations: [{ path: "/work" }] },
            status: "SUCCEEDED",
            evidence: { cleanupStatus: "COMPLETE" }
          }
        ],
        hasMore: false
      });
    if (path === "/api/v1/history/runs/run_fixture")
      return json({
        run: {
          id: "run_fixture",
          state: "SUCCEEDED",
          measurementValidity: "VALID",
          cleanupStatus: "COMPLETE"
        },
        events: [],
        artifacts: [],
        dashboardContexts: []
      });
    return json({});
  });
  return {
    wasCancelled: () => cancellationRequested,
    setConfiguredDatabaseUnavailable: () => {
      configuredDatabaseAvailable = false;
    },
    lastPreflightInputs: () => lastPreflightInputs,
    lastPreviewInputs: () => lastPreviewInputs
  };
}

test("queue, comparison dashboard fallback, and evidence history", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/#queue");
  await expect(page.getByRole("heading", { name: "Run queue" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "run_fixture" })).toBeVisible();
  await page.getByRole("button", { name: "Start eligible work" }).click();
  await expect(page.getByRole("row").filter({ hasText: "run_fixture" })).toContainText("MEASURING");
  await page.goto("/#comparison/exp_fixture");
  await expect(page.getByRole("heading", { name: "Compare runs" })).toBeVisible();
  await page.getByRole("button", {name:"Select all candidates",exact:true}).click();
      await page.getByLabel("Baseline", {exact:true}).selectOption({index:1});
  await page.getByRole("button", { name: "Create comparison" }).click();
  await expect(page.getByRole("cell", { name: "VALID", exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Grafana is unavailable/)).toBeVisible();
  await page.goto("/#history");
  await page.getByText("run_fixture").click();
  await expect(page.getByText("Evidence detail")).toBeVisible();
  await expect(page.getByText("Lifecycle events: 0")).toBeVisible();
});

test("manual queue Refresh clears an earlier request error", async ({ page }) => {
  await installApiFixture(page);
  let reads = 0;
  await page.route("**/api/v1/queue", async (route) => {
    reads += 1;
    await route.fulfill({
      status: reads === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        reads === 1 ? { error: { message: "queue_temporarily_unavailable" } } : { items: [] }
      )
    });
  });
  await page.goto("/#queue");
  await expect(page.getByRole("alert")).toContainText("queue_temporarily_unavailable");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("The queue is empty.", { exact: false })).toBeVisible();
});

test("queue polling keeps at most one silent read in flight", async ({ page }) => {
  await installApiFixture(page);
  let reads = 0;
  let active = 0;
  let maximum = 0;
  await page.route("**/api/v1/queue", async (route) => {
    reads += 1;
    if (reads > 1) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2600));
      active -= 1;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] })
    });
  });
  await page.goto("/#queue");
  await expect(page.getByText("The queue is empty.", { exact: false })).toBeVisible();
  await page.waitForTimeout(4900);
  expect(maximum).toBeLessThanOrEqual(1);
});

test("queued-run cancellation sends one mutation for a rapid repeated click", async ({ page }) => {
  await installApiFixture(page);
  await page.addInitScript(() => {
    window.confirm = () => true;
  });
  let cancellations = 0;
  await page.route("**/api/v1/queue/runs/run_fixture/cancel", async (route) => {
    cancellations += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ id: "run_fixture", state: "CANCELLED" })
    });
  });
  await page.goto("/#queue");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === "Cancel"
    );
    button?.click();
    button?.click();
  });
  await expect.poll(() => cancellations).toBe(1);
});

test("live run polling exposes health and sends cancellation", async ({ page }) => {
  const fixture = await installApiFixture(page);
  await page.goto("/#runs/run_live");
  await expect(page.getByRole("heading", { name: "Run run_live" })).toBeVisible();
  await expect(page.getByText("State: MEASURING")).toBeVisible();
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect.poll(fixture.wasCancelled).toBe(true);
});

test("blocked queue entry opens terminal evidence and its related destinations", async ({
  page
}) => {
  await installApiFixture(page);
  await page.route("**/api/v1/queue", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "run_blocked",
            experimentId: "exp_blocked",
            cellOrdinal: 1,
            repetition: 1,
            queueState: "BLOCKED",
            blockedReason: "capacity_wait",
            retryCount: 1,
            nextRetryAt: "2026-09-27T12:00:00Z"
          }
        ]
      })
    })
  );
  await page.route("**/api/v1/runs/run_blocked", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_blocked",
        experimentId: "exp_blocked",
        state: "SUCCEEDED",
        measurementValidity: "VALID",
        cleanupStatus: "COMPLETE",
        completeness: { complete: true, requiredGaps: [] },
        evidence: {
          links: [{ label: "run evidence", url: "/api/v1/runs/run_blocked/artifacts/evidence" }]
        }
      })
    })
  );
  await page.goto("/#queue");
  await expect(page.getByText("capacity_wait")).toBeVisible();
  await expect(page.getByText("2026-09-27T12:00:00Z")).toBeVisible();
  await page.getByRole("link", { name: "Monitor" }).click();
  await expect(page.getByRole("heading", { name: "Terminal evidence" })).toBeVisible();
  await expect(page.getByRole("link", { name: "run evidence" })).toHaveAttribute(
    "href",
    "/api/v1/runs/run_blocked/artifacts/evidence"
  );
  await expect(page.getByRole("link", { name: "Open comparison" })).toHaveAttribute(
    "href",
    "#comparison/exp_blocked"
  );
  await page.getByRole("link", { name: "View run history" }).click();
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
});

test("large matrix preview remains reviewable without a run-count cap", async ({ page }) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    await page.goto("/#experiments");
    const values = Array.from({ length: 20 }, (_, index) => String(500 + index)).join(", ");
    await page.getByRole("textbox", { name: "Parameter 1 values" }).fill(values);
    await page.getByRole("button", { name: "Add dimension" }).click();
    await page.getByRole("combobox", { name: "Parameter 2 name" }).selectOption("-B2");
    await page.getByRole("textbox", { name: "Parameter 2 values" }).fill(values);
    await page.getByRole("textbox", { name: "Run name" }).fill("browser-run");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.getByText("Preview: 400 cells / 400 runs")).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more preview cells" })).toBeVisible();
  } finally {
    await fixture.close();
  }
});
