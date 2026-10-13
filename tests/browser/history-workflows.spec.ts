import { expect, Page, test } from "@playwright/test";

async function installHistory(page: Page, onList?: (url: URL) => void) {
  await page.route("**/api/v1/history/runs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/run_keyboard")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        run: { id: "run_keyboard", state: "SUCCEEDED", measurementValidity: "VALID", cleanupStatus: "COMPLETE", completeness: { complete: true, requiredGaps: [] } },
        artifacts: [], events: []
      }) });
      return;
    }
    onList?.(url);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      items: [{ id: "run_keyboard", scenario: { id: "parkbench-bank-mix", version: "1" }, status: "SUCCEEDED", evidence: { cleanupStatus: "COMPLETE" } }]
    }) });
  });
}

test("history exposes a keyboard reachable run detail action", async ({ page }) => {
  await installHistory(page);
  await page.goto("/#history");
  const inspect = page.getByRole("button", { name: "Inspect run_keyboard" });
  await expect(inspect).toBeVisible();
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("State: SUCCEEDED")).toBeVisible();
});

test("history applies combined filters only when Apply filters is used", async ({ page }) => {
  const requests: string[] = [];
  await installHistory(page, (url) => requests.push(url.search));
  await page.goto("/#history");
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole("combobox").first().selectOption("SUCCEEDED");
  await page.getByRole("textbox", { name: "Scenario filter" }).fill("sports@1");
  await page.getByRole("textbox", { name: "Workload filter" }).fill("crud_cycle.p");
  await page.getByRole("textbox", { name: "Image filter" }).fill("openedge-db");
  await page.getByRole("textbox", { name: "Parameter filter" }).fill("-B=500");
  await page.getByRole("textbox", { name: "Repetition filter" }).fill("2");
  await page.locator('input[type="datetime-local"]').nth(0).fill("2026-09-01T00:00");
  await page.locator('input[type="datetime-local"]').nth(1).fill("2026-09-27T23:59");
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toContain("status=SUCCEEDED");
  expect(requests[1]).toContain("scenario=sports%401");
  for (const key of ["workload=", "image=", "parameter=", "repetition=2", "from=", "to="])
    expect(requests[1]).toContain(key);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toBe("");
});

test("history paginates retained runs and downloads a selected artifact", async ({ page }) => {
  const tokens: string[] = [];
  await page.route("**/api/v1/history/runs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/run_one")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({
        run: { id: "run_one", state: "SUCCEEDED", measurementValidity: "VALID", cleanupStatus: "COMPLETE", completeness: { complete: true, requiredGaps: [] } },
        artifacts: [{ id: "art_one", kind: "run_evidence", downloadUrl: "/api/v1/runs/run_one/artifacts/art_one" }],
        dashboardContexts: [{ id: "dash_one" }], events: []
      }) });
      return;
    }
    tokens.push(url.searchParams.get("pageToken") ?? "");
    const second = Boolean(url.searchParams.get("pageToken"));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      items: [{ id: second ? "run_two" : "run_one", scenario: { id: "parkbench-bank-mix", version: "1" }, status: "SUCCEEDED" }],
      nextPageToken: second ? undefined : "next"
    }) });
  });
  await page.route("**/api/v1/runs/run_one/artifacts/art_one", (route) => route.fulfill({
    contentType: "application/octet-stream",
    headers: { "content-disposition": 'attachment; filename="run-one-evidence.json"' },
    body: "{}"
  }));
  await page.goto("/#history");
  await page.getByRole("button", { name: "Load more history" }).click();
  await expect(page.getByRole("button", { name: "Inspect run_two" })).toBeVisible();
  expect(tokens).toEqual(["", "next"]);
  await page.getByRole("button", { name: "Inspect run_one" }).click();
  await expect(page.getByRole("link", { name: "Open dashboard dash_one" })).toHaveAttribute("href", "#dashboards/dash_one");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "run_evidence artifact" }).click()
  ]);
  expect(download.suggestedFilename()).toBe("run-one-evidence.json");
});

test("history retries a failed list without clearing the filters", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/v1/history/runs**", async (route) => {
    requests += 1;
    await route.fulfill(requests === 1
      ? { status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "history offline" } }) }
      : { contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.goto("/#history");
  await expect(page.getByRole("alert")).toContainText("history offline");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText("No run history yet.")).toBeVisible();
});
