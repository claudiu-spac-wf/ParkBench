import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const nativeImport = new Function("specifier", "return import(specifier)") as (
  s: string
) => Promise<any>;
const load = (name: string) =>
  nativeImport(pathToFileURL(path.resolve("scripts/openedge", name + ".mjs")).href);

for (const condition of [
  "unchanged",
  "seed",
  "schema",
  "profile",
  "inspection",
  "source-during-inspection",
  "cleanup",
  "unreadable"
]) {
  test(`verify-only calibration workflow: ${condition}`, async () => {
    const lib = await load("read-calibration"),
      { calibrate } = await load("calibrate-read-footprint");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-calibration-workflow-"));
    const seed = path.join(root, "seed"),
      reportFile = path.join(root, "accepted.json"),
      scenario = path.join(root, "scenario.json");
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, "parkbench.st"), "structure");
    fs.writeFileSync(path.join(seed, "parkbench.d1"), "data");
    const profile = lib.readProfile();
    const zero = () =>
      Array.from({ length: 1000 }, (_, i) => ({
        bucket: i + 1,
        rowCount: 0,
        recordBytes: 0,
        lobBytes: 0,
        totalBytes: 0
      }));
    const global = zero();
    Object.assign(global[0], { rowCount: 1, recordBytes: 9000000000, totalBytes: 9000000000 });
    const report = {
      contractVersion: "parkbench-read-calibration.v1",
      measuredAt: "2026-10-02T00:00:00Z",
      measurementVersion: "workflow-fixture",
      seed: { description: "fixture", fingerprint: await lib.fingerprintSeed(seed) },
      schemaHash: lib.canonicalHash([]),
      readProfileHash: lib.canonicalHash(profile),
      targetBytes: 9000000000,
      bucketCount: 1000,
      cutoffN: 1,
      status: "calibrated",
      totalEligibleBytes: 9000000000,
      selectedEligibleBytes: 9000000000,
      buckets: global,
      tables: profile.tables.map((t: any, i: number) => ({
        ...t,
        lobEncoding: "stored bytes",
        buckets: i === 0 ? structuredClone(global) : zero()
      })),
      accessCoverage: { mode: "whole-bucket", verified: true },
      verification: {
        selectedBytes: 9000000000,
        previousCutoffBytes: 0,
        sourceUnchanged: true,
        byteAccountingVerified: true,
        probeVersion: "fixture"
      }
    };
    lib.validateCalibration(report, { profile });
    if (condition === "schema") report.schemaHash = "d".repeat(64);
    if (condition === "profile") report.readProfileHash = "e".repeat(64);
    fs.writeFileSync(reportFile, JSON.stringify(report));
    fs.writeFileSync(scenario, "preserved scenario");
    if (condition === "seed") fs.writeFileSync(path.join(seed, "parkbench.d1"), "changed data");
    const originalReport = fs.readFileSync(reportFile),
      originalSource = fs.readFileSync(path.join(seed, "parkbench.d1"));
    let closes = 0,
      starts = 0,
      probes = 0;
    const fixture = {
      root,
      imageId: "fixture-image",
      async start() {
        starts++;
      },
      compileReadProbes() {},
      probe(options: any) {
        probes++;
        assert.deepEqual(options, { schemaOnly: true });
        if (condition === "inspection") throw new Error("inspection_failed");
        if (condition === "source-during-inspection")
          fs.writeFileSync(path.join(seed, "parkbench.d1"), "unexpected mutation");
        return { ok: true, schema: [] };
      },
      verify() {
        throw new Error("verify-only rescanned footprint");
      },
      byteFixtures() {
        throw new Error("verify-only changed fixture data");
      },
      close() {
        closes++;
        if (condition === "cleanup") throw new Error("cleanup_failed");
      }
    };
    const dependencies = {
      loadEnvironment() {},
      createFixture: () => fixture,
      evidenceDirectory: path.join(root, "evidence")
    };
    try {
      const options = {
        verifyOnly: true,
        seed: condition === "unreadable" ? path.join(root, "missing") : seed,
        calibration: reportFile
      };
      if (condition === "unchanged") {
        const result = await calibrate(options, dependencies);
        assert.equal(result.evidence.state, "verified");
        assert.equal(result.report, undefined);
      } else
        await assert.rejects(
          calibrate(options, dependencies),
          condition === "seed" || condition === "schema" || condition === "profile"
            ? new RegExp(
                "read_calibration_stale:" +
                  (condition === "seed"
                    ? "seedFingerprint"
                    : condition === "schema"
                      ? "schemaHash"
                      : "readProfileHash")
              )
            : condition === "inspection"
              ? /inspection_failed/
              : condition === "cleanup"
                ? /cleanup_failed/
                : condition === "source-during-inspection"
                  ? /read_source_seed_changed/
                  : /ENOENT/
        );
      const evidence = JSON.parse(
        fs.readFileSync(path.join(root, "evidence/calibration-identity.json"), "utf8")
      );
      assert.equal(
        evidence.state,
        condition === "unchanged"
          ? "verified"
          : ["seed", "schema", "profile"].includes(condition)
            ? "stale"
            : "unverified"
      );
      assert.deepEqual(fs.readFileSync(reportFile), originalReport);
      assert.equal(fs.readFileSync(scenario, "utf8"), "preserved scenario");
      if (condition !== "source-during-inspection")
        assert.deepEqual(fs.readFileSync(path.join(seed, "parkbench.d1")), originalSource);
      assert.equal(starts, condition === "unreadable" ? 0 : 1);
      assert.equal(probes, condition === "unreadable" ? 0 : 1);
      assert.equal(closes, condition === "unreadable" ? 0 : condition === "cleanup" ? 2 : 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
