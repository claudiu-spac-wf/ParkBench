import assert from "node:assert/strict";
import test from "node:test";
import { runControlFixture } from "../helpers/run-controls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  DockerComposeOrchestrator,
  FakeRunOrchestrator
} from "../../packages/compose-runner/src/orchestrator";
import { DatabaseRunControlsError } from "../../packages/compose-runner/src/database-run-controls-evidence";
import { createPlatform } from "../../apps/control-plane/src/platform";
import scenario from "../../examples/scenarios/crud-rest.json";
import { resolveDatabaseRunControls } from "../../packages/contracts/src/database-run-controls";
import type { ComposeBundle } from "../../packages/compose-runner/src/run-compose";

for (const cancel of [false, true])
  test(`native readiness failure retains evidence and ${cancel ? "preserves cancellation" : "blocks workload"}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-control-gate-"));
    const runner = new FakeRunOrchestrator();
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
      { testMode: true, orchestrator: runner, phaseScale: 0 }
    );
    const evidence = {
      contractVersion: "db-run-controls-evidence.v1" as const,
      capturedAt: new Date().toISOString(),
      verification: "mismatched" as const,
      writerHealth: "unavailable" as const,
      reason: "database_run_control_unapplied",
      preparation: { status: "prepared" }
    };
    let runId = "";
    runner.waitForReady = async () => {
      runner.calls.push("ready");
      if (cancel) platform.coordinator.cancel(runId);
      throw new DatabaseRunControlsError(evidence.reason, evidence);
    };
    try {
      await platform.startupRecovery;
      const experiment = platform.coordinator.createExperiment(
        {
          scenario: { id: scenario.id, version: scenario.version },
          comparisonMode: "exploratory",
          repetitions: 1,
          variants: [{ id: "v", name: "Variant", parameters: {} }],
          inputs: {
            databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
            pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
            seed: "input:seed/fixture",
            applicationArchive: "input:archive/fixture"
          }
        },
        scenario as any
      );
      runId = experiment.runIds[0];
      const run = await platform.coordinator.executeRun(platform.repositories.getRun(runId)!);
      assert.equal(run.state, cancel ? "CANCELLED" : "FAILED");
      assert.equal(run.failureKind, cancel ? "cancellation" : "infrastructure");
      assert.deepEqual(run.environmentSnapshot?.databaseRunControlEvidence, evidence);
      assert.equal(runner.calls.includes("start-workload"), false);
      assert.equal(run.cleanupStatus, "COMPLETE");
      assert.ok(runner.calls.indexOf("logs") < runner.calls.indexOf("cleanup"));
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("writer loss during measurement fails with retained evidence and cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-active-writer-loss-"));
  const runner = new FakeRunOrchestrator();
  const capture = runner.checkDatabaseRunControls.bind(runner);
  let checks = 0;
  runner.checkDatabaseRunControls = async (bundle) => {
    const evidence = (await capture(bundle))!;
    if (++checks === 3)
      throw new DatabaseRunControlsError("database_writer_lost", {
        ...evidence,
        verification: "mismatched",
        writerHealth: "lost",
        reason: "database_writer_lost"
      });
    return evidence;
  };
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: { version: "12.8.11", databaseFeatures: ["enterprise"] }
    },
    { testMode: true, orchestrator: runner, phaseScale: 0 }
  );
  try {
    await platform.startupRecovery;
    const experiment = platform.coordinator.createExperiment(
      {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "v", name: "Variant", parameters: { "database.apwCount": 2 } }],
        inputs: {
          databaseImage: `db:fixture@sha256:${"0123456789abcdef".repeat(4)}`,
          pasImage: `pas:fixture@sha256:${"abcdef0123456789".repeat(4)}`,
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      },
      scenario as any
    );
    const run = await platform.coordinator.executeRun(
      platform.repositories.getRun(experiment.runIds[0])!
    );
    assert.ok(run.measuringAt);
    assert.ok(run.phaseBoundaries?.measurement?.startedAt);
    assert.equal(run.state, "FAILED");
    assert.equal(run.failureCode, "database_writer_lost");
    assert.equal(run.failureKind, "infrastructure");
    assert.equal((run.environmentSnapshot?.databaseRunControlEvidence as any).writerHealth, "lost");
    assert.ok((run.environmentSnapshot?.databaseRunControlEvidence as any).lastSuccessAt);
    assert.ok(runner.calls.includes("start-workload"));
    assert.equal(run.cleanupStatus, "COMPLETE");
    assert.equal(platform.repositories.getSummaryCache(run.id).status, "READY");
  } finally {
    platform.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native diagnostic tails survive stopped-container capture and reject foreign ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-native-logs-"));
  const bundle = {
    projectName: "owned-logs",
    file: "",
    databaseName: "controls",
    databaseRunControls: resolveDatabaseRunControls(),
    resources: [{ name: "database", labels: { "parkbench.run_id": "run-owned" } }]
  } as unknown as ComposeBundle;
  const runner = new DockerComposeOrchestrator(root);
  let foreign = false;
  let copied = 0;
  (runner as any).command = async (args: string[]) => {
    if (args.includes("logs")) return { stdout: "compose-output", stderr: "compose-error" };
    if (args.includes("ps")) return { stdout: "a".repeat(64), stderr: "" };
    if (args[0] === "inspect")
      return {
        stdout: JSON.stringify({
          "parkbench.run_id": foreign ? "other" : "run-owned",
          "parkbench.component": "database"
        }),
        stderr: ""
      };
    if (args[0] === "cp") {
      copied++;
      fs.writeFileSync(
        args[2],
        args[1].includes("startup-state.log")
          ? "x".repeat(70000) + "native-capture-failed"
          : "retained-native-detail"
      );
      return { stdout: "", stderr: "" };
    }
    throw new Error("unexpected_command:" + args.join(" "));
  };
  try {
    const logs = await runner.collectLogs(bundle);
    assert.match(logs, /compose-output/);
    assert.match(logs, /compose-error/);
    assert.match(logs, /startup-state.log/);
    assert.match(logs, /native-capture-failed/);
    assert.match(logs, /bi-preparation.log/);
    assert.ok(logs.length < 270000);
    assert.ok(copied >= 3);
    foreign = true;
    copied = 0;
    const rejected = await runner.collectLogs(bundle);
    assert.equal(copied, 0);
    assert.doesNotMatch(rejected, /retained-native-detail/);
    assert.match(rejected, /ownership_mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writerHarness(changes: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-writer-lifecycle-"));
  const bin = path.join(root, "bin"),
    db = path.join(root, "controls");
  fs.mkdirSync(bin);
  fs.mkdirSync(db);
  const scripts: Record<string, string> = {
    mpro: `for arg do prefix=$arg; done
echo native >> "$TRACE"
a=$(wc -l < "$LEDGER_APW"); b=$(wc -l < "$LEDGER_BIW")
if [ -f .parkbench-controls-ready ] && [ "\${LOSE:-0}" = 1 ]; then a=0; fi
apids=; bpids=; i=0
while [ "$i" -lt "$a" ]; do i=$((i+1)); apids=\${apids:+$apids,}$((100+i)); done
if [ "$b" -gt 0 ]; then bpids=201; fi
printf 'clusterKiB=16384\nbiBuffers=%s\ncapacity=%s\napwCount=%s\nbiwCount=%s\napwPids=%s\nbiwPids=%s\n' "\${BUFFERS:-64}" "\${CAPACITY:-21}" "$a" "$b" "$apids" "$bpids" > "$prefix.env"
printf '{"contractVersion":"db-startup-state.v1","capturedAt":"2026-10-03T00:00:00Z","apwCount":%s,"biwCount":%s,"writers":[]}' "$a" "$b" > "$prefix.json"`,
    proapw: 'echo apw >> "$TRACE"; echo apw >> "$LEDGER_APW"; exit "${WRITER_EXIT:-0}"',
    probiw: 'echo biw >> "$TRACE"; echo biw >> "$LEDGER_BIW"',
    ps: 'pid=$2; kind=apw; [ "$pid" -ne 201 ] || kind=biw; [ "${WRONG_MEMBER:-0}" != 1 ] || kind=other; echo "/psc/dlc/bin/_mprshut $OWNED_DB -C $kind"',
    sleep: "exec /bin/sleep 0.02"
  };
  for (const [name, script] of Object.entries(scripts))
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nset -eu\n" + script + "\n", { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    TRACE: path.join(root, "trace"),
    LEDGER_APW: path.join(root, "apws"),
    LEDGER_BIW: path.join(root, "biws"),
    OWNED_DB: path.join(db, "controls"),
    PARKBENCH_APW_COUNT: "2",
    PARKBENCH_BIW_ENABLED: "true",
    PARKBENCH_BI_CLUSTER_KIB: "16384",
    PARKBENCH_EXPECTED_BI_BUFFERS: "64",
    ...changes
  };
  fs.writeFileSync(env.LEDGER_APW, "");
  fs.writeFileSync(env.LEDGER_BIW, "");
  const args = [path.resolve("docker/openedge-db/controls-lifecycle.sh"), db, "controls"];
  return {
    root,
    db,
    env,
    args,
    run: () => spawnSync("sh", args, { env, encoding: "utf8", timeout: 5000 }),
    close: () => fs.rmSync(root, { recursive: true, force: true })
  };
}
test("entrypoint orders copy, repair, preparation, broker and native writer match before owned shutdown", async () => {
  const h = writerHarness();
  const copy = path.join(h.root, "copy.sh"),
    prepare = path.join(h.root, "prepare.sh"),
    entry = path.join(h.root, "entrypoint.sh"),
    lifecycle = path.join(h.root, "lifecycle.sh");
  fs.copyFileSync("docker/openedge-db/controls-lifecycle.sh", lifecycle);
  fs.chmodSync(lifecycle, 0o755);
  fs.writeFileSync(copy, '#!/bin/sh\necho copy >> "$TRACE"\necho repair >> "$TRACE"\n', {
    mode: 0o755
  });
  fs.writeFileSync(prepare, '#!/bin/sh\necho preparation >> "$TRACE"\n', { mode: 0o755 });
  for (const [name, body] of Object.entries({
    proserve: 'echo broker >> "$TRACE"',
    pgrep: "exit 0",
    proshut: 'echo shutdown >> "$TRACE"'
  }))
    fs.writeFileSync(path.join(h.root, "bin", name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  fs.writeFileSync(
    entry,
    fs
      .readFileSync("docker/openedge-db/entrypoint.sh", "utf8")
      .replace("/usr/local/bin/parkbench-db-copy-seed.sh", copy)
      .replace("/usr/local/bin/parkbench-db-prepare-controls.sh", prepare)
      .replace("/usr/local/bin/parkbench-db-controls-lifecycle.sh", lifecycle)
  );
  const child = spawn("sh", [entry], {
    env: {
      ...h.env,
      DB_NAME: "controls",
      PARKBENCH_DB_WORKDIR: h.root,
      PARKBENCH_DATABASE_RUN_CONTROLS: "fixture"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(path.join(h.db, ".parkbench-controls-ready")) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(h.db, ".parkbench-controls-ready")), output);
    assert.deepEqual(fs.readFileSync(h.env.TRACE, "utf8").trim().split("\n").slice(0, 9), [
      "copy",
      "repair",
      "preparation",
      "broker",
      "native",
      "apw",
      "apw",
      "biw",
      "native"
    ]);
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(fs.readFileSync(h.env.TRACE, "utf8").trim().split("\n").at(-1), "shutdown");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8"))
        .writerHealth,
      "stopped"
    );
  } finally {
    child.kill("SIGKILL");
    h.close();
  }
});
test("writer loss retains native startup match and owned launch order", () => {
  const h = writerHarness({ LOSE: "1" });
  try {
    const result = h.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database_writer_lost/);
    assert.ok(fs.existsSync(path.join(h.db, ".parkbench-controls-ready")));
    const evidence = JSON.parse(
      fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8")
    );
    assert.equal(evidence.writerHealth, "lost");
    assert.ok(evidence.lastSuccessAt);
    assert.deepEqual(fs.readFileSync(h.env.TRACE, "utf8").trim().split("\n").slice(0, 5), [
      "native",
      "apw",
      "apw",
      "biw",
      "native"
    ]);
  } finally {
    h.close();
  }
});
test("startup rejects capacity, BI mismatch, failed launch and foreign writer membership", () => {
  for (const [change, code] of [
    [{ CAPACITY: "6" }, "database_writer_capacity_insufficient"],
    [{ BUFFERS: "32" }, "database_run_control_unapplied"],
    [{ WRITER_EXIT: "1" }, "database_writer_start_failed"],
    [{ WRONG_MEMBER: "1" }, "database_writer_start_failed"]
  ] as const) {
    const h = writerHarness(change);
    try {
      const r = h.run();
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(code));
      assert.equal(fs.existsSync(path.join(h.db, ".parkbench-controls-ready")), false);
    } finally {
      h.close();
    }
  }
});
test("planned writer shutdown remains stopped rather than writer loss", async () => {
  const h = writerHarness();
  const child = spawn("sh", h.args, { env: h.env, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(path.join(h.db, ".parkbench-controls-ready")) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(h.db, ".parkbench-controls-ready")));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8"))
        .writerHealth,
      "stopped"
    );
  } finally {
    child.kill("SIGKILL");
    h.close();
  }
});

test("offline preparation is owned, exact, restart-safe and preserves native failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-bi-preparation-"));
  const bin = path.join(root, "bin"),
    db = path.join(root, "owned");
  fs.mkdirSync(bin);
  fs.mkdirSync(db);
  fs.writeFileSync(
    path.join(bin, "proutil"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\necho native-truncate-output\nexit "${NATIVE_EXIT:-0}"\n',
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    TRACE: path.join(root, "trace"),
    PARKBENCH_RUN_ID: "run-preparation",
    PARKBENCH_BI_CLUSTER_MODE: "override",
    PARKBENCH_BI_CLUSTER_KIB: "16384"
  };
  const prepare = (changes: Record<string, string> = {}) =>
    spawnSync("sh", [path.resolve("docker/openedge-db/prepare-controls.sh"), db, "controls"], {
      encoding: "utf8",
      env: { ...env, ...changes }
    });
  try {
    assert.equal(prepare().status, 0);
    assert.equal(fs.readFileSync(env.TRACE, "utf8").trim(), "controls -C truncate bi -bi 16384");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(db, "preparation.json"), "utf8")).status,
      "prepared"
    );
    fs.writeFileSync(path.join(db, ".parkbench-broker-used"), "run-preparation\n");
    assert.equal(prepare().status, 0);
    assert.equal(fs.readFileSync(env.TRACE, "utf8").trim().split("\n").length, 1);
    assert.match(
      prepare({ PARKBENCH_BI_CLUSTER_KIB: "512" }).stderr,
      /database_bi_preparation_failed.*identity/
    );
    assert.match(
      prepare({ PARKBENCH_RUN_ID: "another-run" }).stderr,
      /database_bi_preparation_failed.*identity/
    );
    fs.rmSync(path.join(db, "preparation.json"));
    assert.match(prepare().stderr, /database_bi_preparation_failed.*already_used/);
    fs.rmSync(path.join(db, ".parkbench-broker-used"));
    const failed = prepare({ NATIVE_EXIT: "7" });
    assert.notEqual(failed.status, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(db, "preparation.json"), "utf8")).status,
      "failed"
    );
    assert.match(
      fs.readFileSync(path.join(db, "bi-preparation.log"), "utf8"),
      /native-truncate-output/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queued control choices are immutable across later scenario edits", async () => {
  const { platform, document } = runControlFixture();
  try {
    await platform.startupRecovery;
    const preview = platform.controlUi.preview({
      runName: "frozen-writers",
      scenario: { id: document.id, version: document.version },
      dimensions: [],
      fixedOverrides: {
        "-bibufs": 64,
        "database.apwCount": 0,
        "database.biClusterSizeMiB": 0.5,
        "database.biwEnabled": false
      },
      repetitions: 1
    });
    const experiment = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
    document.parameterDefinitions = [];
    platform.scenarios.register({ ...document, version: "2.0.0" });
    const queued = platform.repositories.getRun(experiment.runs[0].id)!;
    const controls = queued.environmentSnapshot?.databaseRunControls as any;
    assert.equal(controls.apwCount, 0);
    assert.equal(controls.biwEnabled, false);
    assert.deepEqual(controls.biCluster, { mode: "override", requestedMiB: 0.5, nativeKiB: 512 });
    const metadata = platform.controlRepository.getRunMetadata(queued.id)!;
    assert.deepEqual(metadata.snapshot.databaseRunControls, controls);
  } finally {
    platform.close();
  }
});

test("required named collector contract failure fails readiness without waiting for an infrastructure timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-named-readiness-"));
  const controls = resolveDatabaseRunControls();
  controls.requirements = { namedLatchRequired: true, observerProtocolVersion: 4 };
  const bundle = {
    projectName: "owned-named",
    file: "owned-named.yml",
    databaseRunControls: controls
  } as ComposeBundle;
  const runner = new DockerComposeOrchestrator(root);
  (runner as any).command = async (args: string[]) => ({
    stdout: args.includes("ps")
      ? JSON.stringify([
          { Service: "database", State: "running" },
          { Service: "pas-1", State: "running" }
        ])
      : args.includes("db-observer")
        ? "named_latch_evidence_missing"
        : "200",
    stderr: ""
  });
  try {
    await assert.rejects(
      runner.waitForReady(bundle, scenario as any, 1000),
      /named_latch_evidence_missing:collector_contract/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
