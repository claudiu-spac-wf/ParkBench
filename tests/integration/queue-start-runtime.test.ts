import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";

function stagedRuntime(check: (root: string) => void): void {
  const root = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-control-runtime-"));
  try {
    fs.cpSync(path.join(root, "dist/packages"), path.join(temporary, "dist/packages"), {
      recursive: true
    });
    const dockerfile = fs.readFileSync(path.join(root, "docker/control-plane/Dockerfile"), "utf8");
    for (const [, source, destination] of dockerfile.matchAll(
      /^COPY (scripts\/lib\/\S+) (\S+)\s*$/gm
    )) {
      const target = path.join(temporary, destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, source), target);
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
    check(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function generateInRuntime(root: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
    const {generateRunCompose}=require('./dist/packages/compose-runner/src/run-compose.js');
    const bundle=generateRunCompose('run-fixture','exp-fixture',${JSON.stringify(scenario)},
      {db:'db:fixture',pas:'pas:fixture'}, {loadgenImage:'loadgen:fixture',observerImage:'observer:fixture'});
    if(!bundle.file.includes('mem_limit: \"10g\"')) throw new Error('memory limit missing');
  `
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PARKBENCH_DB_MEMORY_LIMIT: "10g",
        PARKBENCH_PLATFORM_CPUSET: "0",
        PARKBENCH_DB_CPUSET: "1",
        PARKBENCH_PAS_CPUSET: "2"
      }
    }
  );
}

test("control-plane shipped runtime generates Compose with its CPU and memory helpers", () => {
  stagedRuntime((root) => {
    const result = generateInRuntime(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});

test("a missing nested runtime dependency retains its specific diagnostic", () => {
  stagedRuntime((root) => {
    fs.rmSync(path.join(root, "scripts/lib/db-memory.cjs"), { force: true });
    const result = generateInRuntime(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot find module '\.\/db-memory\.cjs'/);
    assert.doesNotMatch(result.stderr, /parkbench_cpuset_helper_not_found/);
  });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-queue-preparation-"));
  const orchestrator = new FakeRunOrchestrator();
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true, orchestrator, phaseScale: 0, requiredDiskIo: false }
  );
  const create = () =>
    platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "fixture", name: "Fixture", parameters: {} }],
        inputs: {
          databaseImage: "db:fixture",
          pasImage: "pas:fixture",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      } as any,
      scenario as any
    );
  return {
    platform,
    orchestrator,
    create,
    close: () => {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function finished(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "experiment did not reach a terminal state");
}

test("preparation failure is persisted without provisioning and releases the experiment slot", async () => {
  const f = fixture();
  const previous = process.env.PARKBENCH_DB_MEMORY_LIMIT;
  try {
    const failed = f.create();
    const next = f.create();
    process.env.PARKBENCH_DB_MEMORY_LIMIT = "invalid";
    f.platform.coordinator.startExperiment(failed.id);
    await finished(() => f.platform.repositories.getExperiment(failed.id)?.status === "FAILED");
    const run = f.platform.repositories.getRun(failed.runIds[0])!;
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureKind, "infrastructure");
    assert.match(run.failureReason ?? "", /platform_setting_invalid:PARKBENCH_DB_MEMORY_LIMIT/);
    assert.equal(run.cleanupStatus, "COMPLETE");
    assert.ok(run.finishedAt);
    assert.deepEqual(f.orchestrator.calls, []);
    process.env.PARKBENCH_DB_MEMORY_LIMIT = "10g";
    f.platform.coordinator.startExperiment(next.id);
    await finished(() => f.platform.repositories.getExperiment(next.id)?.status !== "RUNNING");
    assert.ok(f.orchestrator.calls.includes("provision"));
  } finally {
    if (previous === undefined) delete process.env.PARKBENCH_DB_MEMORY_LIMIT;
    else process.env.PARKBENCH_DB_MEMORY_LIMIT = previous;
    f.close();
  }
});

test("an unknown experiment does not reserve the single experiment slot", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.platform.coordinator.startExperiment("unknown"), /experiment_not_found/);
    const next = f.create();
    f.platform.coordinator.startExperiment(next.id);
    await finished(() => f.platform.repositories.getExperiment(next.id)?.status !== "RUNNING");
    assert.ok(f.orchestrator.calls.includes("provision"));
  } finally {
    f.close();
  }
});

test("unexpected finalizer failure is contained and reports outstanding cleanup honestly", async () => {
  const f = fixture();
  const oldSecret = process.env.PARKBENCH_TEST_SECRET;
  process.env.PARKBENCH_TEST_SECRET = "queue-private-value";
  try {
    (f.platform.coordinator as any).finalizer.finalize = async () => {
      throw new Error("finalizer queue-private-value failed");
    };
    const experiment = f.create();
    f.platform.coordinator.startExperiment(experiment.id);
    await finished(() => f.platform.repositories.getExperiment(experiment.id)?.status === "FAILED");
    const run = f.platform.repositories.getRun(experiment.runIds[0])!;
    assert.equal(run.state, "FAILED");
    assert.equal(run.cleanupStatus, "PARTIAL");
    assert.match(run.failureReason ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(run.failureReason ?? "", /queue-private-value/);
    const next = f.create();
    f.platform.coordinator.startExperiment(next.id);
    await finished(() => f.platform.repositories.getExperiment(next.id)?.status === "FAILED");
  } finally {
    if (oldSecret === undefined) delete process.env.PARKBENCH_TEST_SECRET;
    else process.env.PARKBENCH_TEST_SECRET = oldSecret;
    f.close();
  }
});

test("repeated starts of the active experiment cannot launch concurrent runs", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.orchestrator.waitForReady = async () => gate;
  try {
    const experiment = f.create();
    const next = f.create();
    f.platform.coordinator.startExperiment(experiment.id);
    f.platform.coordinator.startExperiment(experiment.id);
    assert.throws(
      () => f.platform.coordinator.startExperiment(next.id),
      /one_active_experiment_limit/
    );
    assert.equal(f.orchestrator.calls.filter((call) => call === "provision").length, 1);
    release();
    await finished(
      () => f.platform.repositories.getExperiment(experiment.id)?.status !== "RUNNING"
    );
  } finally {
    release();
    f.close();
  }
});
