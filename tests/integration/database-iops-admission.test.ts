import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { resolveDatabaseIops } from "../../packages/contracts/src/database-iops";
test("finite condition without a verified adapter never provisions or starts workload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-iops-admission-"));
  const orchestrator = new FakeRunOrchestrator();
  (orchestrator as any).applyDatabaseIops = undefined;
  (orchestrator as any).checkDatabaseIops = undefined;
  const p = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true, orchestrator, phaseScale: 0 }
  );
  try {
    await p.startupRecovery;
    const ex = p.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "v1", name: "IOPS", parameters: {} }],
        inputs: {
          databaseImage: "db:fixture",
          pasImage: "pas:fixture",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      },
      scenario as any
    );
    const run = p.repositories.getRun(ex.runIds[0])!;
    run.environmentSnapshot = {
      ...run.environmentSnapshot,
      databaseIops: resolveDatabaseIops("hdd")
    };
    p.repositories.saveRun(run);
    const result = await p.coordinator.executeRun(run);
    assert.equal(result.state, "FAILED");
    assert.equal(result.failureCode, "database_iops_unsupported");
    assert.ok(!orchestrator.calls.includes("start-workload"));
    assert.ok(!orchestrator.calls.includes("provision"));
  } finally {
    p.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
