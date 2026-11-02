import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { compileDatabaseSetup } from "../../apps/control-plane/src/database-setup/compile-plan";
import { readDatabaseSetupEvidence } from "../../packages/compose-runner/src/database-setup-evidence";
test("native evidence rejects stale ownership and false terminal success, retaining pending observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-setup-evidence-"));
  try {
    const { manifest } = compileDatabaseSetup({
      runId: "r",
      attemptId: "a",
      setup: {
        contractVersion: "database-setup.v1",
        steps: [{ id: "s", definitionId: "idxbuild", optionSets: [{ id: "o", scope: "all" }] }]
      },
      runtimeDirectory: root,
      databaseName: "testdb",
      image: "fixture:1"
    });
    assert.equal(readDatabaseSetupEvidence(manifest).state, "PENDING");
    const status: any = {
      contractVersion: "database-setup-status.v1",
      runId: "r",
      attemptId: "old",
      state: "RUNNING",
      phase: "utility",
      step: 1,
      optionSet: 1,
      capturedAt: new Date().toISOString(),
      code: "none"
    };
    const write = () =>
      fs.writeFileSync(path.join(manifest.paths.output, "status.json"), JSON.stringify(status));
    write();
    assert.throws(() => readDatabaseSetupEvidence(manifest), /owner/);
    status.attemptId = "a";
    write();
    assert.equal(readDatabaseSetupEvidence(manifest).state, "RUNNING");
    status.state = "SUCCEEDED";
    write();
    assert.throws(() => readDatabaseSetupEvidence(manifest), /database_setup_evidence_invalid/);
    const step = path.join(manifest.paths.output, "steps/0001");
    fs.mkdirSync(step, { recursive: true });
    const row = {
      state: "SUCCEEDED",
      exitStatus: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(step, "0001.json"), JSON.stringify(row));
    assert.equal(readDatabaseSetupEvidence(manifest).steps[0].optionSets[0].id, "o");
    fs.writeFileSync(path.join(step, "0001.json"), JSON.stringify({ ...row, id: "wrong" }));
    assert.throws(() => readDatabaseSetupEvidence(manifest), /set_fields/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
