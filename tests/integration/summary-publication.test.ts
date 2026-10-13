import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { summaryHeader, summaryRow } from "../helpers/summary";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { summaryRun } from "../helpers/summary";
describe("immutable summary publication", () => {
  it("writes one durable validated artifact and atomically publishes only its current attempt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-test-"));
    const c = new DatabaseClient();
    c.db.exec("PRAGMA foreign_keys=ON");
    c.migrate(
      fs
        .readdirSync("apps/control-plane/src/db/migrations")
        .filter((x) => x.endsWith(".sql"))
        .sort()
        .map((x) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", x), "utf8"))
        .join("\n")
    );
    const r = new Repositories(c);
    r.saveRun(summaryRun());
    const token = r.claimSummaryAttempt("run-test");
    r.stageSummaryRows("run-test", "measurement-summary.v1", token, [summaryRow("A")]);
    const h = { ...summaryHeader(), totalRowCount: 1, tableRowCount: 1 };
    const s = new ArtifactStorage(root);
    const a = await s.writeSummaryAttempt(
      h,
      r.iterateStagedSummaryRows("run-test", "measurement-summary.v1", token),
      token
    );
    assert.equal(r.pageSummaryRows("run-test").rows.length, 0);
    r.publishSummary("run-test", "measurement-summary.v1", token, h, a);
    assert.equal(r.getSummaryCache("run-test").status, "READY");
    assert.equal(r.pageSummaryRows("run-test").rows.length, 1);
    assert.equal(r.findSummaryRow("run-test", summaryRow("A").rowKey).statistics.total.value, 10);
    assert.equal(r.listArtifacts("run-test").length, 1);
    assert.equal(JSON.parse(s.read(a.path).toString()).rows.length, 1);
    await assert.rejects(() =>
      s.writeSummaryAttempt(
        h,
        (async function* () {
          yield summaryRow("B");
        })(),
        token
      )
    );
    assert.throws(() => r.publishSummary("run-test", "measurement-summary.v1", "stale", h, a));
    assert.equal(r.listArtifacts("run-test").length, 1);
    c.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("never registers temporary/invalid streams or missing files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-fail-"));
    const s = new ArtifactStorage(root);
    await assert.rejects(() =>
      s.writeSummaryAttempt(
        { ...summaryHeader(), totalRowCount: 2 },
        (async function* () {
          yield summaryRow();
        })(),
        "token"
      )
    );
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "run-test/summaries/measurement-summary.v1/token/comparison-summary.v1.json"
        )
      ),
      false
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("publication failure boundaries", () => {
  for (const operation of ["open", "rename"] as const)
    it(`does not publish after ${operation} failure`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-io-"));
      const storage = new ArtifactStorage(root);
      const original = fs.promises[operation];
      (fs.promises as any)[operation] = async () => {
        throw new Error("injected_" + operation);
      };
      try {
        await assert.rejects(
          () => storage.writeSummaryAttempt(summaryHeader(), (async function* () {})(), "attempt"),
          new RegExp("injected_" + operation)
        );
        assert.equal(
          fs.existsSync(
            path.join(
              root,
              "run-test/summaries/measurement-summary.v1/attempt/comparison-summary.v1.json"
            )
          ),
          false
        );
      } finally {
        (fs.promises as any)[operation] = original;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  it("rolls back artifact registration and keeps a durable orphan for a current-token retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-register-"));
    const c = new DatabaseClient();
    c.migrate(
      fs
        .readdirSync("apps/control-plane/src/db/migrations")
        .filter((x) => x.endsWith(".sql"))
        .sort()
        .map((x) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", x), "utf8"))
        .join("\n")
    );
    const r = new Repositories(c);
    r.saveRun(summaryRun());
    const t = r.claimSummaryAttempt("run-test");
    const s = new ArtifactStorage(root);
    const artifact = await s.writeSummaryAttempt(
      summaryHeader(),
      r.iterateStagedSummaryRows("run-test", "measurement-summary.v1", t),
      t
    );
    const original = r.saveArtifact;
    r.saveArtifact = () => {
      throw new Error("injected_registration");
    };
    assert.throws(
      () => r.publishSummary("run-test", "measurement-summary.v1", t, summaryHeader(), artifact),
      /injected_registration/
    );
    assert.equal(r.getSummaryCache("run-test").status, "RECOMPUTING");
    assert.equal(r.listArtifacts("run-test").length, 0);
    assert.ok(fs.existsSync(s.safePath(artifact.path)));
    r.saveArtifact = original;
    r.publishSummary("run-test", "measurement-summary.v1", t, summaryHeader(), artifact);
    assert.equal(r.getSummaryCache("run-test").status, "READY");
    assert.equal(r.listArtifacts("run-test").length, 1);
    r.saveRun({ ...summaryRun(), summary: { original: "preserved" } });
    assert.equal(r.getSummaryCache("run-test").status, "READY");
    assert.equal(r.claimSummaryAttempt("run-test"), undefined);
    assert.equal(r.claimSummaryAttempt("run-test", "measurement-summary.v2") !== undefined, true);
    assert.equal(r.getSummaryCache("run-test").status, "READY");
    c.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("cannot publish a durable file after its attempt was replaced", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-stale-"));
    const c = new DatabaseClient();
    c.migrate(
      fs
        .readdirSync("apps/control-plane/src/db/migrations")
        .filter((x) => x.endsWith(".sql"))
        .sort()
        .map((x) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", x), "utf8"))
        .join("\n")
    );
    const r = new Repositories(c);
    r.saveRun(summaryRun());
    const t = r.claimSummaryAttempt("run-test");
    const s = new ArtifactStorage(root);
    const old = await s.writeSummaryAttempt(
      summaryHeader(),
      r.iterateStagedSummaryRows("run-test", "measurement-summary.v1", t),
      t
    );
    c.db.prepare("UPDATE run_comparison_summaries SET lease_until=0").run();
    const next = r.claimSummaryAttempt("run-test");
    const fresh = await s.writeSummaryAttempt(
      summaryHeader(),
      r.iterateStagedSummaryRows("run-test", "measurement-summary.v1", next),
      next
    );
    r.publishSummary("run-test", "measurement-summary.v1", next, summaryHeader(), fresh);
    assert.throws(
      () => r.publishSummary("run-test", "measurement-summary.v1", t, summaryHeader(), old),
      /summary_attempt_stale/
    );
    assert.equal(r.getSummaryCache("run-test").artifactPath, fresh.path);
    assert.equal(r.listArtifacts("run-test").length, 1);
    c.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

import { ComparisonSummaryService } from "../../apps/control-plane/src/runs/comparison-summary-service";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
it("revalidates a current durable orphan after restart and rejects altered/stale files without exposing rows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-restart-"));
  const c = new DatabaseClient();
  c.migrate(
    fs
      .readdirSync("apps/control-plane/src/db/migrations")
      .filter((x) => x.endsWith(".sql"))
      .sort()
      .map((x) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", x), "utf8"))
      .join("\n")
  );
  const r = new Repositories(c);
  const storage = new ArtifactStorage(root);
  r.saveRun(summaryRun());
  const token = r.claimSummaryAttempt("run-test");
  try {
    const artifact = await storage.writeSummaryAttempt(
      summaryHeader(),
      r.iterateStagedSummaryRows("run-test", "measurement-summary.v1", token),
      token
    );
    const freshService = new ComparisonSummaryService(
      r,
      new ArtifactStorage(root),
      new MemoryPrometheusClient()
    );
    assert.equal(r.getSummaryCache("run-test").status, "RECOMPUTING");
    assert.equal(await freshService.reconcileOrphan("run-test"), true);
    assert.equal(r.getSummaryCache("run-test").status, "READY");
    assert.equal(r.listArtifacts("run-test")[0].path, artifact.path);
    r.saveRun({ ...summaryRun("run-altered"), variantId: "v-altered" });
    const other = r.claimSummaryAttempt("run-altered");
    const second = await storage.writeSummaryAttempt(
      summaryHeader("run-altered"),
      r.iterateStagedSummaryRows("run-altered", "measurement-summary.v1", other),
      other
    );
    fs.appendFileSync(storage.safePath(second.path), "malformed");
    await assert.rejects(() => freshService.reconcileOrphan("run-altered"));
    assert.equal(r.getSummaryCache("run-altered").status, "RECOMPUTING");
    assert.equal(r.listArtifacts("run-altered").length, 0);
    c.db
      .prepare("UPDATE run_comparison_summaries SET lease_until=0 WHERE run_id='run-altered'")
      .run();
    assert.equal(await freshService.reconcileOrphan("run-altered"), false);
  } finally {
    c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
