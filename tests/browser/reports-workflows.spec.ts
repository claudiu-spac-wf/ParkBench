import { test, expect } from "@playwright/test";
test("Reports accepts all tools, creates independently and survives refresh", async ({ page }) => {
  let submissions = 0;
  const report = {
    id: "fixture-report",
    state: "QUEUED",
    type: "DBANALYS",
    seedSnapshot: { name: "fixture", databaseName: "db" },
    executionSnapshot: {
      image: "db:12.8.11",
      options: ["-csoutput", "-fieldsep", ",", "-verbose", "-csfilePrefix", "report"],
      mounts: []
    },
    createdAt: "2026-10-19T12:00:00Z",
    startedAt: null,
    finishedAt: null,
    warnings: [],
    failure: null,
    cleanupState: "PENDING",
    projectionState: "PENDING",
    datasets: [],
    artifacts: []
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let body: any = { items: [], hasMore: false };
    if (url.pathname.endsWith("catalog/assets"))
      body = {
        items: [
          {
            id: "seed",
            kind: "seed",
            name: "fixture",
            verificationState: "VERIFIED",
            readiness: "READY",
            availability: "AVAILABLE"
          }
        ]
      };
    else if (route.request().method() === "POST") {
      submissions++;
      body = { report };
    } else if (url.pathname.endsWith("fixture-report")) body = { report };
    else if (url.pathname.endsWith("summary")) body = { status: "PENDING" };
    await route.fulfill({ json: body });
  });
  await page.goto("/#reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await page.getByLabel("Database seed").selectOption("seed");
  for (const type of ["IDXANALYS", "TABANALYS", "DBANALYS"])
    await page.getByLabel("Report type").selectOption(type);
  await page.getByRole("button", { name: "Generate report" }).click();
  await expect(page.getByRole("heading", { name: "DBANALYS report" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("QUEUED", { exact: true })).toBeVisible();
  expect(submissions).toBe(1);
  await expect(page.getByText(/no automatic time limit/i)).toBeVisible();
});
test("cleanup failure retains running state, pending outcome and retry time until recovery", async ({
  page
}) => {
  let cancelled = 0;
  const report: any = {
    id: "cleanup-report",
    state: "RUNNING",
    type: "TABANALYS",
    seedSnapshot: { name: "fixture", databaseName: "db" },
    executionSnapshot: {
      image: "db:12.8.11",
      options: ["-csoutput", "-fieldsep", ",", "-verbose", "-csfilePrefix", "report"],
      mounts: []
    },
    createdAt: "2026-10-19T12:00:00Z",
    startedAt: "2026-10-19T12:00:00Z",
    finishedAt: null,
    cancelRequestedAt: null,
    warnings: [],
    failure: null,
    cleanupState: "PENDING",
    projectionState: "PENDING",
    datasets: [],
    artifacts: []
  };
  await page.route("**/api/v1/reports/**", async (route) => {
    if (route.request().method() === "POST") {
      cancelled++;
      report.cancelRequestedAt = "2026-10-19T12:05:00Z";
      if (cancelled === 1) {
        report.cleanupState = "FAILED";
        report.pendingTerminalState = "CANCELLED";
        report.cleanupRetryAt = "2026-10-19T12:05:05Z";
      } else {
        report.state = "CANCELLED";
        report.cleanupState = "CONFIRMED";
        report.pendingTerminalState = null;
        report.cleanupRetryAt = null;
      }
    }
    await route.fulfill({ json: { report } });
  });
  await page.goto("/#reports/cleanup-report");
  await page.getByRole("button", { name: "Cancel report", exact: true }).click();
  await expect(page.getByText(/Capacity remains reserved/)).toBeVisible();
  await expect(page.getByText(/Pending outcome: CANCELLED/)).toBeVisible();
  await expect(page.getByText(/2026-10-19T12:05:05Z/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry cancellation" })).toBeVisible();
  await page.getByRole("button", { name: "Retry cancellation" }).click();
  await expect(page.getByText("CANCELLED", { exact: true })).toBeVisible();
  expect(cancelled).toBe(2);
});
