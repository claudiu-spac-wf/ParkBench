import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { DatabaseIopsError } from "../../packages/contracts/src/database-iops";
async function execute(phase?: string, race?: "cancel-first" | "drift-first", setup = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-lifecycle-"));
  let runId: string;
  class Recording extends FakeRunOrchestrator {
    async waitForDatabaseSetup(bundle: any, _cancel: any, progress: any) {
      this.calls.push("waitForDatabaseSetup");
      assert.equal(this.calls.includes("applyDatabaseIops"), false);
      if (phase === "setup-failed") throw new Error("database_setup_failed");
      if (phase === "setup-slow") await new Promise((resolve) => setTimeout(resolve, 1200));
      const { manifest } = bundle.databaseSetup;
      for (const [i, step] of manifest.sequence.steps.entries()) {
        for (const [j] of step.optionSets.entries()) {
          const dir = path.join(manifest.paths.output, "steps", String(i + 1).padStart(4, "0"));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, String(j + 1).padStart(4, "0") + ".json"),
            JSON.stringify({
              state: "SUCCEEDED",
              exitStatus: 0,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString()
            })
          );
        }
      }
      fs.writeFileSync(
        path.join(manifest.paths.output, "status.json"),
        JSON.stringify({
          contractVersion: "database-setup-status.v1",
          runId: manifest.runId,
          attemptId: manifest.attemptId,
          state: "SUCCEEDED",
          phase: "awaiting-normal-start",
          step: 1,
          optionSet: 0,
          capturedAt: new Date().toISOString(),
          code: "none"
        })
      );
      const { readDatabaseSetupEvidence } =
        await import("../../packages/compose-runner/src/database-setup-evidence");
      const e = readDatabaseSetupEvidence(manifest);
      progress(e);
      if (phase === "setup-cancelled") p.coordinator.cancel(runId);
      return e;
    }
    async startRemainingServices() {
      this.calls.push("startRemainingServices");
    }

    override async applyDatabaseIops(
      ...args: Parameters<FakeRunOrchestrator["applyDatabaseIops"]>
    ) {
      assert.ok(this.calls.includes("iops-startup-held"));
      assert.equal(this.calls.includes("ready"), false);
      if (setup) {
        assert.equal(this.calls.includes("waitForDatabaseSetup"), true);
        assert.equal(
          p.repositories.getRun(runId).environmentSnapshot.databaseSetupEvidence.state,
          "SUCCEEDED"
        );
        const manifest = args[0].databaseSetup!.manifest;
        assert.ok(fs.existsSync(path.join(manifest.paths.control, "normal-start-release")));
      }
      assert.ok(args[0].databaseIopsDeadline! > Date.now());
      const e = await super.applyDatabaseIops(...args);
      const saved = p.repositories.getRun(runId);
      const summary = saved.environmentSnapshot.databaseIopsEvidence;
      assert.equal(summary.stage, "PERSISTING_INTENT");
      const artifact = p.repositories
        .listArtifacts(runId)
        .find((a) => a.sourceMetadata?.contractVersion === "database-iops-evidence.v1");
      assert.ok(artifact);
      const intent = JSON.parse(
        fs.readFileSync(path.join(root, artifact.path), "utf8")
      ).applicationIntent;
      assert.equal(intent.owner.containerId, e.owner.containerId);
      if (phase === "unverified") e.verification.status = "PENDING";
      return e;
    }
    override async checkDatabaseIops(
      ...args: Parameters<FakeRunOrchestrator["checkDatabaseIops"]>
    ) {
      const e = await super.checkDatabaseIops(...args);
      if (args[2] === phase) {
        if (race === "cancel-first") p.coordinator.cancel(runId);
        e.verification.status = "MISMATCH";
        e.failure = {
          code: "database_iops_policy_drift",
          stage: "MONITORING",
          phase,
          reason: "fixture_policy_changed"
        };
        throw new DatabaseIopsError("database_iops_policy_drift", e);
      }
      return e;
    }
    override async stopWorkload() {
      this.calls.push("iops-stop");
      if (race === "drift-first") p.coordinator.cancel(runId);
      return super.stopWorkload();
    }
  }
  const previousBudget = process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS;
  if (phase === "setup-slow") process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS = "1000";
  const o = new Recording();
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
    { testMode: true, orchestrator: o, phaseScale: 0 }
  );
  try {
    await p.startupRecovery;
    const ex = p.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          {
            id: "v1",
            name: "IOPS",
            parameters: { "storage.databaseIopsPreset": "hdd" },
            ...(setup
              ? {
                  databaseSetup: {
                    contractVersion: "database-setup.v1",
                    steps: [
                      {
                        id: "first",
                        definitionId: "idxbuild",
                        optionSets: [{ id: "all", scope: "all" }]
                      },
                      {
                        id: "second",
                        definitionId: "idxbuild",
                        optionSets: [{ id: "all-again", scope: "all" }]
                      }
                    ]
                  }
                }
              : {})
          }
        ],
        inputs: {
          databaseImage: "db:fixture",
          pasImage: "pas:fixture",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      },
      scenario as any
    );
    runId = ex.runIds[0];
    const run = await p.coordinator.executeRun(p.repositories.getRun(runId));
    return { run, calls: o.calls };
  } finally {
    if (previousBudget === undefined) delete process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS;
    else process.env.PARKBENCH_OPENEDGE_READINESS_TIMEOUT_MS = previousBudget;
    p.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("IOPS intent, constrained readiness and verification precede workload release", async () => {
  const { run, calls } = await execute();
  assert.notEqual(run.state, "FAILED");
  assert.equal(run.environmentSnapshot.databaseIopsEvidence.verification.status, "MATCHED");
  assert.ok(calls.indexOf("applyDatabaseIops") < calls.indexOf("start-workload"));
  assert.equal(calls.filter((c) => c === "ready").length, 1);
  assert.ok(calls.indexOf("iops-startup-held") < calls.indexOf("applyDatabaseIops"));
  assert.ok(calls.indexOf("applyDatabaseIops") < calls.indexOf("iops-startup-release"));
  assert.ok(calls.indexOf("iops-startup-release") < calls.indexOf("ready"));
  assert.equal(
    run.environmentSnapshot.databaseIopsEvidence.applicationTiming,
    "AFTER_SETUP_BEFORE_DATABASE_STARTUP"
  );
});
for (const phase of ["warmup", "measurement", "cooldown"])
  test(`confirmed ${phase} drift fails with partial evidence and no reapply`, async () => {
    const { run, calls } = await execute(phase);
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureCode, "database_iops_policy_drift");
    assert.equal(run.measurementValidity, "UNAVAILABLE");
    assert.equal(
      run.environmentSnapshot.databaseIopsEvidence.terminationDecision.cause,
      "POLICY_DRIFT"
    );
    assert.equal(run.environmentSnapshot.databaseIopsEvidence.failure.phase, phase);
    assert.ok(run.environmentSnapshot.observerCollection.counts.length > 0);
    assert.equal(calls.filter((c) => c === "applyDatabaseIops").length, 1);
    assert.equal(run.cleanupStatus, "COMPLETE");
  });
test("cancellation accepted before a late drift verdict stays CANCELLED", async () => {
  const { run } = await execute("measurement", "cancel-first");
  assert.equal(run.state, "CANCELLED");
  assert.equal(run.environmentSnapshot.databaseIopsEvidence.terminationDecision.cause, "CANCELLED");
});
test("confirmed drift cannot be overwritten by cancellation during stop/finalization", async () => {
  const { run } = await execute("measurement", "drift-first");
  assert.equal(run.state, "FAILED");
  assert.equal(run.failureCode, "database_iops_policy_drift");
  assert.equal(
    run.environmentSnapshot.databaseIopsEvidence.terminationDecision.cause,
    "POLICY_DRIFT"
  );
});

test("unverified finite policy never starts workload", async () => {
  const { run, calls } = await execute("unverified");
  assert.equal(run.state, "FAILED");
  assert.equal(run.failureCode, "database_iops_unconfirmed");
  assert.ok(!calls.includes("start-workload"));
  assert.ok(!calls.includes("iops-startup-release"));
  assert.equal(run.environmentSnapshot.databaseIopsEvidence.verification.status, "UNAVAILABLE");
});

test("all declared setup completes before finite caps and normal readiness", async () => {
  const { run, calls } = await execute(undefined, undefined, true);
  assert.notEqual(run.state, "FAILED");
  assert.ok(calls.indexOf("waitForDatabaseSetup") < calls.indexOf("iops-startup-held"));
  assert.ok(calls.indexOf("iops-startup-release") < calls.indexOf("startRemainingServices"));
  assert.equal(run.environmentSnapshot.databaseSetup.steps.length, 2);
});

test("cancellation during asynchronous admission cannot resurrect a queued finite run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-admission-cancel-"));
  const o = new FakeRunOrchestrator();
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
    { testMode: true, orchestrator: o, phaseScale: 0 }
  );
  try {
    await p.startupRecovery;
    const ex = p.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [
          { id: "v", name: "queued", parameters: { "storage.databaseIopsPreset": "hdd" } }
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
    const { freezeDiagnosticsConfig, DIAGNOSTIC_DEFAULTS } =
      await import("../../packages/contracts/src/measurement-diagnostics");
    run.environmentSnapshot.resolvedMeasurementDiagnostics = freezeDiagnosticsConfig(
      undefined,
      DIAGNOSTIC_DEFAULTS,
      Date.now()
    );
    p.repositories.saveRun(run);
    const service = (p.coordinator as any).diagnosticsService(),
      original = service.begin.bind(service);
    let entered: () => void, release: () => void;
    const admitted = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    (p.coordinator as any).diagnosticsService = () => service;
    service.begin = async (r: any) => {
      const result = await original(r);
      entered();
      await gate;
      return result;
    };
    const executing = p.coordinator.executeRun(run);
    await admitted;
    p.coordinator.cancel(run.id);
    release();
    const finished = await executing;
    assert.equal(finished.state, "CANCELLED");
    assert.equal(p.repositories.getRun(run.id).state, "CANCELLED");
    assert.ok(!o.calls.includes("provision"));
    assert.ok(!o.calls.includes("applyDatabaseIops"));
  } finally {
    p.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const phase of ["setup-failed", "setup-cancelled"])
  test(`${phase} never applies limits or releases normal startup`, async () => {
    const { run, calls } = await execute(phase, undefined, true);
    assert.equal(run.state, phase === "setup-cancelled" ? "CANCELLED" : "FAILED");
    assert.ok(!calls.includes("applyDatabaseIops"));
    assert.ok(!calls.includes("iops-startup-release"));
    assert.ok(!calls.includes("startRemainingServices"));
  });
test("long setup retains a fresh finite startup budget", async () => {
  const { run, calls } = await execute("setup-slow", undefined, true);
  assert.notEqual(run.state, "FAILED", run.failureReason);
  assert.ok(calls.indexOf("waitForDatabaseSetup") < calls.indexOf("applyDatabaseIops"));
});
