import test from "node:test";
import assert from "node:assert/strict";
import { databaseIopsPresentation } from "../../apps/web/src/shared/database-iops-presentation";
import { resolveDatabaseIops } from "../../packages/contracts/src/database-iops";
test("historical absence is not inferred from ordinary scalar parameters", () => {
  assert.equal(
    databaseIopsPresentation({
      effectiveConfiguration: { "storage.databaseIopsPreset": "unlimited" }
    }).status,
    "not_recorded"
  );
  assert.equal(databaseIopsPresentation(undefined).text, "Not recorded");
});
test("recorded requested revision/caps win over current and variant values", () => {
  const condition = resolveDatabaseIops("hdd");
  const result = databaseIopsPresentation({
    requestedConfiguration: { databaseIops: condition },
    databaseIops: resolveDatabaseIops("fast-nvme"),
    databaseIopsEvidence: { verification: { status: "MATCHED" }, artifactId: "a" }
  });
  assert.equal(result.condition.presetId, "hdd");
  assert.match(result.text, /150 read \/ 150 write/);
  assert.equal(result.verification, "MATCHED");
  assert.equal(result.artifactId, "a");
  assert.match(
    databaseIopsPresentation({ databaseIops: resolveDatabaseIops() }).text,
    /no added cap/
  );
  assert.equal(databaseIopsPresentation({ databaseIops: condition }).verification, "Requested");
});
