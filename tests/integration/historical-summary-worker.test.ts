import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { ComparisonSummaryService } from "../../apps/control-plane/src/runs/comparison-summary-service";
import { HistoricalSummaryWorker } from "../../apps/control-plane/src/runs/historical-summary-worker";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { summaryRun as originalRun } from "../helpers/summary";
const summaryRun = (id: string) => ({
  ...originalRun(id),
  variantId: id,
  state: "FAILED" as const,
  environmentSnapshot: { metrics: { measurement: { state: "not_started" } } }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-history-")),
    c = new DatabaseClient();
  c.migrate(
    fs
      .readdirSync("apps/control-plane/src/db/migrations")
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .map((n) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", n), "utf8"))
      .join("\n")
  );
  const r = new Repositories(c),
    p = new MemoryPrometheusClient(),
    s = new ComparisonSummaryService(r, new ArtifactStorage(root), p, 1),
    w = new HistoricalSummaryWorker(r, s);
  return {
    root,
    c,
    r,
    p,
    s,
    w,
    close() {
      w.stop();
      c.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
it("queues a run/version once, uses one worker and reuses READY without raw queries", async () => {
  const f = fixture();
  try {
    for (const id of ["a", "b"]) f.r.saveRun(summaryRun(id));
    let active = 0,
      peak = 0,
      calls = 0;
    const original = f.s.prepare.bind(f.s);
    f.s.prepare = async (...args) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      try {
        return await original(...args);
      } finally {
        active--;
      }
    };
    f.w.schedule("a");
    f.w.schedule("a");
    f.w.schedule("b");
    assert.equal(f.r.getSummaryCache("a")?.status, "RECOMPUTING");
    await f.w.idle();
    assert.equal(peak, 1);
    assert.equal(calls, 2);
    assert.equal(f.r.getSummaryCache("a")?.status, "READY");
    f.w.schedule("a");
    await f.w.idle();
    assert.equal(calls, 2);
    assert.deepEqual(f.r.getRun("a")?.summary, { old: true });
  } finally {
    f.close();
  }
});
it("recovers expired attempts, preserves version isolation and refuses active runs", async () => {
  const f = fixture();
  try {
    f.r.saveRun(summaryRun("expired"));
    const old = f.r.claimSummaryAttempt("expired");
    f.c.db.exec("UPDATE run_comparison_summaries SET lease_until=0");
    f.r.saveRun({ ...summaryRun("active"), state: "MEASURING" });
    f.w.schedule("active");
    assert.equal(f.r.getSummaryCache("active"), undefined);
    f.w.recover();
    await f.w.idle();
    assert.equal(f.r.getSummaryCache("expired")?.status, "READY");
    assert.notEqual(f.r.getSummaryCache("expired")?.attemptToken, old);
  } finally {
    f.close();
  }
});
it("classifies missing boundaries as LEGACY and total source failure as retryable UNAVAILABLE", async () => {
  const f = fixture();
  try {
    const boundary = { ...summaryRun("boundary"), measuringAt: "2026-09-30T00:00:00.000Z" };
    f.r.saveRun(boundary);
    const empty = {
      ...summaryRun("empty"),
      phaseBoundaries: {
        measurement: {
          startedAt: "2026-09-30T00:00:00.000Z",
          finishedAt: "2026-09-30T00:00:02.000Z"
        }
      }
    };
    f.r.saveRun(empty);
    f.p.fail = true;
    f.w.schedule("boundary");
    f.w.schedule("empty");
    await f.w.idle();
    assert.equal(f.r.getSummaryCache("boundary")?.status, "LEGACY");
    assert.equal(f.r.getSummaryCache("empty")?.status, "UNAVAILABLE");
    assert.equal(f.r.getSummaryCache("empty")?.retryable, true);
    const token = f.r.getSummaryCache("empty")?.attemptToken;
    f.w.schedule("empty");
    await f.w.idle();
    assert.equal(f.r.getSummaryCache("empty")?.attemptToken, token);
    assert.equal(f.r.listArtifacts("empty").length, 0);
  } finally {
    f.close();
  }
});

import { MeasurementFixtureClient } from "../helpers/measurement-fixture";
it("historical resources plus a failed native database query publish reusable READY partial rows and preserve originals", async () => {
  const f = fixture(),
    S = Date.parse("2026-09-30T00:00:00Z") / 1000;
  try {
    const run = {
      ...summaryRun("partial"),
      phaseBoundaries: {
        measurement: {
          startedAt: new Date(S * 1000).toISOString(),
          finishedAt: new Date((S + 10) * 1000).toISOString()
        }
      }
    };
    f.r.saveRun(run);
    fs.mkdirSync(path.join(f.root, run.id));
    const original = path.join(f.root, run.id, "summary.json");
    fs.writeFileSync(original, '{"old_sum":999}');
    const client = new MeasurementFixtureClient(run.id, S, 2, 10);
    f.p.queryRawRange = async (...args) => {
      if (args[0].startsWith("parkbench_openedge_db_")) throw new Error("source_unavailable");
      return client.queryRawRange(...args);
    };
    f.w.schedule(run.id);
    await f.w.idle();
    const cache = f.r.getSummaryCache(run.id);
    assert.equal(cache.status, "READY");
    const rows = f.r.pageSummaryRows(run.id, { limit: 500 }).rows;
    assert.equal(
      rows.find((r) => r.definitionId === "cpu.usage" && r.group === "database")?.statistics.average
        ?.value,
      150
    );
    assert.ok(
      rows.some(
        (r) =>
          r.definitionId.startsWith("db.") &&
          r.statistics.average?.value === null &&
          r.statistics.average?.reasons.includes("source_unavailable")
      )
    );
    assert.ok(cache.header.metricsReference.queries.some((q) => q.outcome === "unavailable"));
    assert.equal(fs.readFileSync(original, "utf8"), '{"old_sum":999}');
    assert.deepEqual(f.r.getRun(run.id).summary, { old: true });
    const calls = client.queryCount;
    client.fail = true;
    f.w.schedule(run.id);
    await f.w.idle();
    assert.equal(client.queryCount, calls);
    assert.equal(f.r.getSummaryCache(run.id).attemptToken, cache.attemptToken);
  } finally {
    f.close();
  }
});
