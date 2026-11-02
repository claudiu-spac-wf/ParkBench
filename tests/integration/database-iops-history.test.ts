import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import {
  resolveDatabaseIops,
  pendingDatabaseIops,
  acceptIopsTermination,
  validateDatabaseIopsIntent
} from "../../packages/contracts/src/database-iops";
import { iopsCoverage } from "../fixtures/database-iops";
for (const decision of ["POLICY_DRIFT", "CANCELLED", undefined] as const)
  for (const interruption of ["before-post", "after-post"] as const)
    test(`restart retains ${decision ?? "pending"} attribution ${interruption} without reapplication`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-recovery-"));
      const config: any = {
        host: "127.0.0.1",
        port: 0,
        dbPath: path.join(root, "state.sqlite"),
        artifactRoot: path.join(root, "artifacts"),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      };
      let p = createPlatform(config, { testMode: true, phaseScale: 0 });
      try {
        await p.startupRecovery;
        const ex = p.coordinator.createExperiment(
          {
            scenario: { id: scenario.id, version: scenario.version },
            comparisonMode: "exploratory",
            repetitions: 1,
            variants: [
              { id: "v", name: "IOPS", parameters: { "storage.databaseIopsPreset": "hdd" } }
            ],
            inputs: {
              databaseImage: "fixture/db:1",
              pasImage: "fixture/pas:1",
              seed: "input:seed",
              applicationArchive: "input:archive"
            }
          },
          scenario as any
        );
        const run = p.repositories.getRun(ex.runIds[0])!;
        run.state = "MEASURING";
        run.phase = "measurement";
        run.startedAt = new Date().toISOString();
        const coverage = iopsCoverage();
        coverage.owner.runId = run.id;
        coverage.owner.composeProject = run.composeProject;
        const condition = resolveDatabaseIops("hdd");
        const intent = validateDatabaseIopsIntent({
          contractVersion: "database-iops-application-intent.v1",
          attemptId: "retained-attempt",
          experimentId: ex.id,
          runId: run.id,
          variantId: run.variantId,
          preparedAt: new Date().toISOString(),
          condition,
          owner: coverage.owner,
          coverage,
          previousIops: { read: [], write: [] },
          desiredIops: {
            read: [{ Path: "/dev/fixture0", Rate: 150 }],
            write: [{ Path: "/dev/fixture0", Rate: 150 }]
          }
        });
        const evidence: any = {
          ...pendingDatabaseIops(condition),
          stage: "PERSISTING_INTENT",
          applicationIntent: intent
        };
        if (decision) acceptIopsTermination(evidence, decision, "measurement");
        const artifact = p.artifacts.write(
          run.id,
          "diagnostics",
          "database-iops-evidence.v1.json",
          JSON.stringify(evidence),
          "json",
          { contractVersion: evidence.contractVersion }
        );
        evidence.artifactId = artifact.id;
        run.environmentSnapshot = { ...run.environmentSnapshot, databaseIopsEvidence: evidence };
        p.repositories.saveRun(run);
        p.close();
        class NoResume extends FakeRunOrchestrator {
          override async applyDatabaseIops(): Promise<never> {
            throw Error("must_not_reapply");
          }
          override async provision(): Promise<never> {
            throw Error("must_not_provision");
          }
        }
        const o = new NoResume();
        p = createPlatform(config, { testMode: true, orchestrator: o, phaseScale: 0 });
        await p.startupRecovery;
        const recovered = p.repositories.getRun(run.id)!;
        assert.equal(
          recovered.state,
          decision === "POLICY_DRIFT"
            ? "FAILED"
            : decision === "CANCELLED"
              ? "CANCELLED"
              : "INTERRUPTED"
        );
        if (decision === "POLICY_DRIFT")
          assert.equal(recovered.failureCode, "database_iops_policy_drift");
        assert.equal(recovered.cleanupStatus, "COMPLETE");
        const saved: any = recovered.environmentSnapshot.databaseIopsEvidence;
        const retained = JSON.parse(
          fs.readFileSync(path.join(config.artifactRoot, artifact.path), "utf8")
        );
        assert.equal(retained.applicationIntent.attemptId, "retained-attempt");
        assert.equal(retained.applicationIntent.owner.containerId, intent.owner.containerId);
        assert.equal(retained.applicationIntent.coverage.devices[0].id, "8:0");
        assert.equal(saved.applicationOutcome, "POSSIBLY_APPLIED");
        assert.ok(!o.calls.includes("provision"));
        assert.ok(fs.existsSync(path.join(config.artifactRoot, artifact.path)));
      } finally {
        p.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

test("queued frozen conditions survive restart without provisioning or becoming interrupted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-queued-"));
  const config: any = {
    host: "127.0.0.1",
    port: 0,
    dbPath: path.join(root, "state.sqlite"),
    artifactRoot: path.join(root, "artifacts"),
    prometheusUrl: "http://localhost:9090",
    prometheusRetention: "7d",
    openedge: {}
  };
  let p = createPlatform(config, { testMode: true, phaseScale: 0 });
  try {
    await p.startupRecovery;
    const ex = p.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "v", name: "queued", parameters: { "storage.databaseIopsPreset": "sata-ssd" } }
        ],
        inputs: {
          databaseImage: "fixture/db:1",
          pasImage: "fixture/pas:1",
          seed: "input:seed",
          applicationArchive: "input:archive"
        }
      },
      scenario as any
    );
    const before = p.repositories.getRun(ex.runIds[0])!;
    p.close();
    const runner = new FakeRunOrchestrator();
    p = createPlatform(config, { testMode: true, phaseScale: 0, orchestrator: runner });
    await p.startupRecovery;
    const after = p.repositories.getRun(before.id)!;
    assert.equal(after.state, "QUEUED");
    assert.deepEqual(
      after.environmentSnapshot.databaseIops,
      before.environmentSnapshot.databaseIops
    );
    assert.deepEqual(runner.calls, []);
  } finally {
    p.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
