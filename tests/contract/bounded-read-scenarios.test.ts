import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { calibrationFixture } from "../helpers/read-calibration-fixture";
const nativeImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
test("all read-bearing presets admit exactly the same complete bucket domain without a cumulative quota", async () => {
  const lib = await nativeImport(
    pathToFileURL(path.resolve("scripts/openedge/read-calibration.mjs")).href
  );
  const gen = await nativeImport(
    pathToFileURL(path.resolve("scripts/openedge/generate-benchmark-scenarios.mjs")).href
  );
  const report = calibrationFixture(lib);
  // A later cutoff with one-record buckets exercises the entire template domain.
  for (const b of report.buckets)
    Object.assign(b, { rowCount: 1, recordBytes: 10_000_000, totalBytes: 10_000_000 });
  report.tables[0].buckets = structuredClone(report.buckets);
  Object.assign(report, {
    cutoffN: 900,
    totalEligibleBytes: 10_000_000_000,
    selectedEligibleBytes: 9_000_000_000
  });
  report.verification.previousCutoffBytes = 8_990_000_000;
  for (const scenario of gen.buildScenarios(report)) {
    for (const op of scenario.workload.operations.slice(0, 16)) {
      assert.equal(op.bodyTemplate.input.Limit, 0);
      assert.deepEqual(op.templateValues.band, { kind: "uniformInt", min: 1, max: 900 });
      for (let band = 1; band <= 900; band++) {
        const where = op.bodyTemplate.input.WhereClause.replaceAll("{{band}}", String(band));
        const match = /^RandomInt1000 <= (\d+) AND RandomInt1000 = (\d+)$/.exec(where)!;
        assert.equal(Number(match[1]), 900);
        assert.equal(Number(match[2]), band);
        assert.ok(!(901 <= Number(match[1])));
      }
      assert.ok(!("maxBytes" in op.bodyTemplate.input));
      assert.ok(!("quota" in op.bodyTemplate.input));
    }
  }
});
