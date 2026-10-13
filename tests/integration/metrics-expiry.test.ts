import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { MeasurementFixtureClient } from "../helpers/measurement-fixture";
import { summaryRun } from "../helpers/summary";
import { ComparisonSummaryService } from "../../apps/control-plane/src/runs/comparison-summary-service";
import { createGrafanaDatasource } from "../../apps/control-plane/src/grafana/prom-api";

test("current summaries survive expiry and metrics/dashboard charts report it explicitly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-expiry-"));
  const start = Date.parse("2020-01-01T00:00:00Z") / 1000;
  const client = new MeasurementFixtureClient("expired-current", start, 1, 10);
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://prometheus",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true, prometheus: client }
  );
  const run = {
    ...summaryRun("expired-current"),
    summary: undefined,
    startedAt: new Date(start * 1000).toISOString(),
    finishedAt: new Date((start + 10) * 1000).toISOString(),
    phaseBoundaries: {
      measurement: {
        startedAt: new Date(start * 1000).toISOString(),
        finishedAt: new Date((start + 10) * 1000).toISOString()
      }
    },
    environmentSnapshot: { sourceCadences: { prometheusScrapeSeconds: 1 } }
  };
  platform.repositories.saveRun(run);
  const service = new ComparisonSummaryService(platform.repositories, platform.storage, client, 1);
  const app = buildServer(platform);
  try {
    const prepared = await service.prepare(run, { origin: "new_run" });
    await service.publish(run, prepared);
    const saved = platform.repositories.pageSummaryRows(run.id).rows;
    assert.ok(saved.some((r) => r.statistics.average?.value !== null));
    client.queryRawRange = async () => [];
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${run.id}/metrics?instant=false`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().metricsAvailability, "expired");
    const context = platform.controlUi.createDashboard({
      runIds: [run.id],
      metricScope: ["workload"]
    });
    const view = await platform.controlUi.getDashboardForUi(context.id);
    assert.equal(view?.availability, "expired");
    assert.equal(view?.health?.metricsAvailability?.[run.id], "expired");
    assert.deepEqual(platform.repositories.pageSummaryRows(run.id).rows, saved);
    assert.equal(platform.repositories.getSummaryCache(run.id)?.status, "READY");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Grafana empty retained-series charts report expiry, while optional empty charts and service failures stay distinct", async () => {
  for (const availability of ["expired", "available", "unavailable", "not_started"] as const) {
    const datasource = createGrafanaDatasource({
      prometheusUrl: "http://prometheus",
      timelines: {
        get: (id) => ({
          runId: id,
          phases: [],
          measurementStart: Date.parse("2020-01-01T00:00:00Z")
        }),
        list: () => []
      },
      fetch: async () =>
        new Response(
          JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })
        ),
      metricsAvailability: async () => ({ r: availability })
    });
    const result = await datasource.dataQuery(
      new URLSearchParams({
        query: 'container_memory_working_set_bytes{run_id="r"}',
        start: "1577836800",
        end: "1577836810",
        step: "1"
      }),
      false
    );
    if (availability === "expired" || availability === "unavailable") {
      assert.equal(result.status, 410);
      assert.equal(
        (result.body as any).errorType,
        availability === "expired" ? "metrics_expired" : "metrics_unavailable"
      );
    } else {
      assert.equal(result.status, 200);
      assert.deepEqual((result.body as any).data.result, []);
    }
  }
});
