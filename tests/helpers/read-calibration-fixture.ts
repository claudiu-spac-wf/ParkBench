export function calibrationFixture(lib: any, profile = lib.readProfile()): any {
  const zero = () =>
    Array.from({ length: 1000 }, (_, i) => ({
      bucket: i + 1,
      rowCount: 0,
      recordBytes: 0,
      lobBytes: 0,
      totalBytes: 0
    }));
  const buckets = zero();
  Object.assign(buckets[0], { rowCount: 1, recordBytes: 9_000_000_000, totalBytes: 9_000_000_000 });
  return {
    contractVersion: "parkbench-read-calibration.v1",
    measuredAt: "2026-10-02T00:00:00Z",
    measurementVersion: "test-fixture",
    seed: { description: "synthetic fixture", fingerprint: "a".repeat(64) },
    schemaHash: "b".repeat(64),
    readProfileHash: lib.canonicalHash(profile),
    targetBytes: 9_000_000_000,
    bucketCount: 1000,
    cutoffN: 1,
    status: "calibrated",
    totalEligibleBytes: 9_000_000_000,
    selectedEligibleBytes: 9_000_000_000,
    buckets,
    tables: profile.tables.map((t: any, i: number) => ({
      ...t,
      lobEncoding: "stored bytes",
      buckets: i ? zero() : structuredClone(buckets)
    })),
    accessCoverage: profile.partitionMap
      ? {
          mode: "primary-key-partitioned",
          verified: true,
          partitionMapHash: lib.canonicalHash(profile.partitionMap)
        }
      : { mode: "whole-bucket", verified: true },
    verification: {
      selectedBytes: 9_000_000_000,
      previousCutoffBytes: 0,
      sourceUnchanged: true,
      byteAccountingVerified: true,
      probeVersion: "test-fixture"
    }
  };
}
