import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Gated live check of the end goal (feature 014): three runs of parkbench-bank-mix scheduled
 * through the control-plane API against the default seed all complete with zero failed
 * operations, ParkBenchDB table labels and a recorded seed identity. Needs the licensed
 * platform running (scripts/bootstrap.sh) and PARKBENCH_RUN_OPENEDGE_TESTS=1.
 */
const liveEnabled = Boolean(process.env.PARKBENCH_RUN_OPENEDGE_TESTS);
const baseUrl = process.env.PARKBENCH_LIVE_CONTROL_PLANE_URL ?? "http://127.0.0.1:13000";
const artifactRoot = path.resolve(
  process.env.PARKBENCH_LIVE_ARTIFACT_ROOT ?? ".parkbench/artifacts"
);
const prometheusUrl = process.env.PARKBENCH_PROMETHEUS_URL ?? "http://127.0.0.1:19090";
const TERMINAL = new Set([
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);

/** Table labels of the run's table metrics, read from Prometheus at the end of its measurement. */
async function runTableLabels(runId: string, at: string): Promise<Set<string>> {
  const query = `count by (table) (parkbench_openedge_db_table_operations_total{run_id="${runId}"})`;
  const url = new URL("/api/v1/query", prometheusUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("time", String(Date.parse(at) / 1000));
  const body: any = await (await fetch(url)).json();
  return new Set(body.data.result.map((series: any) => series.metric.table));
}

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${pathname}:${response.status}:${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

describe("ParkBench bank mix live runs", () => {
  it(
    "schedules three runs against the default seed and each completes as expected",
    { skip: !liveEnabled, timeout: 3_600_000 },
    async () => {
      const seedName = process.env.PARKBENCH_OPENEDGE_DEFAULT_SEED ?? "one_gb_lnx";
      const sources = await api("/api/v1/catalog/assets?category=scenarios");
      const source = sources.items.find(
        (item: any) => item.relativePath === "parkbench-bank-mix.json"
      );
      assert.ok(source, "parkbench-bank-mix scenario source is listed");
      const archives = await api("/api/v1/catalog/assets?kind=archive");
      const archive = archives.items.find((item: any) => item.readiness === "READY");
      assert.ok(archive, "a ready runner archive is listed");
      const runName = `parkbench-live-test-${Date.now()}`;
      const preview = await api("/api/v1/experiments/preview", {
        method: "POST",
        body: JSON.stringify({
          runName,
          scenarioSourceId: source.id,
          dimensions: [],
          repetitions: 3,
          inputs: { seed: `input:seeds/${seedName}`, applicationArchive: archive.immutableRef }
        })
      });
      assert.equal(preview.runCount, 3);
      const experiment = await api("/api/v1/experiments/submit", {
        method: "POST",
        headers: { "idempotency-key": runName },
        body: JSON.stringify({ previewId: preview.previewId, confirm: true })
      });
      await api("/api/v1/queue/start", {
        method: "POST",
        headers: { "idempotency-key": `${runName}-start` },
        body: "{}"
      });
      const deadline = Date.now() + 3_300_000;
      let runs: any[] = [];
      while (Date.now() < deadline) {
        runs = await Promise.all(
          experiment.runs.map((run: any) =>
            api(`/api/v1/runs/${run.id}`).then((body) => body.run ?? body)
          )
        );
        if (runs.every((run) => TERMINAL.has(run.state))) break;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      for (const run of runs) {
        assert.equal(
          run.state,
          "SUCCEEDED",
          `${run.id}: ${run.failureCode ?? ""} ${run.failureReason ?? ""}`
        );
        const summary = JSON.parse(
          fs.readFileSync(path.join(artifactRoot, run.id, "loadgen-summary.json"), "utf8")
        );
        assert.ok(summary.phaseResults.measurement.requests > 0);
        assert.equal(summary.phaseResults.measurement.failures, 0);
        for (const operation of ["reference-point", "selective", "range", "audit-write-cycle"])
          assert.ok(summary.operations[operation].completed > 0, operation);
        const evidence = JSON.parse(
          fs.readFileSync(path.join(artifactRoot, run.id, "run-evidence.json"), "utf8")
        );
        assert.equal(evidence.inputs.seed.name, seedName);
        assert.equal(evidence.inputs.seed.databaseName, "parkbench");
        assert.ok(Number.isFinite(evidence.inputs.seed.copySeconds), "seed copy time recorded");
        assert.equal(evidence.workload.selectedProcedure, "Workloads/ParkBench/bank_mix.p");
        // Run series stay in Prometheus (constitution 4.0.0); the evidence records where.
        assert.equal(evidence.metrics.source, "prometheus");
        assert.equal(
          fs.existsSync(path.join(artifactRoot, run.id, "raw-prometheus.jsonl.gz")),
          false
        );
        const tables = await runTableLabels(run.id, evidence.metrics.measurementWindow.end);
        for (const table of ["DebitTransaction", "CustomerContact", "AuditLog"])
          assert.ok(tables.has(table), table);
      }
    }
  );
});
