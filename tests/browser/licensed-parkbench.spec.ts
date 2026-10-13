import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { captureLicensedResourceWindows } from "./support/licensed-resource-capture";

const repoRoot = process.cwd();
const configuredUiUrl = process.env.PARKBENCH_LICENSED_UI_URL ?? "http://127.0.0.1:13002/";
const prometheusUrl = process.env.PARKBENCH_PROMETHEUS_URL ?? "http://127.0.0.1:19090";

const acceptanceRunIds = new Set<string>();
const temporaryInputs: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of acceptanceRunIds) {
    const current = await page.request.get(new URL(`/api/v1/runs/${id}`, configuredUiUrl).href);
    if (!current.ok()) continue;
    const run = await current.json();
    if (
      ![
        "SUCCEEDED",
        "INCOMPLETE",
        "FAILED",
        "CANCELLED",
        "INTERRUPTED",
        "THRESHOLD_FAILED"
      ].includes(run.state)
    ) {
      await page.request.post(new URL(`/api/v1/queue/runs/${id}/cancel`, configuredUiUrl).href, {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: {}
      });
    }
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            new URL(`/api/v1/runs/${id}`, configuredUiUrl).href
          );
          return (await response.json()).cleanupStatus;
        },
        { timeout: 120_000 }
      )
      .toBe("COMPLETE");
  }
  acceptanceRunIds.clear();
  for (const input of temporaryInputs) fs.rmSync(input, { recursive: true, force: true });
  temporaryInputs.length = 0;
  await page.request.post(new URL("/api/v1/catalog/discovery/refresh", configuredUiUrl).href, {
    data: {}
  });
});

test("licensed ParkBench seed run completes through the deployed UI and retains verified evidence", async ({
  page
}) => {
  test.setTimeout(1_800_000);
  const artifactRoot = path.resolve(
    repoRoot,
    process.env.PARKBENCH_ARTIFACT_ROOT || ".parkbench/artifacts"
  );

  await page.goto(new URL("#experiments", configuredUiUrl).href);
  await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
  const choices = page.getByRole("combobox");

  const scenarioSelect = choices.nth(0);
  const workScenarioValue = await firstOptionValue(scenarioSelect, /parkbench-bank-mix\.json/);
  await scenarioSelect.selectOption(workScenarioValue);
  await expect(scenarioSelect).toHaveValue(workScenarioValue);

  const databaseImage = { value: requireSetting("PARKBENCH_OPENEDGE_DB_IMAGE") };
  const pasImage = { value: requireSetting("PARKBENCH_OPENEDGE_PAS_IMAGE") };
  const seed = await chooseReadyOption(choices.nth(1));
  const applicationArchive = await chooseReadyOption(choices.nth(2));
  await page.getByRole("button", { name: "Add dimension", exact: true }).click();
  await page.getByRole("combobox", { name: "Parameter 2 name" }).selectOption("-B2");

  await expect(page.getByRole("textbox", { name: "Parameter 1 values" })).toBeVisible();
  await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("500");
  await page.getByRole("textbox", { name: "Parameter 2 values" }).fill("500");
  await page.getByRole("textbox", { name: "Run name" }).fill("parkbench-licensed");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  await expect(page.getByRole("heading", { name: "Preview: 1 cells / 1 runs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Queue review summary" })).toContainText(
    "parkbench-bank-mix.json"
  );
  await expect(page.getByRole("button", { name: "Confirm and queue" })).toBeEnabled();

  const submissionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/experiments/submit"
  );
  await page.getByRole("button", { name: "Confirm and queue" }).click();
  const response = await submissionResponse;
  const submission = await response.json();
  expect(
    response.ok(),
    `licensed_submission_failed:${submission.error?.code ?? "unknown"}`
  ).toBeTruthy();
  expect(submission.name).toBe("parkbench-licensed");
  const runId = submission.runs?.[0]?.id ?? submission.runs?.[0]?.runId;
  expect(typeof runId).toBe("string");
  acceptanceRunIds.add(String(runId));
  expect(submission.runs?.[0]?.name).toMatch(/^run_parkbench-licensed-\d+$/);
  await expect(page.getByText("Experiment queued")).toBeVisible();

  await page.getByRole("link", { name: "Queue", exact: true }).click();
  await page.getByRole("button", { name: "Start eligible work" }).click();
  const monitorLink = page
    .locator(`a[href="#runs/${runId}"]`)
    .filter({ hasText: "Monitor" })
    .first();
  await expect(monitorLink).toBeVisible({ timeout: 60_000 });
  await monitorLink.click();
  await expect(
    page.getByRole("heading", { name: `Run ${submission.runs?.[0]?.name ?? runId}` })
  ).toBeVisible();
  const matchedWindows = captureLicensedResourceWindows(
    page.request,
    configuredUiUrl,
    prometheusUrl,
    String(runId)
  )
    .then(async (capture) => {
      await test.info().attach("matched-resource-windows", {
        body: Buffer.from(JSON.stringify(capture)),
        contentType: "application/json"
      });
      return capture;
    })
    .catch((error) => ({ error: String(error) }));
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          new URL(`/api/v1/runs/${runId}`, configuredUiUrl).href
        );
        const run = await response.json();
        return [
          "SUCCEEDED",
          "INCOMPLETE",
          "FAILED",
          "CANCELLED",
          "INTERRUPTED",
          "THRESHOLD_FAILED"
        ].includes(run.state)
          ? run.state
          : "active";
      },
      { timeout: 1_500_000, intervals: [1000, 2000] }
    )
    .not.toBe("active");
  const terminal = await (
    await page.request.get(new URL(`/api/v1/runs/${runId}`, configuredUiUrl).href)
  ).json();
  expect(["SUCCEEDED", "INCOMPLETE"]).toContain(terminal.state);
  const fullyMeasured = terminal.state === "SUCCEEDED";
  await expect(page.getByText(`State: ${terminal.state}`)).toBeVisible();
  await expect(
    page.getByText(`Measurement completeness: ${fullyMeasured ? "complete" : "incomplete"}`).first()
  ).toBeVisible();
  await expect(page.getByText("Cleanup: COMPLETE")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(`Phase: ${terminal.state.toLowerCase()}`)).toBeVisible();
  await page.getByRole("link", { name: "View run history" }).click();
  await page.getByText(String(runId), { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Evidence detail" })).toBeVisible();

  const detailResponse = await page.request.get(
    new URL(`/api/v1/history/runs/${encodeURIComponent(runId)}`, configuredUiUrl).href
  );
  expect(detailResponse.ok()).toBeTruthy();
  const detail = await detailResponse.json();
  expect(detail.run.id).toBe(runId);
  expect(detail.run.state).toBe(terminal.state);
  expect(detail.run.measurementValidity).toBe(fullyMeasured ? "VALID" : "INCOMPLETE");
  expect(detail.run.cleanupStatus).toBe("COMPLETE");
  expect(detail.run.completeness.complete).toBe(fullyMeasured);
  expect(detail.experiment.scenario).toEqual({ id: "parkbench-bank-mix", version: "1.0.0" });
  expect(detail.experiment.inputs.seed).toBe(seed.value);
  expect(detail.experiment.inputs.applicationArchive).toBe(applicationArchive.value);

  const captured: any = await matchedWindows;
  await test.info().attach("matched-resource-windows", {
    body: Buffer.from(JSON.stringify(captured)),
    contentType: "application/json"
  });
  expect(captured.error).toBeUndefined();
  expect(captured.windows).toHaveLength(3);
  for (const window of captured.windows)
    for (const pair of window.comparisons) {
      expect(Math.abs(pair.dockerCpu - pair.prometheusCpu)).toBeLessThanOrEqual(pair.cpuTolerance);
      expect(Math.abs(pair.dockerMemory - pair.prometheusMemory)).toBeLessThanOrEqual(
        pair.memoryTolerance
      );
    }
  const { summary: savedSummary, context } = await readCurrentRunArtifacts(
    detail,
    artifactRoot,
    String(runId)
  );
  expect(savedSummary.contractVersion).toBe("run-summary.v1");
  expect(context.contractVersion).toBe("run-context.v1");
  expect(context.runId).toBe(runId);
  expect(context.inputs.databaseImage).toBe(databaseImage.value);
  expect(context.inputs.pasImage).toBe(pasImage.value);
  expect(context.images.manifest).toBeTruthy();
  expect(context.effective.parameters.scenario).toBe("parkbench-bank-mix");
  expect(context.effective.parameters.scenarioVersion).toBe("1.0.0");
  expect(context.loadSeed).toBe(2026);
  expect(context.observed.phaseBoundaries.warmup.startedAt).toBeTruthy();
  expect(context.observed.phaseBoundaries.measurement.startedAt).toBe(
    savedSummary.windows.measurement.start
  );
  expect(context.observed.phaseBoundaries.measurement.finishedAt).toBe(
    savedSummary.windows.measurement.end
  );
  expect(context.observed.phaseBoundaries.cooldown.finishedAt).toBeTruthy();
  expect(context.host.hostEnvironment.engine.reachable).toBe(true);
  expect(context.host.hostEnvironment.engine.operatingSystem).toBe("linux");
  expect(context.scenario.workload.operations[0].bodyTemplate.procName).toBe(
    "Workloads/ParkBench/bank_mix.p"
  );
  expect(context.inputs.seedName).toBe("one_gb_lnx");
  expect(context.inputs.databaseName).toBe("parkbench");
  expect(savedSummary.workload.requests.completed).toBeGreaterThan(0);
  expect(savedSummary.workload.requests.errors).toBe(0);
  expect(savedSummary.workload.timeoutCount).toBe(0);
  expect(savedSummary.quality.complete).toBe(fullyMeasured);
  if (!fullyMeasured) expect(savedSummary.quality.requiredGaps.length).toBeGreaterThan(0);
  expect(savedSummary.quality.cleanupStatus).toBe("COMPLETE");
  expect(savedSummary.expectedTableCount).toBeGreaterThan(0); // The separate licensed fixture verifies >64.
  expect(savedSummary.tableRowCount).toBe(savedSummary.expectedTableCount * 5);
  expect(savedSummary.memberships.some((member: any) => member.group === "database")).toBe(true);
  expect(
    savedSummary.memberships
      .filter((member: any) => member.group === "pas")
      .every((member: any) => /^pas-\d+$/.test(member.replica))
  ).toBe(true);
  expect(
    savedSummary.rows.find(
      (row: any) => row.definitionId === "disk.read.bytes" && row.group === "database"
    )?.statistics.total.value
  ).not.toBeNull();
  expect(
    detail.artifacts.some((artifact: any) => artifact.kind === "raw_prometheus_timeseries")
  ).toBe(false);
  expect(savedSummary.metricsReference.queries.length).toBeGreaterThan(0);
  expect(savedSummary.metricsReference.labelKeys).toEqual(
    expect.arrayContaining(["run_id", "phase", "table", "database_epoch"])
  );
  const measuredAt = savedSummary.windows.measurement.end;
  expect(await prometheusHas(`{run_id="${runId}",phase="measurement"}`, measuredAt)).toBe(true);
  expect(
    await prometheusHas(
      `parkbench_openedge_db_table_operations_total{run_id="${runId}"}`,
      measuredAt
    )
  ).toBe(true);
  expect(
    await prometheusHas(
      `parkbench_openedge_db_index_operations_total{run_id="${runId}"}`,
      measuredAt
    )
  ).toBe(true);
  expect(
    await prometheusHas(
      `parkbench_openedge_db_table_operations_total{run_id="${runId}",table="CustomerContact"}`,
      measuredAt
    )
  ).toBe(true);

  const completedRunResponse = await page.request.get(
    new URL(`/api/v1/runs/${encodeURIComponent(runId)}`, configuredUiUrl).href
  );
  expect(completedRunResponse.ok()).toBeTruthy();
  const completedRun = await completedRunResponse.json();
  expect(completedRun.phase).toBe(terminal.state.toLowerCase());
  const dashboardContextId = completedRun.dashboardContext?.id;
  expect(typeof dashboardContextId).toBe("string");
  const contextResponse = await page.request.get(
    new URL(`/api/v1/dashboards/context/${encodeURIComponent(dashboardContextId)}`, configuredUiUrl)
      .href
  );
  expect(contextResponse.ok()).toBeTruthy();
  const dashboardContext = await contextResponse.json();
  await page.goto(new URL(`#dashboards/${dashboardContextId}`, configuredUiUrl).href);
  const dashboardFrame = page.getByTitle("ParkBench Grafana dashboard");
  await expect(dashboardFrame).toHaveAttribute("src", /\/d\/[^?]+\?/);
  const firstDashboardSrc = await dashboardFrame.getAttribute("src");
  await assertLoadedGrafanaScope(page, firstDashboardSrc!, dashboardContext, runId);
  await page.getByRole("button", { name: "Next dashboard" }).click();
  await expect(dashboardFrame).not.toHaveAttribute("src", firstDashboardSrc!);
  await assertLoadedGrafanaScope(
    page,
    (await dashboardFrame.getAttribute("src"))!,
    dashboardContext,
    runId
  );
  await page.goto(new URL("#history", configuredUiUrl).href);
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: String(runId) })).toContainText(
    terminal.state
  );

  const reviewStarted = Date.now();
  await page.goto(new URL(`#comparison/${submission.id}`, configuredUiUrl).href);
  await page.getByRole("combobox").nth(1).selectOption(String(runId));
  await expect(page.getByRole("combobox").nth(1)).toHaveValue(String(runId));
  const comparisonResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/comparisons"
  );
  await page.getByRole("button", { name: "Create comparison" }).click();
  const comparison = await (await comparisonResponse).json();
  expect(comparison.selectionPage.runIds).toEqual([runId]);
  const savedCpu = savedSummary.rows.find(
    (row: any) =>
      row.definitionId === "cpu.usage" && row.group === "database" && !row.dimensions.replica
  );
  const apiCpu = comparison.runs[0].rows.find(
    (entry: any) => entry.row.rowKey === savedCpu.rowKey
  ).row;
  expect(apiCpu.statistics.average.value).toBe(savedCpu.statistics.average.value);
  const formattedCpu = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 7 }).format(
    savedCpu.statistics.average.value
  );
  await expect(page.getByRole("table", { name: "Database resources" })).toContainText(formattedCpu);
  await expect(page.getByRole("table", { name: "Platform resources" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Pas resources" })).toBeVisible();
  await page.getByText(/^All measured tables \(/).click();
  await expect(page.getByRole("table", { name: "Table activity" })).toBeVisible();
  expect(Date.now() - reviewStarted).toBeLessThan(120_000);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download comparison CSV" }).click();
  const csv = fs.readFileSync((await (await downloaded).path())!, "utf8");
  const lines = csv.trimEnd().split(/\r?\n/),
    columns = lines[0].split(",");
  expect(lines.length).toBe(savedSummary.rows.length + 1);
  const csvCpu = lines
    .slice(1)
    .map((line) => line.split(","))
    .find(
      (cells) =>
        cells[columns.indexOf("group")] === "database" &&
        cells[columns.indexOf("metric")] === savedCpu.displayName &&
        !cells[columns.indexOf("replica")]
    );
  expect(Number(csvCpu![columns.indexOf("average")])).toBe(savedCpu.statistics.average.value);

  // This second experiment is independent of the completed run above.
  await page.goto(new URL("#experiments", configuredUiUrl).href);
  await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
  const matrixChoices = page.getByRole("combobox");
  await matrixChoices
    .nth(0)
    .selectOption(await firstOptionValue(matrixChoices.nth(0), /parkbench-bank-mix\.json/));
  const matrixDatabase = databaseImage;
  await chooseReadyOption(matrixChoices.nth(1));
  await chooseReadyOption(matrixChoices.nth(2));
  await page.getByRole("button", { name: "Add dimension", exact: true }).click();
  await page.getByRole("combobox", { name: "Parameter 2 name" }).selectOption("-B2");
  await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("500");
  await page.getByRole("textbox", { name: "Parameter 2 values" }).fill("500");
  await page.getByRole("spinbutton", { name: /Repetitions/ }).fill("2");
  const previewResponse = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/experiments/preview"
  );
  await page.getByRole("textbox", { name: "Run name" }).fill("parkbench-licensed");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  const matrixPreview = await (await previewResponse).json();
  expect(matrixPreview.scenario).toEqual({ id: "parkbench-bank-mix", version: "1.0.0" });
  expect(matrixPreview.runCount).toBeGreaterThanOrEqual(2);
  expect(matrixPreview.cells.items.map((cell: any) => cell.runName)).toEqual(
    expect.arrayContaining([expect.stringMatching(/^run_parkbench-licensed-\d+$/)])
  );
  await expect(
    page.getByRole("heading", {
      name: `Preview: ${matrixPreview.cellCount} cells / ${matrixPreview.runCount} runs`
    })
  ).toBeVisible();
  const summary = page.getByRole("region", { name: "Queue review summary" });
  await expect(summary).toContainText("parkbench-bank-mix.json");
  await expect(summary).toContainText(seed.label.split(" — ")[0]);
  await expect(summary).toContainText(`Total runs:${matrixPreview.runCount}`);
  while (
    await page
      .getByRole("button", { name: "Load more preview cells" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole("button", { name: "Load more preview cells" }).click();
    await expect(page.getByRole("button", { name: "Loading cells…" })).toBeHidden();
  }
  await expect(
    page.getByText(`Reviewed all ${matrixPreview.runCount} expanded run configurations.`)
  ).toBeVisible();
  const reviewedRows = page.locator(".preview-panel tbody tr");
  await expect(reviewedRows).toHaveCount(matrixPreview.runCount);
  for (let index = 0; index < matrixPreview.runCount; index++) {
    await expect(reviewedRows.nth(index)).toContainText('"-B":500');
    await expect(reviewedRows.nth(index)).toContainText('"-B2":500');
  }
  await expect(page.getByRole("button", { name: "Confirm and queue" })).toBeEnabled();
  const matrixSubmissionResponse = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/experiments/submit"
  );
  await page.getByRole("button", { name: "Confirm and queue" }).click();
  const matrixHttpResponse = await matrixSubmissionResponse;
  const matrixSubmission = await matrixHttpResponse.json();
  expect(matrixHttpResponse.ok()).toBeTruthy();
  expect(matrixSubmission.name).toBe("parkbench-licensed");
  const runIds: string[] = (matrixSubmission.runs ?? []).map((run: any) =>
    String(run.id ?? run.runId)
  );
  expect(matrixSubmission.runCount).toBe(matrixPreview.runCount);
  expect(runIds).toHaveLength(matrixPreview.runCount);
  expect(new Set(runIds).size).toBe(runIds.length);
  expect(matrixSubmission.runs.map((run: any) => run.name)).toEqual(
    matrixPreview.cells.items.map((cell: any) => cell.runName)
  );
  expect(runIds).not.toContain(runId);
  const matrixExperimentId = String(matrixSubmission.id);
  expect(matrixExperimentId).not.toBe(String(submission.id));
  try {
    await page.goto(new URL("#comparison", configuredUiUrl).href);
    const experimentChoices = page.getByRole("combobox").first();
    await expect(
      experimentChoices.getByRole("option", { name: new RegExp(submission.runs[0].name) })
    ).toHaveCount(1);
    await expect(
      experimentChoices.getByRole("option", { name: new RegExp(matrixSubmission.runs[0].name) })
    ).toHaveCount(1);
    await experimentChoices.selectOption(matrixExperimentId);
    await expect(experimentChoices).toHaveValue(matrixExperimentId);
    await page.goto(new URL("#queue", configuredUiUrl).href);
    await expect(page.getByRole("heading", { name: "Run queue" })).toBeVisible();
    for (const id of runIds) {
      const row = page.getByRole("row").filter({ has: page.locator(`a[href="#runs/${id}"]`) });
      await expect(row).toContainText(matrixExperimentId);
      await expect(row).toContainText(
        matrixSubmission.runs.find((run: any) => run.id === id)?.name
      );
      await expect(row).toContainText("QUEUED");
    }
    const queuedExperimentResponse = await page.request.get(
      new URL(`/api/v1/experiments/${encodeURIComponent(matrixExperimentId)}`, configuredUiUrl).href
    );
    expect(queuedExperimentResponse.ok()).toBeTruthy();
    const queuedExperiment = await queuedExperimentResponse.json();
    expect(queuedExperiment.scenario).toEqual({ id: "parkbench-bank-mix", version: "1.0.0" });
    expect(queuedExperiment.runCount).toBe(matrixPreview.runCount);
    expect(new Set((queuedExperiment.runs ?? []).map((run: any) => run.id))).toEqual(
      new Set(runIds)
    );
    for (const id of runIds) {
      const detail = await page.request.get(
        new URL(`/api/v1/history/runs/${encodeURIComponent(id)}`, configuredUiUrl).href
      );
      expect(detail.ok()).toBeTruthy();
      const record = await detail.json();
      expect(record.experiment.scenario).toEqual({ id: "parkbench-bank-mix", version: "1.0.0" });
      expect(record.run.environmentSnapshot.inputs.databaseImage).toBe(matrixDatabase.value);
    }
    for (const id of runIds) {
      const row = page.getByRole("row").filter({ has: page.locator(`a[href="#runs/${id}"]`) });
      page.once("dialog", (dialog) => dialog.accept());
      await row.getByRole("button", { name: "Cancel" }).click();
      await expect
        .poll(async () => {
          const cancelled = await page.request.get(
            new URL(`/api/v1/runs/${id}`, configuredUiUrl).href
          );
          return (await cancelled.json()).state;
        })
        .toBe("CANCELLED");
      await expect(row).toHaveCount(0);
    }
  } finally {
    // Reconcile only runs submitted by this second journey, even after an assertion failure.
    for (const id of runIds) {
      const key = crypto.randomUUID();
      await page.request
        .post(
          new URL(`/api/v1/queue/runs/${encodeURIComponent(id)}/cancel`, configuredUiUrl).href,
          {
            headers: { "Idempotency-Key": key },
            data: {}
          }
        )
        .catch(() => undefined);
    }
  }
});

test("licensed two PAS replicas contribute once to saved resource summaries", async ({ page }) => {
  test.setTimeout(1_200_000);
  const name = `licensed-two-pas-${Date.now()}`;
  const filename = `${name}.json`;
  const scenarioRoot = resolveSourcePath(
    process.env.PARKBENCH_DISCOVERY_SCENARIOS_ROOT || "examples/scenarios"
  );
  const fixture = JSON.parse(
    fs.readFileSync(path.join(scenarioRoot, "parkbench-bank-mix.json"), "utf8")
  );
  fixture.id = name;
  fixture.name = "Licensed two PAS resource acceptance";
  fixture.target.pasReplicas = 2;
  fixture.workload.load.concurrency = 6;
  fixture.phases.measurementSeconds = 240;
  const fixturePath = path.join(scenarioRoot, filename);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  temporaryInputs.push(fixturePath);
  const refresh = await page.request.post(
    new URL("/api/v1/catalog/discovery/refresh", configuredUiUrl).href,
    { data: {} }
  );
  expect(refresh.ok()).toBeTruthy();
  await page.goto(new URL("#experiments", configuredUiUrl).href);
  await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
  const choices = page.getByRole("combobox");
  await choices
    .nth(0)
    .selectOption(await firstOptionValue(choices.nth(0), new RegExp(filename.replace(".", "\\."))));
  await chooseReadyOption(choices.nth(1));
  await chooseReadyOption(choices.nth(2));
  await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("500");
  await page.getByRole("textbox", { name: "Run name" }).fill(name);
  // Two PAS instances need broker capacity for their sessions plus the native observer.
  for (const [index, parameter, value] of [[2, "-n", "100"]] as const) {
    await page.getByRole("button", { name: "Add dimension", exact: true }).click();
    await page.getByRole("combobox", { name: `Parameter ${index} name` }).selectOption(parameter);
    await page.getByRole("textbox", { name: `Parameter ${index} values` }).fill(value);
  }
  await page.getByRole("button", { name: "Preview matrix" }).click();
  await expect(page.getByRole("heading", { name: "Preview: 1 cells / 1 runs" })).toBeVisible();
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/experiments/submit"
  );
  await page.getByRole("button", { name: "Confirm and queue" }).click();
  const submission = await (await submitted).json();
  const id = String(submission.runs[0].id);
  acceptanceRunIds.add(id);
  await page.goto(new URL("#queue", configuredUiUrl).href);
  await page.getByRole("button", { name: "Start eligible work" }).click();
  const captured = await captureLicensedResourceWindows(
    page.request,
    configuredUiUrl,
    prometheusUrl,
    id
  );
  expect(
    captured.containers
      .filter((c) => /^pas-/.test(c.service))
      .map((c) => c.service)
      .sort()
  ).toEqual(["pas-1", "pas-2"]);
  for (const window of captured.windows) {
    expect(window.comparisons).toHaveLength(3);
    for (const pair of window.comparisons) {
      expect(Math.abs(pair.dockerCpu - pair.prometheusCpu)).toBeLessThanOrEqual(pair.cpuTolerance);
      expect(Math.abs(pair.dockerMemory - pair.prometheusMemory)).toBeLessThanOrEqual(
        pair.memoryTolerance
      );
      const copies = window.raw.filter(
        (sample: any) =>
          sample.metricName === "container_memory_working_set_bytes" &&
          sample.labels.id?.includes(pair.container.id)
      );
      expect([...new Set(copies.map((sample: any) => sample.labels.job))]).toEqual([
        "parkbench-run-owned-cadvisor"
      ]);
    }
  }
  await test.info().attach("matched-two-pas-resource-windows", {
    body: Buffer.from(JSON.stringify(captured)),
    contentType: "application/json"
  });
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          new URL(`/api/v1/runs/${id}`, configuredUiUrl).href
        );
        const run = await response.json();
        return [
          "SUCCEEDED",
          "INCOMPLETE",
          "FAILED",
          "CANCELLED",
          "INTERRUPTED",
          "THRESHOLD_FAILED"
        ].includes(run.state)
          ? run.state
          : "active";
      },
      { timeout: 600_000, intervals: [1000, 2000] }
    )
    .not.toBe("active");
  await expect
    .poll(
      async () => {
        const current = await page.request.get(new URL(`/api/v1/runs/${id}`, configuredUiUrl).href);
        return (await current.json()).cleanupStatus;
      },
      { timeout: 120_000 }
    )
    .toBe("COMPLETE");
  const detail = await (
    await page.request.get(new URL(`/api/v1/history/runs/${id}`, configuredUiUrl).href)
  ).json();
  expect(["SUCCEEDED", "INCOMPLETE"]).toContain(detail.run.state);
  expect(detail.run.cleanupStatus).toBe("COMPLETE");
  const { summary, context } = await readCurrentRunArtifacts(
    detail,
    path.resolve(repoRoot, process.env.PARKBENCH_ARTIFACT_ROOT || ".parkbench/artifacts"),
    id
  );
  const members = summary.memberships.filter((member: any) => member.group === "pas");
  expect(members.map((member: any) => member.replica).sort()).toEqual(["pas-1", "pas-2"]);
  expect(new Set(members.map((member: any) => member.physicalId)).size).toBe(2);
  expect(context.scenario.target.pasReplicas).toBe(2);
  expect(summary.quality.complete).toBe(detail.run.state === "SUCCEEDED");
  if (detail.run.state === "INCOMPLETE")
    expect(summary.quality.requiredGaps.length).toBeGreaterThan(0);
  for (const definition of ["cpu.usage", "memory.used"]) {
    const replicas = summary.rows.filter(
      (row: any) =>
        row.definitionId === definition &&
        row.group === "pas" &&
        typeof row.dimensions.replica === "string"
    );
    expect(replicas.map((row: any) => row.dimensions.replica).sort()).toEqual(["pas-1", "pas-2"]);
    expect(replicas.every((row: any) => row.statistics.average.value !== null)).toBe(true);
    const aggregate = summary.rows.find(
      (row: any) =>
        row.definitionId === definition && row.group === "pas" && !row.dimensions.replica
    );
    const replicaAverage = replicas.reduce(
      (sum: number, row: any) => sum + row.statistics.average.value,
      0
    );
    expect(aggregate.statistics.average.value).not.toBeNull();
    if (summary.quality.complete) {
      expect(Math.abs(aggregate.statistics.average.value - replicaAverage)).toBeLessThanOrEqual(
        Math.max(1e-6, Math.abs(replicaAverage) * 1e-9)
      );
    } else {
      // Partial averages use the common interval, unlike each replica's own interval.
      expect(aggregate.coverage.observedSeconds).toBeLessThanOrEqual(
        Math.min(...replicas.map((row: any) => row.coverage.observedSeconds)) + 1e-6
      );
      expect(aggregate.coverage.missingSeconds).toBeGreaterThanOrEqual(
        Math.max(...replicas.map((row: any) => row.coverage.missingSeconds)) - 1e-6
      );
    }
    if (definition === "cpu.usage") {
      const total = replicas.reduce((sum: number, row: any) => sum + row.statistics.total.value, 0);
      expect(Math.abs(aggregate.statistics.total.value - total)).toBeLessThanOrEqual(
        Math.max(1e-6, Math.abs(total) * 1e-9)
      );
      expect(aggregate.statistics.total.coverage.coverageModel).toBe("constituent_additive");
    }
  }
});

test("licensed startup file and three queued -B overrides reach four primary brokers", async ({
  page
}) => {
  test.setTimeout(1_800_000);
  const sourcePath = path.join(
    resolveSourcePath(process.env.PARKBENCH_DISCOVERY_SEEDS_ROOT || ".parkbench/seeds"),
    requireSetting("PARKBENCH_OPENEDGE_DEFAULT_SEED")
  );
  // Review startup-file behavior on an isolated copy; never edit the operator seed.
  const fixtureName = `licensed-startup-${Date.now()}`;
  const fixtureSeed = path.join(path.dirname(sourcePath), fixtureName);
  fs.cpSync(sourcePath, fixtureSeed, { recursive: true });
  fs.writeFileSync(path.join(fixtureSeed, "startup.pf"), "-B 500\n");
  temporaryInputs.push(fixtureSeed);
  const scenarioRoot = resolveSourcePath(
    process.env.PARKBENCH_DISCOVERY_SCENARIOS_ROOT || "examples/scenarios"
  );
  const fixtureScenario = JSON.parse(
    fs.readFileSync(path.join(scenarioRoot, "parkbench-bank-mix.json"), "utf8")
  );
  fixtureScenario.id = fixtureName;
  fixtureScenario.name = "Licensed startup parameter acceptance";
  fixtureScenario.phases = { warmupSeconds: 10, measurementSeconds: 60, cooldownSeconds: 5 };
  const fixtureScenarioPath = path.join(scenarioRoot, `${fixtureName}.json`);
  fs.writeFileSync(fixtureScenarioPath, JSON.stringify(fixtureScenario));
  temporaryInputs.push(fixtureScenarioPath);
  const refreshed = await page.request.post(
    new URL("/api/v1/catalog/discovery/refresh", configuredUiUrl).href,
    { data: {} }
  );
  expect(refreshed.ok()).toBeTruthy();
  const artifactRoot = path.resolve(
    repoRoot,
    process.env.PARKBENCH_ARTIFACT_ROOT || ".parkbench/artifacts"
  );
  const runPairs: Array<{ runId: string; value: string }> = [];
  for (const value of ["500", "1000", "2000", "3000"]) {
    await page.goto(new URL("#experiments", configuredUiUrl).href);
    await expect(page.getByRole("heading", { name: "Schedule an experiment" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(1);
    const choices = page.getByRole("combobox");
    await choices
      .nth(0)
      .selectOption(await firstOptionValue(choices.nth(0), new RegExp(`${fixtureName}\\.json`)));
    await choices
      .nth(1)
      .selectOption(await firstOptionValue(choices.nth(1), new RegExp(fixtureName)));
    await chooseReadyOption(choices.nth(2));
    if (value === "500") await page.getByRole("button", { name: "Remove", exact: true }).click();
    else await page.getByRole("textbox", { name: "Parameter 1 values" }).fill(value);
    await page.getByRole("textbox", { name: "Run name" }).fill(`parkbench-parameter-${value}`);
    await page.getByRole("button", { name: "Preview matrix" }).click();
    await expect(page.getByRole("heading", { name: "Preview: 1 cells / 1 runs" })).toBeVisible();
    const expectedSource = value === "500" ? "startup_file" : "queued";
    await expect(page.locator(".preview-panel tbody tr")).toContainText(`-B ${value}`);
    await expect(page.locator(".preview-panel tbody tr")).toContainText(expectedSource);
    const submittedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/experiments/submit"
    );
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    const submission = await (await submittedResponse).json();
    const runId = String(submission.runs?.[0]?.id ?? submission.runs?.[0]?.runId);
    expect(runId).not.toBe("undefined");
    acceptanceRunIds.add(runId);
    runPairs.push({ runId, value });
    await page.goto(new URL("#queue", configuredUiUrl).href);
    await page.getByRole("button", { name: "Start eligible work" }).click();
    const runDir = path.join(artifactRoot, runId);
    // The startup capture checkpoint is written before the workload starts.
    await expect
      .poll(() => fs.existsSync(path.join(runDir, "db-parameter-snapshot.json")), {
        timeout: 120_000,
        intervals: [500, 1000]
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            new URL(`/api/v1/history/runs/${runId}`, configuredUiUrl).href
          );
          const state = response.ok() ? (await response.json()).run?.state : "unavailable";
          return [
            "SUCCEEDED",
            "INCOMPLETE",
            "FAILED",
            "CANCELLED",
            "INTERRUPTED",
            "THRESHOLD_FAILED"
          ].includes(state)
            ? state
            : "active";
        },
        { timeout: 600_000, intervals: [1000, 2000, 5000] }
      )
      .not.toBe("active");
    const terminalRun = await (
      await page.request.get(new URL(`/api/v1/runs/${runId}`, configuredUiUrl).href)
    ).json();
    // This short fixture verifies startup provenance; genuine measurement gaps remain visible.
    expect(["SUCCEEDED", "INCOMPLETE"]).toContain(terminalRun.state);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            new URL(`/api/v1/history/runs/${runId}`, configuredUiUrl).href
          );
          const detail = await response.json();
          const record = detail.artifacts?.find(
            (item: any) => item.kind === "run_comparison_summary"
          );
          return record
            ? JSON.parse(fs.readFileSync(path.join(artifactRoot, record.path), "utf8")).quality
                .cleanupStatus
            : "missing";
        },
        { timeout: 120_000, intervals: [500, 1000] }
      )
      .toBe("COMPLETE");
    const snapshotPath = path.join(runDir, "db-parameter-snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    expect(snapshot.status).toBe("complete");
    expect(snapshot.attemptedAt).toBeTruthy();
    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.verificationResults).toContainEqual(
      expect.objectContaining({
        name: "-B",
        displayValue: value,
        observedValue: value,
        verification: "matched"
      })
    );
    const bufferRow = snapshot.rows.find((row: any) => row.name === "-B");
    if (value === "3000" && !bufferRow) {
      // OpenEdge may mark 3000 as its default; only nondefault rows are published.
      expect(bufferRow).toBeUndefined();
    } else expect(bufferRow).toEqual(expect.objectContaining({ displayValue: value }));
    const currentResponse = await page.request.get(
      new URL(`/api/v1/history/runs/${runId}`, configuredUiUrl).href
    );
    const { summary, context } = await readCurrentRunArtifacts(
      await currentResponse.json(),
      artifactRoot,
      runId
    );
    expect(context.effective.databaseStartup.parameters).toContainEqual(
      expect.objectContaining({
        name: "-B",
        displayValue: value,
        source: expectedSource,
        verification: "matched"
      })
    );
    expect(context.parameterReference.state).toBe("captured");
    expect(context.observed.parameterSnapshotTelemetry.seriesCount).toBeGreaterThan(0);
    expect(
      context.observed.parameterSnapshotTelemetry.captureDurationSeconds
    ).toBeGreaterThanOrEqual(0);
    expect(summary.quality.cleanupStatus).toBe("COMPLETE");
    expect(summary.quality.complete).toBe(terminalRun.state === "SUCCEEDED");
    if (terminalRun.state === "INCOMPLETE")
      expect(summary.quality.requiredGaps.length).toBeGreaterThan(0);
    expect(summary.windows.measurement.state).toBe("completed");
    expect(summary.windows.measurement.start).toBeTruthy();
    const runEnd = summary.windows.run.end;
    expect(
      await prometheusHas(
        `parkbench_openedge_db_parameter_snapshot_status{run_id="${runId}",state="complete"}`,
        runEnd,
        true
      )
    ).toBe(true);
    if (bufferRow)
      expect(
        await prometheusHas(
          `parkbench_openedge_db_parameter_snapshot_info{run_id="${runId}",parameter="-B",display_value="${value}"}`,
          runEnd,
          true
        )
      ).toBe(true);
    const detailResponse = await page.request.get(
      new URL(`/api/v1/history/runs/${runId}`, configuredUiUrl).href
    );
    const detail = await detailResponse.json();
    const artifact = detail.artifacts.find((item: any) => item.kind === "db_parameter_snapshot");
    expect(artifact).toBeTruthy();
  }
  expect(runPairs.map((item) => item.value)).toEqual(["500", "1000", "2000", "3000"]);
  console.log(`licensed_startup_parameter_runs:${JSON.stringify(runPairs)}`);
});

for (const duringMeasurement of [false, true]) {
  test(`licensed cancellation ${duringMeasurement ? "during" : "before"} measurement retains one useful current summary and context`, async ({
    page
  }) => {
    test.setTimeout(240_000);
    await page.goto(new URL("#experiments", configuredUiUrl).href);
    const choices = page.getByRole("combobox");
    await choices
      .nth(0)
      .selectOption(await firstOptionValue(choices.nth(0), /parkbench-bank-mix\.json/));
    await chooseReadyOption(choices.nth(1));
    await chooseReadyOption(choices.nth(2));
    await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("500");
    await page
      .getByRole("textbox", { name: "Run name" })
      .fill(duringMeasurement ? "licensed-measured-cancel" : "licensed-early-cancel");
    await page.getByRole("button", { name: "Preview matrix" }).click();
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/experiments/submit"
    );
    await page.getByRole("button", { name: "Confirm and queue" }).click();
    const submission = await (await submitted).json(),
      id = String(submission.runs[0].id);
    acceptanceRunIds.add(id);
    await page.goto(new URL("#queue", configuredUiUrl).href);
    await page.getByRole("button", { name: "Start eligible work" }).click();
    const artifactRoot = path.resolve(
      repoRoot,
      process.env.PARKBENCH_ARTIFACT_ROOT || ".parkbench/artifacts"
    );
    await expect
      .poll(() => fs.existsSync(path.join(artifactRoot, id, "loadgen-summary.json")), {
        timeout: 120_000
      })
      .toBe(true);
    if (duringMeasurement) {
      await expect
        .poll(
          async () => {
            const run = await (
              await page.request.get(new URL(`/api/v1/runs/${id}`, configuredUiUrl).href)
            ).json();
            return run.state;
          },
          { timeout: 120_000 }
        )
        .toBe("MEASURING");
      await expect
        .poll(
          async () => {
            const run = await (
              await page.request.get(new URL(`/api/v1/runs/${id}`, configuredUiUrl).href)
            ).json();
            return Date.now() - Date.parse(run.measuringAt);
          },
          { timeout: 30_000 }
        )
        .toBeGreaterThan(10_000);
    }
    const cancelled = await page.request.post(
      new URL(`/api/v1/queue/runs/${id}/cancel`, configuredUiUrl).href,
      { headers: { "Idempotency-Key": crypto.randomUUID() }, data: {} }
    );
    expect(cancelled.ok()).toBeTruthy();
    await expect
      .poll(
        async () => {
          const run = await (
            await page.request.get(new URL(`/api/v1/runs/${id}`, configuredUiUrl).href)
          ).json();
          return { state: run.state, cleanup: run.cleanupStatus };
        },
        { timeout: 120_000 }
      )
      .toEqual({ state: "CANCELLED", cleanup: "COMPLETE" });
    const detail = await (
      await page.request.get(new URL(`/api/v1/history/runs/${id}`, configuredUiUrl).href)
    ).json();
    const { summary, context } = await readCurrentRunArtifacts(detail, artifactRoot, id);
    expect(summary.windows.measurement.state).toBe(
      duringMeasurement ? "interrupted" : "not_started"
    );
    if (duringMeasurement) {
      expect(summary.windows.measurement.start).toBeTruthy();
      expect(summary.windows.measurement.durationSeconds).toBeGreaterThan(0);
      expect(summary.windows.measurement.durationSeconds).toBeLessThan(300);
    } else expect(summary.windows.measurement.start).toBeNull();
    expect(summary.quality.complete).toBe(false);
    expect(summary.quality.cleanupStatus).toBe("COMPLETE");
    expect(context.runId).toBe(id);
    for (const retired of [
      "observer-report.json",
      "run-evidence.json",
      "phase-boundaries.json",
      "summary.json"
    ])
      expect(fs.existsSync(path.join(artifactRoot, id, retired))).toBe(false);
  });
}

/**
 * Whether Prometheus has the selector's series at `at` (an ISO time). With `anyTimeInRun`, it
 * looks back over the last hour, for series (like the startup snapshot) scraped before `at`.
 */
async function prometheusHas(selector: string, at: string, anyTimeInRun = false): Promise<boolean> {
  const url = new URL("/api/v1/query", prometheusUrl);
  url.searchParams.set("query", anyTimeInRun ? `last_over_time(${selector}[1h])` : selector);
  url.searchParams.set("time", String(Date.parse(at) / 1000));
  const body: any = await (await fetch(url)).json();
  return body.status === "success" && body.data.result.length > 0;
}

async function assertLoadedGrafanaScope(page: any, iframeSrc: string, context: any, runId: string) {
  const dashboardUid = new URL(iframeSrc).pathname.split("/")[2];
  let loadedUrl = "";
  await expect
    .poll(
      () => {
        const frame = page
          .frames()
          .find((candidate: any) =>
            new URL(candidate.url()).pathname.startsWith(`/d/${dashboardUid}`)
          );
        loadedUrl = frame?.url() ?? "";
        if (!loadedUrl) return false;
        const loaded = new URL(loadedUrl);
        // Grafana rewrites epoch parameters to absolute ISO timestamps after
        // loading the dashboard. Wait for that transition, not just iframe navigation.
        return Boolean(
          loaded.searchParams.get("from")?.includes("T") &&
          loaded.searchParams.get("to")?.includes("T")
        );
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  const loaded = new URL(loadedUrl);
  expect(loaded.searchParams.get("var-run_id")).toBe(runId);
  expect(loaded.searchParams.get("var-experiment_id")).toBe(context.experimentId);
  expect(Date.parse(loaded.searchParams.get("from") ?? "")).toBe(
    Date.parse(context.timeRange.from)
  );
  expect(Date.parse(loaded.searchParams.get("to") ?? "")).toBe(Date.parse(context.timeRange.to));
}

async function firstOptionValue(
  select: ReturnType<typeof pageLocator>,
  matcher: RegExp
): Promise<string> {
  await expect(select.getByRole("option", { name: matcher })).toHaveCount(1);
  const options = await optionValues(select);
  const match = options.find((option) => matcher.test(option.label));
  if (!match) throw new Error("licensed_parkbench_scenario_option_unavailable");
  return match.value;
}

async function chooseReadyOption(select: ReturnType<typeof pageLocator>) {
  await expect(select.locator("option")).not.toHaveCount(1);
  const options = await optionValues(select);
  const current = await select.inputValue();
  const selected = options.find((option) => option.value === current && current !== "");
  const chosen = selected ?? options.find((option) => option.value !== "");
  if (!chosen) throw new Error("licensed_ready_asset_option_unavailable");
  if (!selected) await select.selectOption(chosen.value);
  return chosen;
}

async function optionValues(select: ReturnType<typeof pageLocator>) {
  return select.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent?.trim() ?? ""
    }))
  );
}

function requireSetting(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`licensed_ui_setting_required:${name}`);
  return value;
}

function resolveSourcePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

type PageLocator = import("@playwright/test").Locator;
function pageLocator(select: PageLocator): PageLocator {
  return select;
}

async function readCurrentRunArtifacts(detail: any, root: string, runId: string) {
  // Cleanup is persisted before asynchronous context/summary publication. Wait for
  // the public publication contract, not terminal state alone, before reading files.
  await expect
    .poll(
      async () => {
        const response = await fetch(new URL(`/api/v1/history/runs/${runId}`, configuredUiUrl));
        expect(response.ok).toBeTruthy();
        detail = await response.json();
        return ["run_comparison_summary", "run_context"].map(
          (kind) => detail.artifacts.filter((item: any) => item.kind === kind).length
        );
      },
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .toEqual([1, 1]);
  const read = (kind: string) => {
    expect(detail.artifacts.filter((item: any) => item.kind === kind)).toHaveLength(1);
    const record = detail.artifacts.find((item: any) => item.kind === kind);
    expect(record).toBeTruthy();
    return JSON.parse(fs.readFileSync(path.join(root, record.path), "utf8"));
  };
  const summary = read("run_comparison_summary"),
    context = read("run_context");
  expect(summary.run.id).toBe(runId);
  expect(context.runId).toBe(runId);
  expect(fs.existsSync(path.join(root, runId, "run-evidence.json"))).toBe(false);
  return { summary, context };
}

test("licensed native database failure retains current summary and context before measurement", async ({
  page
}) => {
  test.setTimeout(240_000);
  await page.goto(new URL("#experiments", configuredUiUrl).href);
  const choices = page.getByRole("combobox");
  await choices
    .nth(0)
    .selectOption(await firstOptionValue(choices.nth(0), /parkbench-bank-mix\.json/));
  await chooseReadyOption(choices.nth(1));
  await chooseReadyOption(choices.nth(2));
  await page.getByRole("textbox", { name: "Parameter 1 values" }).fill("500");
  await page.getByRole("textbox", { name: "Run name" }).fill("licensed-database-failure");
  await page.getByRole("button", { name: "Preview matrix" }).click();
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/experiments/submit"
  );
  await page.getByRole("button", { name: "Confirm and queue" }).click();
  const id = String((await (await submitted).json()).runs[0].id);
  acceptanceRunIds.add(id);
  await page.goto(new URL("#queue", configuredUiUrl).href);
  await page.getByRole("button", { name: "Start eligible work" }).click();
  const { execFileSync } = await import("node:child_process");
  const docker = (...args: string[]) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL"
    }).trim();
  let databaseId = "";
  await expect
    .poll(
      () => {
        databaseId = docker(
          "ps",
          "-q",
          "--filter",
          `label=parkbench.run_id=${id}`,
          "--filter",
          "label=com.docker.compose.service=database"
        );
        const observers = docker(
          "ps",
          "-q",
          "--filter",
          `label=parkbench.run_id=${id}`,
          "--filter",
          "label=com.docker.compose.service=db-observer"
        );
        return Boolean(databaseId && observers);
      },
      { timeout: 120_000 }
    )
    .toBe(true);
  const labels = JSON.parse(docker("inspect", "--format", "{{json .Config.Labels}}", databaseId));
  expect(labels["parkbench.run_id"]).toBe(id);
  expect(labels["parkbench.managed"]).toBe("true");
  // Trigger a real readiness failure only in this test's fresh run-owned database.
  docker("stop", "--time", "2", databaseId);
  await expect
    .poll(
      async () => {
        const run = await (
          await page.request.get(new URL(`/api/v1/runs/${id}`, configuredUiUrl).href)
        ).json();
        return { state: run.state, cleanup: run.cleanupStatus };
      },
      { timeout: 120_000 }
    )
    .toEqual({ state: "FAILED", cleanup: "COMPLETE" });
  const detail = await (
    await page.request.get(new URL(`/api/v1/history/runs/${id}`, configuredUiUrl).href)
  ).json();
  expect(detail.run.failureCode).toBe("database_readiness_failed");
  const { summary, context } = await readCurrentRunArtifacts(
    detail,
    path.resolve(repoRoot, process.env.PARKBENCH_ARTIFACT_ROOT || ".parkbench/artifacts"),
    id
  );
  expect(summary.windows.measurement.state).toBe("not_started");
  expect(summary.windows.measurement.start).toBeNull();
  expect(summary.quality.complete).toBe(false);
  expect(summary.quality.cleanupStatus).toBe("COMPLETE");
  expect(context.runId).toBe(id);
});
