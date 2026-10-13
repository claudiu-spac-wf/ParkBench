import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { ComparisonSummaryService } from "../../apps/control-plane/src/runs/comparison-summary-service";
import { HistoricalSummaryWorker } from "../../apps/control-plane/src/runs/historical-summary-worker";
import { streamComparisonCsv } from "../../apps/control-plane/src/comparisons/export";
import { MeasurementFixtureClient } from "../helpers/measurement-fixture";
import { summaryRun } from "../helpers/summary";
for (const tables of [64, 1000])
  test(`production summary budgets: 15 minutes and ${tables} all-CRUD tables`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-performance-")),
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
    const run = {
      ...summaryRun(),
      startedAt: new Date(S * 1000).toISOString(),
      finishedAt: new Date((S + 900) * 1000).toISOString(),
      phaseBoundaries: {
        measurement: {
          startedAt: new Date(S * 1000).toISOString(),
          finishedAt: new Date((S + 900) * 1000).toISOString()
        }
      },
      environmentSnapshot: {
        sourceCadences: { prometheusScrapeSeconds: 5, nativeDatabaseRefreshSeconds: 5 },
        metricContracts: { nativeDb: "openedge-db-observer.v3" }
      }
    };
    r.saveRun(run);
    const prom = new MeasurementFixtureClient(run.id, S, tables),
      service = new ComparisonSummaryService(r, storage, prom, 5);
    let peak = process.memoryUsage().rss;
    const initial = peak,
      monitor = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 5);
    try {
      const began = performance.now(),
        prepared = await service.prepare(run, { origin: "new_run" });
      assert.equal(r.pageSummaryRows(run.id).rows.length, 0);
      await service.publish(run, prepared);
      const generationMs = performance.now() - began;
      const lookup = performance.now(),
        cache = r.getSummaryCache(run.id);
      const metadataMs = performance.now() - lookup;
      assert.equal(cache.status, "READY");
      assert.equal(cache.header.tableRowCount, tables * 5);
      assert.equal(cache.header.quality.complete, true);
      const last = r.pageSummaryRows(run.id, { tablesOnly: true, limit: 500 });
      assert.equal(last.rows.length, Math.min(500, tables * 5));
      assert.equal(
        r.findSummaryRow(
          run.id,
          JSON.stringify([
            "db.table.read",
            "database",
            "table_covered",
            "records_per_second",
            "records",
            [
              ["operation", "read"],
              ["table", `Table${String(tables - 1).padStart(4, "0")}`]
            ]
          ])
        )?.statistics.total?.value,
        900 * tables
      );
      const reader = {
        read: (id: string) => r.getSummaryCache(id),
        page: (id: string, o: any) => r.pageSummaryRows(id, o),
        find: (id: string, key: string) => r.findSummaryRow(id, key),
        iterate: (id: string) => r.iterateSummaryRows(id)
      };
      let csvRows = 0,
        lastSeen = false;
      for await (const chunk of streamComparisonCsv(
        { id: "budget", createdAt: "now", selectionRevision: 1, variantRunIds: [run.id] },
        reader
      )) {
        csvRows += chunk.split("\n").length - 1;
        lastSeen ||= chunk.includes(`Table${String(tables - 1).padStart(4, "0")}`);
      }
      assert.equal(csvRows, cache.header.totalRowCount + 1);
      assert.equal(lastSeen, true);
      const bytes = fs.statSync(storage.safePath(cache.artifactPath)).size;
      if (tables === 1000) {
        assert.ok(bytes > 2 * 1024 * 1024);
        assert.ok(cache.header.totalRowCount > 4096);
      }
      peak = Math.max(peak, process.memoryUsage().rss);
      assert.ok(generationMs < 30_000);
      assert.ok(metadataMs < 500);
      assert.ok(
        peak - initial < 128 * 1024 * 1024,
        `RSS growth ${(peak - initial) / 1024 / 1024} MiB exceeds the 128 MiB budget`
      );
      assert.ok(prom.maximumConcurrency <= 2);
      assert.ok(prom.maximumSamples <= 100_000);
      const pendingRun = { ...run, id: "pending-run", variantId: "pending-variant" };
      r.saveRun(pendingRun);
      const worker = new HistoricalSummaryWorker(r, service),
        pendingBegan = performance.now();
      worker.schedule(pendingRun.id);
      const pendingState = r.getSummaryCache(pendingRun.id);
      const pendingMs = performance.now() - pendingBegan;
      assert.equal(pendingState.status, "RECOMPUTING");
      assert.ok(pendingMs < 1000);
      worker.stop();
      console.log(
        JSON.stringify({
          pendingMs: Math.round(pendingMs),
          tables,
          generationMs: Math.round(generationMs),
          metadataMs: Math.round(metadataMs),
          rssGrowthMiB: Math.round((peak - initial) / 1024 / 1024),
          queryCount: prom.queryCount,
          concurrency: prom.maximumConcurrency,
          maximumRawSamples: prom.maximumSamples,
          artifactBytes: bytes,
          rows: cache.header.totalRowCount,
          csvRows
        })
      );
    } finally {
      clearInterval(monitor);
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
