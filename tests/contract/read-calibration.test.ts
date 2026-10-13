import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<any>;
const load = () =>
  nativeImport(pathToFileURL(path.resolve("scripts/openedge/read-calibration.mjs")).href);
function report(): any {
  const buckets = Array.from({ length: 1000 }, (_, i) => ({
    bucket: i + 1,
    rowCount: i ? 0 : 1,
    recordBytes: i ? 0 : 9_000_000_000,
    lobBytes: 0,
    totalBytes: i ? 0 : 9_000_000_000
  }));
  return {
    contractVersion: "parkbench-read-calibration.v1",
    measuredAt: "2026-10-02T00:00:00Z",
    measurementVersion: "fixture",
    seed: { description: "fixture", fingerprint: "a".repeat(64) },
    schemaHash: "b".repeat(64),
    readProfileHash: "c".repeat(64),
    targetBytes: 9_000_000_000,
    bucketCount: 1000,
    cutoffN: 1,
    status: "calibrated",
    totalEligibleBytes: 9_000_000_000,
    selectedEligibleBytes: 9_000_000_000,
    buckets,
    tables: [
      {
        name: "Fixture",
        requestedLobFields: [],
        lobEncoding: "none",
        buckets: structuredClone(buckets)
      }
    ],
    verification: {
      selectedBytes: 9_000_000_000,
      previousCutoffBytes: 0,
      sourceUnchanged: true,
      byteAccountingVerified: true,
      probeVersion: "fixture"
    }
  };
}
it("validates complete histograms, safe sizes and the independent minimum cutoff", async () => {
  const { validateCalibration } = await load();
  assert.doesNotThrow(() => validateCalibration(report()));
  for (const mutate of [
    (r: any) => (r.buckets[1].bucket = 1),
    (r: any) => r.buckets.pop(),
    (r: any) => (r.buckets[0].recordBytes = -1),
    (r: any) => r.buckets[0].totalBytes++,
    (r: any) => r.tables[0].buckets[0].recordBytes--,
    (r: any) => (r.cutoffN = 2),
    (r: any) => (r.verification.previousCutoffBytes = 9_000_000_000),
    (r: any) => (r.measuredAt = "not-a-date"),
    (r: any) => (r.verification.sourceUnchanged = false),
    (r: any) => (r.status = "pending")
  ]) {
    const r = report();
    mutate(r);
    assert.throws(() => validateCalibration(r));
  }
});
it("requires coherent optional partition coverage and calibrated/undersized status", async () => {
  const { validateCalibration } = await load();
  const r = report();
  r.accessCoverage = { mode: "whole-bucket", verified: true };
  assert.doesNotThrow(() => validateCalibration(r));
  r.accessCoverage.partitionMapHash = "d".repeat(64);
  assert.throws(() => validateCalibration(r));
  r.accessCoverage.mode = "primary-key-partitioned";
  assert.doesNotThrow(() => validateCalibration(r));
  delete r.accessCoverage.partitionMapHash;
  assert.throws(() => validateCalibration(r));
  const small = report();
  small.status = "undersized";
  small.cutoffN = 1000;
  for (const h of [small.buckets, small.tables[0].buckets]) {
    h[0].recordBytes = 100;
    h[0].totalBytes = 100;
  }
  small.totalEligibleBytes =
    small.selectedEligibleBytes =
    small.verification.selectedBytes =
    small.verification.previousCutoffBytes =
      100;
  assert.doesNotThrow(() => validateCalibration(small));
});
it("fingerprints seed content independently of volatile files and returns explicit stale/unverified identities", async () => {
  const { fingerprintSeed, compareCalibrationIdentity } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-read-identity-"));
  try {
    fs.writeFileSync(path.join(dir, "parkbench.st"), "structure");
    fs.writeFileSync(path.join(dir, "parkbench.d1"), "one");
    const before = await fingerprintSeed(dir);
    fs.writeFileSync(path.join(dir, "parkbench.lg"), "volatile");
    assert.equal(await fingerprintSeed(dir), before);
    fs.writeFileSync(path.join(dir, "parkbench.d1"), "two");
    assert.notEqual(await fingerprintSeed(dir), before);
    const r = report();
    const observed = {
      seedFingerprint: r.seed.fingerprint,
      schemaHash: r.schemaHash,
      readProfileHash: r.readProfileHash
    };
    assert.equal(compareCalibrationIdentity(r, observed).state, "verified");
    assert.deepEqual(
      compareCalibrationIdentity(r, { ...observed, schemaHash: "d".repeat(64) }).mismatched,
      ["schemaHash"]
    );
    assert.equal(compareCalibrationIdentity(r, {}).state, "unverified");
    await assert.rejects(fingerprintSeed(path.join(dir, "missing")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects profile drift and preserves accepted evidence when atomic publication fails validation", async () => {
  const { validateCalibration, atomicPublishCalibration } = await load();
  const r = report();
  assert.throws(() => validateCalibration(r, { readProfileHash: "d".repeat(64) }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-read-publish-"));
  const file = path.join(dir, "report.json");
  try {
    fs.writeFileSync(file, "previous accepted evidence");
    r.verification.byteAccountingVerified = false;
    assert.throws(() => atomicPublishCalibration(file, r));
    assert.equal(fs.readFileSync(file, "utf8"), "previous accepted evidence");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("enforces finite nonnegative safe integers and complete identities in every histogram", async () => {
  const { validateCalibration } = await load();
  for (const field of ["rowCount", "recordBytes", "lobBytes", "totalBytes"])
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      const r = report();
      r.tables[0].buckets[0][field] = value;
      assert.throws(() => validateCalibration(r), `${field}:${value}`);
    }
  for (const mutate of [
    (r: any) => (r.tables[0].buckets[1].bucket = 1),
    (r: any) => r.tables[0].buckets.pop(),
    (r: any) => (r.tables[0].buckets[0].bucket = 0),
    (r: any) => (r.tables[0].buckets[0].bucket = 1001),
    (r: any) => r.tables.push(structuredClone(r.tables[0])),
    (r: any) => (r.tables[0].requestedLobFields = ["Content", "Content"]),
    (r: any) => (r.schemaHash = "A".repeat(64)),
    (r: any) => (r.readProfileHash = "bad"),
    (r: any) => r.verification.selectedBytes--,
    (r: any) => r.verification.previousCutoffBytes++,
    (r: any) => (r.verification.byteAccountingVerified = false),
    (r: any) => (r.measurementVersion = ""),
    (r: any) => (r.tables[0].lobEncoding = ""),
    (r: any) => (r.measuredAt = "2026-02-30T00:00:00Z")
  ]) {
    const r = report();
    mutate(r);
    assert.throws(() => validateCalibration(r));
  }
});
it("validates typed exhaustive partition maps, report hashes and unchanged original operation probabilities", async () => {
  const { readProfile, validateReadProfile, validateCalibration, canonicalHash } = await load();
  const profile = readProfile(),
    original = structuredClone(profile.operations);
  const inventory = JSON.parse(
    fs.readFileSync("scripts/openedge/table-write-inventory.json", "utf8")
  );
  profile.partitionMap = profile.operations.map((op: any) => {
    const table = inventory.tables.find((t: any) => t.name === op.bodyTemplate.input.TableName);
    return {
      operationId: op.id,
      keyFields: [table.primaryField],
      keyTypes: [table.fields.find((f: any) => f.name === table.primaryField).type.toUpperCase()],
      ranges: [
        { lowerInclusive: null, upperExclusive: [100] },
        { lowerInclusive: [100], upperExclusive: null }
      ]
    };
  });
  assert.doesNotThrow(() => validateReadProfile(profile));
  assert.deepEqual(profile.operations, original);
  assert.equal(
    profile.operations.reduce((s: number, o: any) => s + o.weight, 0),
    74
  );
  for (const mutate of [
    (p: any) => p.partitionMap.pop(),
    (p: any) => (p.partitionMap[0].ranges[1].lowerInclusive = [101]),
    (p: any) => (p.partitionMap[0].ranges[1].lowerInclusive = [99]),
    (p: any) => (p.partitionMap[0].ranges[0].upperExclusive = null),
    (p: any) => (p.partitionMap[0].ranges[0].lowerInclusive = [0]),
    (p: any) => (p.partitionMap[0].ranges[1].upperExclusive = [1000]),
    (p: any) => (p.partitionMap[0].ranges[0].upperExclusive = ["100"]),
    (p: any) => (p.partitionMap[0].keyFields = ["RandomInt1000"]),
    (p: any) => (p.partitionMap[0].keyTypes = ["CHARACTER"]),
    (p: any) => (p.partitionMap[0].keyTypes = [p.partitionMap[0].keyTypes[0] === "INT64" ? "INTEGER" : "INT64"])
  ]) {
    const bad = structuredClone(profile);
    mutate(bad);
    assert.throws(() => validateReadProfile(bad));
  }
  const r = report();
  r.tables = profile.tables.map((t: any, i: number) => ({
    ...t,
    lobEncoding: "stored bytes",
    buckets: r.buckets.map((b: any) =>
      i === 0
        ? { ...b }
        : { bucket: b.bucket, rowCount: 0, recordBytes: 0, lobBytes: 0, totalBytes: 0 }
    )
  }));
  r.readProfileHash = canonicalHash(profile);
  assert.throws(() => validateCalibration(r, { profile }), /partition_coverage_mismatch/);
  r.accessCoverage = {
    mode: "primary-key-partitioned",
    verified: true,
    partitionMapHash: canonicalHash(profile.partitionMap)
  };
  assert.doesNotThrow(() => validateCalibration(r, { profile }));
  r.accessCoverage.partitionMapHash = "d".repeat(64);
  assert.throws(() => validateCalibration(r, { profile }), /partition_coverage_mismatch/);
});
it("deduplicates requested LOB eligibility when original operations overlap", async () => {
  const { readProfile, validateReadProfile } = await load();
  const p = readProfile();
  const existing = p.operations.find((o: any) => o.id === "statement-download");
  const first = p.operations[0];
  first.bodyTemplate = structuredClone(existing.bodyTemplate);
  first.bodyTemplate.input.LobFields.push("PdfContent");
  p.tables = p.tables.filter((t: any) => t.name !== "Currency");
  assert.doesNotThrow(() => validateReadProfile(p));
  assert.deepEqual(p.tables.find((t: any) => t.name === "StatementDocument").requestedLobFields, [
    "PdfContent",
    "StatementXml"
  ]);
});
it("an atomic rename failure preserves the accepted file and removes partial evidence", async () => {
  const { atomicPublishCalibration } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-atomic-failure-"));
  const file = path.join(root, "accepted.json");
  fs.writeFileSync(file, "accepted");
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (() => {
      throw new Error("rename_failure");
    }) as typeof fs.renameSync;
    assert.throws(() => atomicPublishCalibration(file, report()), /rename_failure/);
    assert.equal(fs.readFileSync(file, "utf8"), "accepted");
    assert.deepEqual(fs.readdirSync(root), ["accepted.json"]);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
