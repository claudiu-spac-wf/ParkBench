#!/usr/bin/env node
/** Licensed acceptance gate. Backend regression must pass before any native request. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const value = (key) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const apiBase = value("--api-base") ?? "http://127.0.0.1:13000";
const seedId = value("--seed-id");
const evidenceDir =
  value("--evidence-dir") ?? fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-report-acceptance-"));
fs.mkdirSync(evidenceDir, { recursive: true });
const results = {
  startedAt: new Date().toISOString(),
  backend: {},
  native: { status: "NOT_RUN" },
  limitations: [
    "Filesystem size/mtime/inventory checks do not prove byte-for-byte immutability. No content hashes are collected. Read-only mount inspection and native command audit are additional evidence."
  ]
};
const save = () =>
  fs.writeFileSync(path.join(evidenceDir, "acceptance.json"), JSON.stringify(results, null, 2));
for (const suite of ["unit", "contract", "integration"]) {
  const run = spawnSync("npm", ["run", `test:${suite}`, "--", "--test-concurrency=4"], {
    stdio: "inherit",
    shell: false
  });
  results.backend[suite] = run.status === 0 ? "PASS" : "FAIL";
  save();
  if (run.status !== 0) {
    console.error(
      `Native reports blocked: backend ${suite} tests failed. Evidence: ${evidenceDir}`
    );
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) {
  if (!seedId) {
    results.native = {
      status: "SKIPPED",
      reason: "Supply --seed-id for a ready offline catalog seed. No native utility was requested."
    };
    save();
    console.log(results.native.reason);
  } else {
    const api = async (route, options = {}) => {
      const response = await fetch(apiBase + "/api/v1" + route, options);
      if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const untilTerminal = async (id) => {
      for (;;) {
        const { report } = await api("/reports/" + id);
        if (!["QUEUED", "RUNNING"].includes(report.state)) return report;
        await wait(1000);
      }
    };
    try {
      const collected = [];
      let seedPath, inventory;
      for (const type of ["DBANALYS", "IDXANALYS", "TABANALYS"]) {
        const response = await api("/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
          body: JSON.stringify({
            contractVersion: "database-analysis-report.v1",
            family: "database-analysis",
            seedAssetId: seedId,
            type
          })
        });
        const initial = response.report;
        if (!seedPath) {
          seedPath = initial.seedSnapshot.path;
          const inspect = () =>
            fs
              .readdirSync(seedPath)
              .sort()
              .map((file) => {
                const s = fs.lstatSync(path.join(seedPath, file), { bigint: true });
                return {
                  file,
                  size: s.size.toString(),
                  mtime: s.mtimeNs.toString(),
                  regular: s.isFile()
                };
              });
          inventory = { before: inspect(), inspect };
        }
        const report = await untilTerminal(initial.id);
        collected.push(report.id);
        if (report.state !== "COMPLETED")
          throw new Error(`${type}: ${report.failure?.code ?? report.state}`);
        if (
          report.executionSnapshot.options.includes("-RO") ||
          !report.executionSnapshot.mounts.some(
            (m) => m.target === "/run/parkbench/seed/db" && m.readOnly
          ) ||
          !report.executionSnapshot.mounts.some((m) => m.target === "/psc/wrk" && !m.readOnly)
        )
          throw new Error("temporary_database_mount_evidence_missing");
        for (const artifact of report.artifacts.filter((a) => a.kind === "CSV")) {
          const target = path.join(evidenceDir, report.id + "-" + artifact.filename),
            response = await fetch(
              `${apiBase}/api/v1/reports/${report.id}/artifacts/${artifact.id}`
            );
          if (!response.ok) throw new Error("download_failed");
          const { Readable } = await import("node:stream");
          const { pipeline } = await import("node:stream/promises");
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
          const check = spawnSync(
            "python3",
            [
              "-c",
              'import csv,sys; f=open(sys.argv[1],encoding="utf-8",newline=""); r=csv.reader(f,strict=True); h=next(r); rows=list(r); assert all(len(row)==len(h) for row in rows); print(len(rows))',
              target
            ],
            { encoding: "utf8" }
          );
          if (check.status !== 0) throw new Error("independent_csv_validation_failed");
        }
      }
      const after = inventory.inspect();
      if (JSON.stringify(inventory.before) !== JSON.stringify(after))
        throw new Error("seed_inventory_changed");
      // Cancellation requires observing the actual analysis container, rather than only QUEUED/RUNNING API state.
      const cancelRequest = await api("/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          contractVersion: "database-analysis-report.v1",
          family: "database-analysis",
          seedAssetId: seedId,
          type: "DBANALYS"
        })
      });
      let observed = false;
      for (;;) {
        const { report } = await api("/reports/" + cancelRequest.report.id);
        if (!["QUEUED", "RUNNING"].includes(report.state)) break;
        const inspected = spawnSync(
          "docker",
          ["ps", "--filter", `label=parkbench.report_id=${report.id}`, "--format", "{{.Names}}"],
          { encoding: "utf8" }
        );
        if (inspected.status !== 0) throw new Error("cancellation_observation_failed");
        if (inspected.stdout.split("\n").some((name) => name.endsWith("-analysis"))) {
          observed = true;
          break;
        }
        await wait(100);
      }
      if (observed) {
        await api(`/reports/${cancelRequest.report.id}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const cancelled = await untilTerminal(cancelRequest.report.id);
        if (cancelled.state !== "CANCELLED" || cancelled.cleanupState !== "CONFIRMED")
          throw new Error("native_cancellation_failed");
      }
      results.native = {
        status: observed ? "PARTIAL" : "PARTIAL",
        reports: collected,
        cancellation: observed
          ? "PASS"
          : "UNVERIFIED: utility finished before live cancellation could be observed",
        seedInventoryUnchanged: true,
        remaining: [
          "Manual UI scope/value walkthrough and ordinary controller restart retention must be recorded separately. Native source-write auditing requires the operator host."
        ]
      };
      save();
      console.log(
        "Native collection/download checks finished; see acceptance.json for remaining release gates."
      );
    } catch (error) {
      results.native = { status: "FAIL", reason: error.message };
      save();
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
