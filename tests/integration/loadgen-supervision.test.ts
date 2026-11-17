import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DockerComposeOrchestrator,
  FakeRunOrchestrator
} from "../../packages/compose-runner/src/orchestrator";
import { createPlatform } from "../../apps/control-plane/src/platform";
import scenario from "../../examples/scenarios/crud-rest.json";

test("loadgen supervision requires the exact owner and retains real exit/OOM state", async () => {
  const runner: any = new DockerComposeOrchestrator();
  const labels = {
    "parkbench.run_id": "owned",
    "parkbench.experiment_id": "experiment",
    "parkbench.managed": "true",
    "com.docker.compose.project": "project",
    "com.docker.compose.service": "loadgen"
  };
  const bundle: any = { projectName: "project", resources: [{ labels }] };
  let state: any = {
    Status: "running",
    Running: true,
    Paused: false,
    Restarting: false,
    OOMKilled: false,
    ExitCode: 0
  };
  let owner = { ...labels };
  runner.command = async (args: string[], _t: boolean, budget: number) => {
    assert.equal(budget, 5000);
    return {
      stdout:
        args[0] === "ps" ? "a".repeat(64) : JSON.stringify(state) + "\n" + JSON.stringify(owner),
      stderr: ""
    };
  };
  assert.equal((await runner.checkWorkload(bundle)).state, "running");
  state = { ...state, Status: "exited", Running: false, ExitCode: 137, OOMKilled: true };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(await runner.checkWorkload(bundle)).filter(([k]) => k !== "capturedAt")
    ),
    { state: "exited", exitCode: 137, oomKilled: true }
  );
  owner = { ...owner, "parkbench.run_id": "foreign" };
  assert.equal((await runner.checkWorkload(bundle)).state, "unavailable");
  runner.command = async () => ({ stdout: "", stderr: "" });
  assert.equal((await runner.checkWorkload(bundle)).state, "missing");
  runner.command = async () => ({ stdout: "a".repeat(64), stderr: "socket unavailable" });
  assert.equal((await runner.checkWorkload(bundle)).state, "unavailable");
});

for (const phase of ["warmup", "measurement"] as const)
  for (const state of ["exited", "missing", "unavailable", "cancelled"] as const)
    for (const code of state === "exited" ? [0, 20, 137] : [0])
      test(`controller stops promptly on premature loadgen ${state}/${code} during ${phase} and retains planned cancellation`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-loadgen-supervision-")),
          runner: any = new FakeRunOrchestrator();
        const platform = createPlatform(
          {
            host: "127.0.0.1",
            port: 0,
            dbPath: ":memory:",
            artifactRoot: root,
            prometheusUrl: "http://localhost:9090",
            prometheusRetention: "7d",
            openedge: {}
          } as any,
          { testMode: true, orchestrator: runner, phaseScale: 0 }
        );
        let runId = "",
          checks = 0;
        runner.checkWorkload = async () => {
          if (phase === "measurement" && ++checks === 1)
            return { state: "running", capturedAt: new Date().toISOString() };
          if (state === "cancelled") platform.coordinator.cancel(runId);
          return {
            state: state === "cancelled" ? "exited" : state,
            capturedAt: new Date().toISOString(),
            exitCode: code,
            oomKilled: code === 137
          };
        };
        try {
          await platform.startupRecovery;
          const exp = platform.coordinator.createExperiment(
            {
              scenario: { id: scenario.id, version: scenario.version },
              comparisonMode: "exploratory",
              repetitions: 1,
              variants: [{ id: "v", name: "Variant", parameters: {} }],
              inputs: {
                databaseImage: "db:fixture",
                pasImage: "pas:fixture",
                seed: "input:seed/fixture",
                applicationArchive: "input:archive/fixture"
              }
            } as any,
            scenario as any
          );
          runId = exp.runIds[0];
          const run = await platform.coordinator.executeRun(platform.repositories.getRun(runId)!);
          assert.equal(run.state, state === "cancelled" ? "CANCELLED" : "FAILED");
          assert.equal(run.cleanupStatus, "COMPLETE");
          if (state !== "cancelled") {
            assert.equal(
              run.failureCode,
              state === "exited" ? "loadgen_exited_early" : "loadgen_health_unavailable"
            );
            assert.equal(run.failureKind, "infrastructure");
            assert.equal((run.environmentSnapshot as any).loadgenState.state, state);
            assert.equal(run.measurementValidity, "UNAVAILABLE");
            if (phase === "measurement") {
              assert.ok(run.measuringAt);
              assert.ok(run.phaseBoundaries?.measurement?.finishedAt);
              assert.equal((run.environmentSnapshot as any).measurementWindow.state, "interrupted");
            } else assert.equal(run.measuringAt, undefined);
          }
        } finally {
          await platform.close();
          fs.rmSync(root, { recursive: true, force: true });
        }
      });

test("late final-schedule inspection accepts completion while a premature exit still fails at production phase scale", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-final-loadgen-exit-")),
    runner = new FakeRunOrchestrator();
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    } as any,
    { testMode: true, orchestrator: runner, phaseScale: 1 }
  );
  try {
    await platform.startupRecovery;
    const exp = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "v", name: "v", parameters: {} }],
        inputs: {
          databaseImage: "db:fixture",
          pasImage: "pas:fixture",
          seed: "input:seed",
          applicationArchive: "input:archive"
        }
      } as any,
      scenario as any
    );
    const run = platform.repositories.getRun(exp.runIds[0])!;
    runner.checkWorkload = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        state: "exited",
        capturedAt: new Date().toISOString(),
        exitCode: 0,
        oomKilled: false
      };
    };
    await (platform.coordinator as any).verifyWorkload(run, {}, Date.now() + 5);
    assert.equal(run.state, "QUEUED");
    await assert.rejects(
      (platform.coordinator as any).verifyWorkload(run, {}, Date.now() + 10000),
      /loadgen_exited_early/
    );
  } finally {
    await platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
