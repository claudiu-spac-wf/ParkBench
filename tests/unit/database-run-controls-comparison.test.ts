import assert from "node:assert/strict";
import test from "node:test";
import { resolveDatabaseRunControls } from "../../packages/contracts/src/database-run-controls";
import { projectScheduledParameters } from "../../apps/web/src/features/comparison/comparisonPresentation";
test("comparison retains scheduled control sources and inheritance without observed substitutions", () => {
  const controls = resolveDatabaseRunControls(
    {},
    { "database.apwCount": 0, "database.biwEnabled": false }
  );
  const projected = projectScheduledParameters({
    requestedConfiguration: { parameters: {}, databaseStartup: {}, databaseRunControls: controls },
    databaseRunControlEvidence: { observed: { apwCount: 9, nativeClusterKiB: 16384 } }
  });
  assert.equal(projected.entries.find((e) => e.name === "database.apwCount")?.value, "0");
  assert.equal(projected.entries.find((e) => e.name === "database.biwEnabled")?.value, "false");
  assert.equal(
    projected.entries.find((e) => e.name === "database.biClusterSizeMiB")?.value,
    "Inherited from seed"
  );
  assert.equal(projected.entries.find((e) => e.name === "database.apwCount")?.provenance, "queued");
  assert.equal(
    projectScheduledParameters({ requestedConfiguration: { parameters: {}, databaseStartup: {} } })
      .entries.length,
    0
  );
});
