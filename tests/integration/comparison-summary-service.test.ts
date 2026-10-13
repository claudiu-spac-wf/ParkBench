import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { ComparisonSummaryService } from "../../apps/control-plane/src/runs/comparison-summary-service";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { MeasurementFixtureClient } from "../helpers/measurement-fixture";
import { summaryRun } from "../helpers/summary";
import { buildRunContext, persistRunContext } from "../../apps/control-plane/src/runs/run-context";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-service-")),
    db = new DatabaseClient();
  db.migrate(
    fs
      .readdirSync("apps/control-plane/src/db/migrations")
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .map((n) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", n), "utf8"))
      .join("\n")
  );
  const r = new Repositories(db),
    storage = new ArtifactStorage(root),
    run = {
      ...summaryRun(),
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: "2026-09-30T00:00:02.000Z",
      phaseBoundaries: {
        measurement: {
          startedAt: "2026-09-30T00:00:00.000Z",
          finishedAt: "2026-09-30T00:00:02.000Z"
        }
      },
      environmentSnapshot: {
        scenario: { id: "sample" },
        effectiveConfiguration: { "-B": 100 },
        inputs: { seed: "/local/seed", password: "private-password" },
        deterministicLoadSeed: 234,
        metricContracts: { nativeDb: "openedge-db-observer.v3" },
        sourceCadences: { prometheusScrapeSeconds: 1, nativeDatabaseRefreshSeconds: 1 }
      }
    };
  r.saveRun(run);
  return {
    root,
    db,
    r,
    storage,
    run,
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
describe("real summary orchestration primitives", () => {
  it("carries recorded cAdvisor timestamp age into resource edge coverage", async () => {
    const f = fixture();
    try {
      const S = Date.parse(f.run.startedAt) / 1000;
      f.run.phaseBoundaries.measurement.finishedAt = new Date((S + 15.25) * 1000).toISOString();
      f.run.finishedAt = f.run.phaseBoundaries.measurement.finishedAt;
      Object.assign(f.run.environmentSnapshot.sourceCadences, {
        prometheusScrapeSeconds: 5,
        cadvisorHousekeepingSeconds: 1
      });
      f.r.saveRun(f.run);
      const samples: any[] = [];
      for (const group of ["platform", "database", "pas"]) {
        const member =
          group === "platform" ? "control-plane" : group === "pas" ? "pas-1" : "database";
        for (const t of [0, 5, 10])
          for (const [metricName, value] of [
            ["container_start_time_seconds", S - 10],
            ["container_cpu_usage_seconds_total", t],
            ["container_memory_working_set_bytes", 1000]
          ])
            samples.push({
              metricName,
              type: String(metricName).endsWith("total") ? "counter" : "gauge",
              timestamp: S + t,
              value,
              source: "fixture",
              labels: {
                id: "/docker/" + member,
                service: member,
                cpu: "total",
                job: group === "platform" ? "cadvisor" : "parkbench-run-owned-cadvisor",
                ...(group === "platform"
                  ? {
                      container_label_com_docker_compose_project: "parkbench-platform",
                      container_label_com_docker_compose_service: member
                    }
                  : { run_id: f.run.id })
              }
            });
      }
      const service = new ComparisonSummaryService(
        f.r,
        f.storage,
        new MemoryPrometheusClient(samples)
      );
      const prepared = await service.prepare(f.run, { origin: "new_run" });
      assert.equal(
        prepared.header.quality.requiredGaps.filter((gap: any) =>
          ["container_cpu_usage_seconds_total", "container_memory_working_set_bytes"].includes(
            gap.metricName
          )
        ).length,
        0,
        JSON.stringify(prepared.header.quality.requiredGaps)
      );
      assert.equal(prepared.header.sampling.sources[0].sourceTimestampLagSeconds, 1);
      await service.publish(f.run, prepared);
      const cpu = f.r
        .pageSummaryRows(f.run.id)
        .rows.find((r) => r.definitionId === "cpu.usage" && r.group === "pas");
      assert.equal(cpu?.coverage.missingSeconds, 0);
      assert.equal(cpu?.coverage.estimatedEdgeSeconds, 5.25);
      assert.equal(cpu?.statistics.average?.value, 100);
    } finally {
      f.close();
    }
  });
  it("reads native tables from the deployed parkbench-runs scrape job", async () => {
    const f = fixture();
    try {
      const client = new MeasurementFixtureClient(
        f.run.id,
        Date.parse(f.run.startedAt) / 1000,
        70,
        2
      );
      const service = new ComparisonSummaryService(f.r, f.storage, client, 1);
      const prepared = await service.prepare(f.run, { origin: "new_run" });
      assert.equal(prepared.header.expectedTableCount, 70);
      assert.equal(prepared.header.tableRowCount, 350);
      await service.publish(f.run, prepared);
    } finally {
      f.close();
    }
  });

  it("conserves requested/effective/observed context and stable artifact registration", () => {
    const f = fixture();
    try {
      const before = buildRunContext(f.run);
      assert.equal(before.inputs.seed, "/local/seed");
      assert.equal(before.inputs.password, "[REDACTED]");
      assert.equal(before.loadSeed, 234);
      const a = persistRunContext(f.run, f.storage, f.r);
      f.run.cleanupStatus = "FAILED";
      const next = persistRunContext(f.run, f.storage, f.r, true);
      assert.equal(next.id, a.id);
      assert.equal(f.r.listArtifacts(f.run.id).length, 1);
      const saved = JSON.parse(f.storage.read(next.path).toString());
      assert.equal(saved.observed.cleanupStatus, "FAILED");
      assert.ok(saved.finalizedAt);
    } finally {
      f.close();
    }
  });
  it("queries before cleanup, keeps staging private, and publishes terminal cleanup/context", async () => {
    const f = fixture();
    try {
      const S = Date.parse(f.run.startedAt) / 1000;
      const samples: any[] = [];
      for (const group of ["platform", "database", "pas"]) {
        const service =
            group === "database" ? "database" : group === "pas" ? "pas-1" : "control-plane",
          job = group === "platform" ? "cadvisor" : "parkbench-run-owned-cadvisor";
        for (const t of [0, 1, 2])
          for (const [metric, value] of [
            ["container_start_time_seconds", S - 10],
            ["container_cpu_usage_seconds_total", t * 0.2],
            ["container_memory_working_set_bytes", 1000]
          ])
            samples.push({
              metricName: metric,
              type: String(metric).includes("total") ? "counter" : "gauge",
              timestamp: S + t,
              value,
              source: "fixture",
              labels: {
                id: "/docker/" + service,
                service,
                job,
                cpu: "total",
                ...(group === "platform"
                  ? {
                      container_label_com_docker_compose_project: "parkbench-platform",
                      container_label_com_docker_compose_service: service
                    }
                  : { run_id: f.run.id })
              }
            });
      }
      const prometheus = new MemoryPrometheusClient(samples),
        service = new ComparisonSummaryService(f.r, f.storage, prometheus, 1);
      const prepared = await service.prepare(f.run, { origin: "new_run" });
      assert.equal(f.r.pageSummaryRows(f.run.id).rows.length, 0);
      prometheus.fail = true;
      f.run.cleanupStatus = "COMPLETE";
      await service.publish(f.run, prepared);
      assert.equal(f.r.getSummaryCache(f.run.id).status, "READY");
      const cpu = f.r
        .pageSummaryRows(f.run.id)
        .rows.find((r) => r.definitionId === "cpu.usage" && r.group === "database");
      assert.equal(cpu?.statistics.average?.value, 20);
      assert.equal(f.r.getSummaryCache(f.run.id).header?.quality.cleanupStatus, "COMPLETE");
      assert.equal(
        f.r.listArtifacts(f.run.id).filter((a) => a.kind === "run_comparison_summary").length,
        1
      );
      assert.deepEqual(f.r.getRun(f.run.id).summary, { old: true });
    } finally {
      f.close();
    }
  });
  it("publishes a useful minimal not-started summary without making raw queries", async () => {
    const f = fixture();
    try {
      delete (f.run as any).phaseBoundaries;
      f.run.state = "FAILED";
      const p = new MemoryPrometheusClient([], true),
        service = new ComparisonSummaryService(f.r, f.storage, p, 1),
        prepared = await service.prepare(f.run, { origin: "new_run" });
      await service.publish(f.run, prepared);
      const saved = f.r.getSummaryCache(f.run.id);
      assert.equal(saved.status, "READY");
      assert.equal(saved.header?.windows.measurement.state, "not_started");
      assert.equal(saved.header?.metricsReference.queries.length, 0);
    } finally {
      f.close();
    }
  });
  it("publishes a not-started failure even when loadgen only created an empty summary file", async () => {
    const f = fixture();
    try {
      delete (f.run as any).phaseBoundaries;
      f.run.state = "FAILED";
      f.storage.write(`${f.run.id}/loadgen-summary.json`, "");
      const service = new ComparisonSummaryService(
        f.r,
        f.storage,
        new MemoryPrometheusClient([], true),
        1
      );
      const prepared = await service.prepare(f.run, { origin: "new_run" });
      await service.publish(f.run, prepared);
      assert.equal(f.r.getSummaryCache(f.run.id).status, "READY");
      assert.equal(f.r.getSummaryCache(f.run.id).header?.windows.measurement.state, "not_started");
      assert.deepEqual(f.r.getSummaryCache(f.run.id).header?.workload, {
        availability: "not_collected",
        reason: "loadgen_summary_empty"
      });
      assert.equal(
        f.r.listArtifacts(f.run.id).filter((a) => a.kind === "run_comparison_summary").length,
        1
      );
    } finally {
      f.close();
    }
  });
});
