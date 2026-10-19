import { expect, test } from "@playwright/test";
import { createControlUiFixture } from "../fixtures/control-ui";
import { installControlUiFixture, seedTerminalMatrix } from "./support/control-ui-fixture";
import { COMPARISON_METRIC_CATALOG } from "../../packages/contracts/src/comparison-metric-selection";
import {
  aligned,
  box,
  evidence,
  frameGeometry,
  layoutWidths,
  noPageOverflow
} from "./support/ui-layout";

test("metric rows align, explain unsupported choices, and preserve independent selections", async ({
  page
}, testInfo) => {
  const fixture = await createControlUiFixture();
  const memory = COMPARISON_METRIC_CATALOG.find(
    (item) => item.metricId === "resource.platform.memory.used"
  )!;
  const latency = COMPARISON_METRIC_CATALOG.find(
    (item) => item.metricId === "workload.latency.p95"
  )!;
  try {
    const seeded = await seedTerminalMatrix(fixture);
    await installControlUiFixture(page, fixture);
    await page.goto(`/#comparison/${seeded.experimentId}`);
    await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
    await page.getByRole("button", { name: "Create comparison", exact: true }).click();
    await page.getByRole("button", { name: "Choose metrics", exact: true }).click();
    await page.getByRole("textbox", { name: "Find metrics", exact: true }).fill("Used memory");
    await expect(page.locator(".metric-choice-row")).toHaveCount(3);
    for (const width of layoutWidths) {
      await page.setViewportSize({ width, height: 900 });
      for (const row of await page.locator(".metric-choice-row").all()) {
        await expect(row.locator(".metric-stat label")).toHaveText([
          "Avg:",
          "p90:",
          "p95:",
          "Total:"
        ]);
        if (width >= 1280)
          await aligned([
            row.locator(".metric-name"),
            ...(await row.locator(".metric-stat label").all())
          ]);
      }
      if (width >= 1280) {
        const rows = await page.locator(".metric-choice-row").all();
        for (let column = 0; column < 4; column++) {
          const positions = await Promise.all(
            rows.map((row) => box(row.locator(".metric-stat input").nth(column)))
          );
          expect(
            Math.max(...positions.map((rect) => rect.x)) -
              Math.min(...positions.map((rect) => rect.x))
          ).toBeLessThanOrEqual(1);
        }
      }
      await noPageOverflow(page);
      await evidence(page, testInfo, `us2/${width}`);
    }
    const total = page.getByRole("checkbox", { name: `${memory.displayName} total`, exact: true });
    await expect(total).toBeDisabled();
    await expect(total).not.toBeChecked();
    const help = page.getByRole("button", {
      name: `Help for ${memory.displayName} total`,
      exact: true
    });
    await help.hover();
    await expect(page.getByRole("tooltip")).toContainText("does not support Total");
    await page.keyboard.press("Escape");
    await help.focus();
    await expect(page.getByRole("tooltip")).toContainText("does not support Total");
    await page.keyboard.press("Escape");
    const average = page.getByRole("checkbox", {
      name: `${memory.displayName} average`,
      exact: true
    });
    await average.focus();
    await page.keyboard.press("Space");
    await expect(average).not.toBeChecked();
    await page.getByText("Avg:", { exact: true }).first().click();
    await expect(average).toBeChecked();
    await average.uncheck();
    await page.getByRole("checkbox", { name: `${memory.displayName} p90`, exact: true }).uncheck();
    await page.getByRole("checkbox", { name: `${memory.displayName} p95`, exact: true }).uncheck();
    await expect(
      page.getByRole("checkbox", { name: memory.displayName, exact: true })
    ).not.toBeChecked();
    const inactiveHelp = page.getByRole("button", {
      name: `Help for ${memory.displayName} average`,
      exact: true
    });
    await inactiveHelp.focus();
    await expect(page.getByRole("tooltip")).toContainText("Enable this metric");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("checkbox", { name: "Database · Used memory", exact: true })
    ).toBeChecked();
    await page.getByRole("textbox", { name: "Find metrics", exact: true }).fill("Latency p95");
    await page.getByRole("checkbox", { name: latency.displayName, exact: true }).check();
    const value = page.getByRole("checkbox", { name: `${latency.displayName} value`, exact: true });
    await expect(value).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: `${latency.displayName} p95`, exact: true })
    ).toBeDisabled();
    await value.uncheck();
    await expect(
      page.getByRole("checkbox", { name: latency.displayName, exact: true })
    ).toBeFocused();
    await page
      .getByRole("textbox", { name: "Find metrics", exact: true })
      .fill("db tables aggregate create");
    await expect(page.locator(".metric-choice-row")).toHaveCount(1);
    await page.setViewportSize({ width: 375, height: 900 });
    await noPageOverflow(page);
  } finally {
    await fixture.close();
  }
});

for (const width of layoutWidths) {
  test(`scheduling controls align and reflow at ${width}`, async ({ page }, testInfo) => {
    const fixture = await createControlUiFixture();
    try {
      await installControlUiFixture(page, fixture);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#experiments");
      await expect(
        page.getByRole("combobox", { name: "Parameter 1 name", exact: true })
      ).toBeEnabled();
      await page.getByRole("button", { name: "Add dimension", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Parameter 2 name", exact: true })
        .selectOption("-diagPrefix");
      // A wrapping catalog explanation must not influence the control track.
      await page
        .locator(".parameter-summary")
        .nth(1)
        .evaluate((node) => {
          node.textContent =
            "A longer parameter explanation that wraps across several lines while the controls retain their alignment. ".repeat(
              3
            );
        });
      if (width >= 1280) {
        for (let index = 1; index <= 2; index++) {
          const row = page.locator(".dimension-row").nth(index - 1);
          await aligned([
            page.getByRole("combobox", { name: `Parameter ${index} name`, exact: true }),
            page.getByRole("textbox", { name: `Parameter ${index} values`, exact: true }),
            row.getByRole("button", { name: "Remove", exact: true })
          ]);
        }
        const first = await box(
          page.getByRole("combobox", { name: "Parameter 1 name", exact: true })
        );
        const second = await box(
          page.getByRole("combobox", { name: "Parameter 2 name", exact: true })
        );
        expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
      }
      await noPageOverflow(page);
      await evidence(page, testInfo, "us1");
    } finally {
      await fixture.close();
    }
  });
}

test("shared dashboard embeds expose 1080 pixels in every host and viewport", async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createControlUiFixture();
  try {
    const seeded = await seedTerminalMatrix(fixture);
    await installControlUiFixture(page, fixture);
    await page.route("**/api/v1/dashboards/context/**", (route) =>
      route.fulfill({
        json: {
          id: new URL(route.request().url()).pathname.split("/").at(-1),
          availability: "available",
          runIds: [seeded.runIds[0]],
          variables: { run_id: [seeded.runIds[0]], phase: ["measurement"] },
          timeRange: { from: "2026-10-01T10:00:00Z", to: "2026-10-01T10:05:00Z" },
          grafanaUrl: "http://grafana.fixture"
        }
      })
    );
    await page.route("http://grafana.fixture/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Deterministic dashboard geometry fixture</h1>"
      })
    );
    for (const host of ["saved", "run", "comparison"]) {
      if (host === "saved") await page.goto("/#dashboards/layout-context");
      else if (host === "run") await page.goto(`/#runs/${seeded.runIds[0]}`);
      else {
        await page.goto(`/#comparison/${seeded.experimentId}`);
        await page.getByRole("button", { name: "Select all candidates", exact: true }).click();
        await page.getByRole("button", { name: "Create comparison", exact: true }).click();
      }
      const frame = page.getByTitle("ParkBench Grafana dashboard");
      await expect(frame).toBeVisible({ timeout: 15_000 });
      const src = new URL((await frame.getAttribute("src"))!);
      expect(src.searchParams.get("var-run_id")).toBe(seeded.runIds[0]);
      for (const width of layoutWidths) {
        await page.setViewportSize({ width, height: 700 });
        const geometry = await frameGeometry(frame);
        expect(geometry.minimum).toBeGreaterThanOrEqual(1080);
        expect(geometry.height).toBeGreaterThanOrEqual(1080);
        expect(geometry.clipping).toEqual([]);
        await frame.evaluate((element) => element.scrollIntoView({ block: "end" }));
        const rectangle = await frame.boundingBox();
        expect(rectangle!.y + rectangle!.height).toBeLessThanOrEqual(701);
        await evidence(page, testInfo, `us3/${host}/${width}`);
      }
    }
  } finally {
    await fixture.close();
  }
});

test("primary navigation identifies the current page and overview health reflows", async ({
  page
}, testInfo) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture);
    for (const [route, label] of [
      ["overview", "Overview"],
      ["catalog", "Catalog"],
      ["experiments", "Schedule"],
      ["queue", "Queue"],
      ["comparison", "Comparisons"],
      ["history", "History"]
    ]) {
      await page.goto(`/#${route}`);
      await expect(page.locator(".nav [aria-current='page']")).toHaveCount(1);
      await expect(
        page.locator(".nav").getByRole("link", { name: label, exact: true })
      ).toHaveAttribute("aria-current", "page");
    }
    await page.goto("/#overview");
    await expect(page.getByText("Last health check", { exact: true })).toBeVisible();
    for (const width of layoutWidths) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
      const timestamp = page
        .locator(".health-card")
        .filter({ hasText: "Last health check" })
        .locator("strong");
      const bounds = await box(timestamp);
      const parent = await box(timestamp.locator(".."));
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(parent.x + parent.width);
    }
    await evidence(page, testInfo, "review-primary/verified");
  } finally {
    await fixture.close();
  }
});

test("dashboard secondary actions and picker remain consistent and reachable", async ({
  page
}, testInfo) => {
  const fixture = await createControlUiFixture();
  try {
    await installControlUiFixture(page, fixture, {
      grafanaDashboards: [
        { uid: "summary", title: "Run Summary", folderTitle: "Resources" },
        { uid: "host", title: "Host Resources", folderTitle: "Resources" }
      ]
    });
    await page.route("**/api/v1/dashboards/context/review", (route) =>
      route.fulfill({
        json: {
          id: "review",
          availability: "available",
          runIds: ["run-review"],
          variables: { run_id: ["run-review"] },
          grafanaUrl: "http://grafana.fixture",
          timeRange: { from: "2026-10-01T10:00:00Z", to: "2026-10-01T10:05:00Z" }
        }
      })
    );
    await page.route("http://grafana.fixture/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Geometry fixture</h1>" })
    );
    await page.goto("/#dashboards/review");
    const next = page.getByRole("button", { name: "Next dashboard", exact: true });
    const previous = page.getByRole("button", { name: "Previous dashboard", exact: true });
    const direct = page.getByRole("link", { name: "Open Grafana", exact: true });
    await next.click();
    await expect(
      page.getByRole("combobox", { name: "Grafana dashboard", exact: true })
    ).toHaveValue("host");
    await previous.click();
    await page.mouse.move(0, 0);
    const background = await direct.evaluate((e) => getComputedStyle(e).backgroundColor);
    for (const action of [next, previous])
      expect(await action.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(background);
    for (const width of layoutWidths) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
      await next.focus();
      await expect(next).toBeFocused();
    }
    await evidence(page, testInfo, "review-contextual/verified");
  } finally {
    await fixture.close();
  }
});

test("queue and history distinguish pending and failed reads from empty results", async ({
  page
}) => {
  for (const [route, endpoint, loading, empty] of [
    [
      "queue",
      "queue",
      "Loading run queue…",
      "The queue is empty. Preview a matrix to schedule work."
    ],
    ["history", "history/runs", "Loading run history…", "No run history yet."]
  ]) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1/${endpoint}**`, async (request) => {
      await held;
      await request.fulfill({ status: 503, json: { error: "review_unavailable" } });
    });
    await page.goto(`/#${route}`);
    await expect(page.getByText(loading, { exact: true })).toBeVisible();
    await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByText(loading, { exact: true })).toHaveCount(0);
    await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
    await page.unroute(`**/api/v1/${endpoint}**`);
  }
});
