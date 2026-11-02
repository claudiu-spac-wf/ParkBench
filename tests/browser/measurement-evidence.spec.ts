import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
test("history discovers and downloads retained diagnostics without scheduling or replaying a workload", async ({
  page
}) => {
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/")) mutations.push(r.url());
  });
  await page.route("**/api/v1/history/runs**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        route.request().url().endsWith("/run-evidence")
          ? {
              run: {
                id: "run-evidence",
                state: "SUCCEEDED",
                measurementValidity: "VALID",
                cleanupStatus: "COMPLETE"
              },
              events: [],
              artifacts: [
                {
                  id: "manifest",
                  kind: "diagnostics",
                  sourceMetadata: {
                    contractVersion: "measurement-diagnostics.v1",
                    attemptId: "attempt-1",
                    role: "manifest"
                  },
                  downloadUrl: "/api/v1/runs/run-evidence/artifacts/manifest"
                }
              ]
            }
          : {
              items: [
                {
                  id: "run-evidence",
                  status: "SUCCEEDED",
                  scenario: { id: "public", version: "1" }
                }
              ]
            }
      )
    })
  );
  await page.route("**/api/v1/runs/run-evidence/artifacts/manifest", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      headers: { "content-disposition": 'attachment; filename="measurement-diagnostics.json"' },
      body: JSON.stringify({
        contractVersion: "measurement-diagnostics.v1",
        recordingState: "SEALED",
        diagnosticAttemptId: "attempt-1"
      })
    })
  );
  await page.goto("/#history");
  await page.getByRole("button", { name: "Inspect run-evidence" }).click();
  await expect(page.getByText("State: SUCCEEDED")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "diagnostics artifact" }).click()
  ]);
  expect(download.suggestedFilename()).toBe("measurement-diagnostics.json");
  expect(JSON.parse(await fs.readFile((await download.path())!, "utf8")).diagnosticAttemptId).toBe(
    "attempt-1"
  );
  await page.reload();
  await page.getByRole("button", { name: "Inspect run-evidence" }).click();
  await expect(page.getByRole("link", { name: "diagnostics artifact" })).toBeVisible();
  expect(mutations).toEqual([]);
});
test("rendered capture fixtures preserve zero/unavailability/gaps and reject missing or mismatched query proof", async ({
  page
}, testInfo) => {
  const { validateChartCapture } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-charts.mjs")
  );
  await page.setContent(
    '<main><section aria-label="Fixture measurements"><svg width="600" height="180" role="img" aria-label="Zero reading and a real missing interval"><path d="M0 90 H180 M300 90 H600" stroke="black"/><text x="15" y="60">0 requests/s</text><text x="190" y="130">Unavailable: source gap</text></svg></section></main>'
  );
  await expect(page.getByText("0 requests/s", { exact: true })).toBeVisible();
  await expect(page.getByText("Unavailable: source gap")).toBeVisible();
  const screenshot = testInfo.outputPath("zero-and-gap.png");
  await page.getByRole("region", { name: "Fixture measurements" }).screenshot({ path: screenshot });
  const expected = {
    runId: "fixture-run",
    dashboardUid: "fixture-dashboard",
    panelId: "7",
    phase: "measurement",
    startMs: 1000,
    endMs: 11000,
    timezone: "UTC",
    origin: "FIXTURE"
  };
  const capture = {
    contractVersion: "measurement-chart-capture.v1",
    ...expected,
    recordedAtMs: Date.now(),
    viewport: { width: 600, height: 180, deviceScaleFactor: 1 },
    screenshot,
    inspectorScreenshot: screenshot,
    inspector: { executed: true, startMs: 1000, endMs: 11000, queryCount: 1, refIds: ["A"] },
    queries: [
      {
        refId: "A",
        datasourceUid: "parkbench-runs",
        stepMs: 5000,
        queryId: "query-1",
        queryMode: "EVALUATION_GRID",
        requestedStartMs: 1000,
        requestedEndMs: 11000,
        sourceEvidenceComplete: true
      }
    ],
    rendered: { zeroValues: 1, nullValues: 1, pointCount: 2 },
    complete: true
  };
  expect(validateChartCapture(capture, expected)).toEqual(capture);
  for (const changed of [
    { ...capture, screenshot: null },
    { ...capture, runId: "other-run" },
    { ...capture, queries: [] },
    { ...capture, inspector: { ...capture.inspector, executed: false } },
    { ...capture, queries: [{ ...capture.queries[0], stepMs: null }] }
  ])
    expect(() => validateChartCapture(changed, expected)).toThrow();
});
