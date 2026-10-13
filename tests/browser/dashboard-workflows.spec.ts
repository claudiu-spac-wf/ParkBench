import { expect, test } from "@playwright/test";

test("the retired dashboard directory redirects to History", async ({ page }) => {
  await page.goto("/#dashboards");
  await expect(page).toHaveURL(/#history$/);
  await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
});

test("a saved dashboard link retries detail and lists every Grafana dashboard in Grafana's order", async ({
  page
}) => {
  await page.clock.install();
  let contextReads = 0;
  await page.route("**/api/v1/dashboards/context/context_good", (route) => {
    contextReads += 1;
    return route.fulfill(
      contextReads === 1
        ? {
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "context offline" } })
          }
        : {
            contentType: "application/json",
            body: JSON.stringify({
              id: "context_good",
              runIds: ["run_good"],
              availability: "available",
              variables: {
                run_id: ["run_good"],
                experiment_id: ["exp_dashboard"],
                phase: ["measurement"]
              },
              timeRange: { from: "2026-09-26T08:00:00.000Z", to: "2026-09-26T08:01:00.000Z" },
              grafanaUrl: "http://127.0.0.1:13001"
            })
          }
    );
  });
  // Grafana's order, deliberately not alphabetical: the UI keeps it as returned.
  await page.route("**/grafana-api/search?type=dash-db", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { uid: "second-dashboard", title: "Second dashboard", type: "dash-db" },
        { uid: "alternate-first", title: "Alternate first", type: "dash-db" },
        { uid: "alternate-second", title: "Alternate second", type: "dash-db" }
      ])
    })
  );
  await page.goto("/#dashboards/context_good");
  await expect(page).toHaveURL(/#dashboards\/context_good$/);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  const picker = page.getByRole("combobox", { name: "Grafana dashboard" });
  await expect(picker).toHaveValue("second-dashboard");
  await expect(picker.locator("option")).toHaveText([
    "Second dashboard",
    "Alternate first",
    "Alternate second"
  ]);
  await picker.selectOption("alternate-first");
  const iframe = page.getByTitle("ParkBench Grafana dashboard");
  await expect(iframe).toHaveAttribute("src", /\/d\/alternate-first\?/);
  const source = new URL((await iframe.getAttribute("src"))!);
  const direct = page.getByRole("link", { name: "Open Grafana" });
  await expect(direct).toHaveAttribute("href", source.toString());
  await expect(direct).toHaveAttribute("target", "_blank");
  await expect(direct).toHaveAttribute("rel", "noopener noreferrer");
  expect(source.searchParams.get("var-run_id")).toBe("run_good");
  expect(source.searchParams.get("var-experiment_id")).toBe("exp_dashboard");
  expect(source.searchParams.get("var-phase")).toBe("measurement");
  expect(source.searchParams.get("from")).toBe(String(Date.parse("2026-09-26T08:00:00.000Z")));
  expect(source.searchParams.get("to")).toBe(String(Date.parse("2026-09-26T08:01:00.000Z")));
  await page.getByRole("button", { name: "Next dashboard" }).click();
  await expect(iframe).toHaveAttribute("src", /\/d\/alternate-second\?/);
  await expect(picker).toHaveValue("alternate-second");
  const next = new URL((await iframe.getAttribute("src"))!);
  expect(next.search).toBe(source.search);
  await expect(direct).toHaveAttribute("href", next.toString());
  await page.clock.fastForward("10:00");
  await expect(iframe).toHaveAttribute("src", next.toString());
  await expect(page.getByRole("link", { name: "Open run history" })).toHaveAttribute(
    "href",
    "#history"
  );
});

test("an unavailable dashboard keeps its stored-context explanation without an iframe", async ({
  page
}) => {
  await page.route("**/api/v1/dashboards/context/context_unavailable", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "context_unavailable",
        availability: "unavailable",
        runIds: ["run_old"]
      })
    })
  );
  await page.route("**/grafana-api/search?type=dash-db", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([])
    })
  );
  await page.goto("/#dashboards/context_unavailable");
  await expect(page.getByText(/Grafana is unavailable for 1 selected run/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Grafana" })).toHaveCount(0);
  await expect(page.getByTitle("ParkBench Grafana dashboard")).toHaveCount(0);
});

test("a dashboard list failure can be retried without losing the selected run", async ({
  page
}) => {
  await page.route("**/api/v1/dashboards/context/context_retry", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "context_retry",
        availability: "available",
        runIds: ["run_retry"],
        variables: { run_id: ["run_retry"] },
        grafanaUrl: "http://127.0.0.1:13001"
      })
    })
  );
  let listReads = 0;
  await page.route("**/grafana-api/search?type=dash-db", (route) => {
    listReads += 1;
    return route.fulfill(
      listReads === 1
        ? {
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "unavailable" })
          }
        : {
            contentType: "application/json",
            body: JSON.stringify([
              { uid: "recovered-dashboard", title: "Recovered", type: "dash-db" }
            ])
          }
    );
  });
  await page.goto("/#dashboards/context_retry");
  await expect(page.getByText("Grafana dashboards could not be loaded.")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  const iframe = page.getByTitle("ParkBench Grafana dashboard");
  await expect(iframe).toHaveAttribute("src", /\/d\/recovered-dashboard\?/);
  expect(new URL((await iframe.getAttribute("src"))!).searchParams.get("var-run_id")).toBe(
    "run_retry"
  );
  expect(listReads).toBe(2);
});

test("parameter dashboard link carries only selected runs and the absolute comparison window", async ({
  page
}) => {
  await page.route("**/api/v1/dashboards/context/parameter-comparison", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "parameter-comparison",
        availability: "available",
        runIds: ["run-500", "run-1000", "run-2000"],
        variables: {
          experiment_id: ["exp-parameters"],
          run_id: ["run-500", "run-1000", "run-2000"],
          phase: ["idle"]
        },
        timeRange: { from: "2026-09-28T08:00:00.000Z", to: "2026-09-28T09:00:00.000Z" },
        grafanaUrl: "http://127.0.0.1:13001"
      })
    })
  );
  await page.route("**/grafana-api/search?type=dash-db", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { uid: "parkbench-database-parameters", title: "Database parameters", type: "dash-db" }
      ])
    })
  );
  await page.goto("/#dashboards/parameter-comparison");
  const iframe = page.getByTitle("ParkBench Grafana dashboard");
  await expect(iframe).toHaveAttribute("src", /\/d\/parkbench-database-parameters\?/);
  const url = new URL((await iframe.getAttribute("src"))!);
  const direct = page.getByRole("link", { name: "Open Grafana" });
  await expect(direct).toHaveAttribute("href", url.toString());
  expect(url.searchParams.getAll("var-run_id")).toEqual(["run-500", "run-1000", "run-2000"]);
  expect(url.searchParams.getAll("var-run_id")).not.toContain("run-3000");
  expect(url.searchParams.getAll("var-experiment_id")).toEqual(["exp-parameters"]);
  expect(url.searchParams.getAll("var-phase")).toEqual(["idle"]);
  expect(url.searchParams.get("from")).toBe(String(Date.parse("2026-09-28T08:00:00.000Z")));
  expect(url.searchParams.get("to")).toBe(String(Date.parse("2026-09-28T09:00:00.000Z")));
});

test("folder groups preserve discovery order and remembered overview resolves to Run Summary", async ({
  page
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem(
      "parkbench-selected-grafana-dashboard",
      "parkbench-benchmark-overview"
    )
  );
  await page.route("**/api/v1/dashboards/context/folders", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "folders",
        availability: "available",
        runIds: ["a", "b"],
        variables: { run_id: ["a", "b"], phase: ["measurement"] },
        grafanaUrl: "http://127.0.0.1:13001",
        alignedTimeRange: { from: 946684800000, to: 946684920000 }
      })
    })
  );
  await page.route("**/grafana-api/search?type=dash-db", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          uid: "parkbench-database-concurrency",
          title: "Database transactions, locks, and latches",
          folderTitle: "Database",
          folderUid: "db"
        },
        {
          uid: "parkbench-pas-instances",
          title: "PAS Instances",
          folderTitle: "PAS",
          folderUid: "pas"
        },
        {
          uid: "parkbench-run-summary",
          title: "Run Summary",
          folderTitle: "Resources",
          folderUid: "resources"
        },
        {
          uid: "parkbench-host-resources",
          title: "Host Resources",
          folderTitle: "Resources",
          folderUid: "resources"
        },
        {
          uid: "parkbench-database-activity",
          title: "Database Activity",
          folderTitle: "Database",
          folderUid: "db"
        }
      ])
    })
  );
  await page.goto("/#dashboards/folders");
  const picker = page.getByRole("combobox", { name: "Grafana dashboard" });
  await expect(picker).toHaveValue("parkbench-run-summary");
  expect(
    await picker
      .locator("optgroup")
      .evaluateAll((groups) => groups.map((g) => g.getAttribute("label")))
  ).toEqual(["Resources", "Database", "PAS"]);
  await expect(picker.locator("option")).toHaveText([
    "Run Summary",
    "Host Resources",
    "Database transactions, locks, and latches",
    "Database Activity",
    "PAS Instances"
  ]);
  await page.getByRole("button", { name: "Next dashboard" }).click();
  await expect(picker).toHaveValue("parkbench-host-resources");
  await page.getByRole("button", { name: "Next dashboard" }).click();
  await expect(picker).toHaveValue("parkbench-database-concurrency");
  const url = new URL((await page.getByTitle("ParkBench Grafana dashboard").getAttribute("src"))!);
  expect(url.searchParams.get("from")).toBe("946684800000");
  expect(url.searchParams.getAll("var-run_id")).toEqual(["a", "b"]);
  expect(url.searchParams.get("var-phase")).toBe("measurement");
});
