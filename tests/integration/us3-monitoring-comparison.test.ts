export * from "./terminal-paths.test";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { Finalizer } from "../../apps/control-plane/src/runs/finalizer";
import { SavedSummaryQueries } from "../../apps/control-plane/src/grafana/summary-results";
import { buildComparison } from "../../apps/control-plane/src/comparisons/service";
import { streamComparisonCsv } from "../../apps/control-plane/src/comparisons/export";
import { MeasurementFixtureClient } from "../helpers/measurement-fixture";
import { summaryRun } from "../helpers/summary";
test("terminal production finalizer, saved artifact, comparison, CSV and Grafana share values after series expiry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-equality-")),
    db = new DatabaseClient();
  db.migrate(
    fs
      .readdirSync("apps/control-plane/src/db/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", f), "utf8"))
      .join("\n")
  );
  const r = new Repositories(db),
    storage = new ArtifactStorage(root),
    S = Date.parse("2026-09-30T00:00:00Z") / 1000;
  const reader = {
    read: (id: string) => r.getSummaryCache(id),
    page: (id: string, o: any) => r.pageSummaryRows(id, o),
    find: (id: string, key: string) => r.findSummaryRow(id, key),
    iterate: (id: string) => r.iterateSummaryRows(id)
  };
  try {
    for (const state of [
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "INTERRUPTED",
      "INCOMPLETE"
    ] as const) {
      const run = {
        ...summaryRun(state),
        variantId: state,
        state: "FINALIZING" as const,
        startedAt: new Date(S * 1000).toISOString(),
        phaseBoundaries: {
          measurement: {
            startedAt: new Date(S * 1000).toISOString(),
            finishedAt: new Date((S + 10) * 1000).toISOString()
          }
        },
        environmentSnapshot: {
          contextContractVersion: "run-context.v1",
          sourceCadences: { prometheusScrapeSeconds: 1, nativeDatabaseRefreshSeconds: 1 },
          metricContracts: { nativeDb: "openedge-db-observer.v3" }
        }
      };
      r.saveRun(run);
      const prom = new MeasurementFixtureClient(run.id, S, 70, 10),
        finalizer = new Finalizer(r, storage, prom, 1);
      const terminal = await finalizer.finalize(run, {
        terminalState: state,
        start: S,
        end: S + 10,
        measurementState: ["FAILED", "CANCELLED", "INTERRUPTED"].includes(state)
          ? "interrupted"
          : "completed",
        cleanup: () => {
          assert.ok(prom.queryCount > 0);
          assert.equal(r.pageSummaryRows(run.id).rows.length, 0);
          prom.fail = true;
        }
      });
      assert.equal(terminal.state, state);
      const cache = r.getSummaryCache(run.id);
      assert.equal(cache.status, "READY");
      assert.equal(cache.header.quality.cleanupStatus, "COMPLETE");
      const artifact = JSON.parse(fs.readFileSync(storage.safePath(cache.artifactPath), "utf8"));
      assert.equal(artifact.rows.length, cache.header.totalRowCount);
      const comparison = buildComparison(
        {
          id: "same-values",
          createdAt: "now",
          selectionRevision: 1,
          baselineRunId: "SUCCEEDED",
          variantRunIds: state === "SUCCEEDED" ? [] : [state]
        },
        reader,
        (id: string) => r.getRun(id)
      );
      const compared = comparison.runs.find((item) => item.runId === state)!,
        cpu = compared.rows.find(
          (item) => item.row.definitionId === "cpu.usage" && item.row.group === "database"
        )!;
      const disk = artifact.rows.find(
        (row: any) => row.definitionId === "cpu.usage" && row.group === "database"
      );
      assert.deepEqual(cpu.row, disk);
      assert.equal(cpu.row.statistics.average.value, 150);
      assert.equal(cpu.row.statistics.total.value, 15);
      assert.equal(cpu.differences.average.absoluteDifference, state === "SUCCEEDED" ? null : 0);
      assert.equal(compared.measurementValidity, cache.header.run.measurementValidity);
      const plotted = await new SavedSummaryQueries(reader).query(
        state,
        new Map([
          ["scope", "resource"],
          ["group", "database"],
          ["definition", "cpu.usage"]
        ]),
        946684800000
      );
      assert.equal(plotted.find((item) => item.metric.statistic === "average").value[1], "150");
      assert.equal(plotted.find((item) => item.metric.statistic === "total").value[1], "15");
      assert.equal(plotted[0].metric.window_start, cache.header.windows.measurement.start);
      let csv = "";
      for await (const chunk of streamComparisonCsv(
        { id: "same-values", createdAt: "now", selectionRevision: 1, variantRunIds: [state] },
        reader
      ))
        csv += chunk;
      const line = csv
        .split("\n")
        .find((line) => line.includes(`database,${disk.displayName},resource`));
      assert.ok(line?.includes("percent_one_core,cpu_seconds,150,150,150,15"));
      assert.equal(csv.split("\n").length - 2, cache.header.totalRowCount);
      assert.equal(fs.existsSync(path.join(root, state, "summary.json")), false);
      assert.equal(fs.existsSync(path.join(root, state, "run-evidence.json")), false);
    }
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
