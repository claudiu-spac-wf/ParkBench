import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { startFixtureGrafana } from "../integration/dashboards/support/fixture-grafana";
import { stagedDashboardFiles, generatedDashboards, panelsOf } from "./dashboards";

export async function renderBenchmarkDashboards(options: {
  runId: string;
  port: string;
  prometheusUrl: string;
  start: number;
  end: number;
  directory: string;
}) {
  const prometheusPort = new URL(options.prometheusUrl).port || "9090";
  const grafana = await startFixtureGrafana(stagedDashboardFiles(), {
    datasources: `apiVersion: 1\ndatasources:\n  - name: Prometheus\n    uid: prometheus\n    type: prometheus\n    access: proxy\n    url: http://host.docker.internal:${prometheusPort}\n    isDefault: true\n  - name: ParkBench Runs\n    uid: parkbench-runs\n    type: prometheus\n    access: proxy\n    url: http://host.docker.internal:${options.port}/api/v1/grafana/prom\n`
  });
  const browser = await chromium.launch({ headless: true });
  const panels: any[] = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}` }
    });
    const responses: any[] = [];
    page.on("response", async (response) => {
      if (!response.url().includes("/api/ds/query")) return;
      try {
        responses.push({ status: response.status(), body: await response.json() });
      } catch {}
    });
    for (const uid of ["parkbench-database-activity", "parkbench-database-recovery-concurrency"]) {
      const dashboard = generatedDashboards()[uid];
      const chosen = panelsOf(dashboard)
        .filter(
          ({ panel }) =>
            panel.type === "timeseries" &&
            (uid.includes("recovery") ||
              /active buffers|free buffers|capacity|cache hit/i.test(panel.title))
        )
        .slice(0, 4);
      assert.equal(chosen.length, 4);
      for (const { panel } of chosen) {
        const query = new URLSearchParams({
          from: String(options.start),
          to: String(options.end),
          "var-run_id": options.runId,
          "var-phase": "$__all",
          panelId: String(panel.id)
        });
        await page.goto(`${grafana.url}/d-solo/${uid}/native?${query}`);
        await page.getByRole("table").waitFor({ timeout: 20000 });
        const legend = await page.getByRole("table").boundingBox(),
          plot = await page.locator(".uplot").boundingBox();
        assert.ok(
          legend && plot && legend.x >= plot.x + plot.width - 2,
          panel.title + ": right-side legend"
        );
        const rows = await page.getByRole("table").locator("tbody tr").allTextContents();
        assert.equal(rows.length, 1, panel.title + ": one true native identity");
        const screenshot = path.join(options.directory, uid + "-" + panel.id + ".png");
        await page.screenshot({ path: screenshot });
        panels.push({
          dashboard: dashboard.title,
          title: panel.title,
          rows,
          plot,
          legend,
          screenshot
        });
      }
    }
    assert.ok(responses.length >= 8);
    assert.ok(
      responses.every(
        (r) =>
          r.status === 200 &&
          Object.values(r.body.results ?? {}).every((value: any) => !value.error)
      )
    );
    const evidence = {
      runId: options.runId,
      source: "Real native production run, Prometheus, Grafana12.1.1 and production datasource",
      panels,
      responses
    };
    fs.writeFileSync(
      path.join(options.directory, "rendered-dashboards.json"),
      JSON.stringify(evidence, null, 2)
    );
    return evidence;
  } finally {
    await browser.close();
    grafana.stop();
  }
}
