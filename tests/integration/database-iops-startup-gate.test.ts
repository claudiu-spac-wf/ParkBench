import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { writerHarness } from "../helpers/writer-supervision";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const setup of [false, true])
  test(`finite gate allows preparation/setup uncapped and holds benchmark startup until verified release, setup=${setup}`, async () => {
    const h = writerHarness(),
      gate = path.join(h.root, "gate");
    fs.mkdirSync(gate);
    const copy = path.join(h.root, "copy.sh"),
      entry = path.join(h.root, "entry.sh"),
      prepare = path.join(h.root, "prepare.sh"),
      lifecycle = path.join(h.root, "lifecycle.sh");
    fs.writeFileSync(
      copy,
      '#!/bin/sh\nif [ "${4:-}" = --repair-copied ]; then echo repair >> "$TRACE"; else echo copy >> "$TRACE"; echo repair >> "$TRACE"; fi\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(prepare, '#!/bin/sh\necho preparation >> "$TRACE"\n', { mode: 0o755 });
    fs.copyFileSync("docker/openedge-db/controls-lifecycle.sh", lifecycle);
    fs.chmodSync(lifecycle, 0o755);
    for (const [name, body] of Object.entries({
      proserve: 'echo broker >> "$TRACE"',
      pgrep: "exit 0",
      proshut: 'echo shutdown >> "$TRACE"'
    }))
      fs.writeFileSync(path.join(h.root, "bin", name), "#!/bin/sh\n" + body + "\n", {
        mode: 0o755
      });
    const setupScript = path.join(h.root, "setup.sh");
    fs.writeFileSync(
      setupScript,
      '#!/bin/sh\nif [ "$1" != claim ]; then echo setup-$1 >> "$TRACE"; fi\nif [ "$1" = execute ]; then sleep 3.2; fi\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      entry,
      fs
        .readFileSync("docker/openedge-db/entrypoint.sh", "utf8")
        .replaceAll("/usr/local/bin/parkbench-db-copy-seed.sh", copy)
        .replace(
          "/usr/local/bin/parkbench-db-startup-gate.sh",
          path.resolve("docker/openedge-db/startup-gate.sh")
        )
        .replace("/usr/local/bin/parkbench-db-prepare-controls.sh", prepare)
        .replace("/usr/local/bin/parkbench-db-controls-lifecycle.sh", lifecycle)
        .replaceAll("/usr/local/lib/parkbench/setup/run-setup.sh", setupScript)
    );
    const child = spawn("sh", [entry], {
      env: {
        ...h.env,
        DB_NAME: "controls",
        PARKBENCH_DB_WORKDIR: h.root,
        PARKBENCH_DATABASE_RUN_CONTROLS: "fixture",
        PARKBENCH_RUN_ID: "owned-run",
        PARKBENCH_EXECUTION_REVISION: "revision",
        PARKBENCH_IOPS_GATE_NONCE: "fresh-nonce",
        PARKBENCH_IOPS_GATE_DIR: gate,
        PARKBENCH_IOPS_GATE_TIMEOUT_SECONDS: "3",
        ...(setup ? { PARKBENCH_SETUP_ATTEMPT_ID: "setup", PARKBENCH_SETUP_OUTPUT: gate } : {})
      },
      stdio: "ignore"
    });
    const exit = new Promise((resolve) => child.once("exit", resolve));
    try {
      const until = Date.now() + 6000;
      while (!fs.existsSync(path.join(gate, "held")) && Date.now() < until) await pause(10);
      assert.equal(
        fs.readFileSync(path.join(gate, "held"), "utf8").trim(),
        "owned-run:revision:fresh-nonce"
      );
      assert.deepEqual(
        fs.readFileSync(h.env.TRACE, "utf8").trim().split("\n"),
        setup
          ? ["copy", "repair", "preparation", "setup-execute", "setup-wait"]
          : ["copy", "repair", "preparation"]
      );
      fs.writeFileSync(path.join(gate, "release"), "owned-run:old-revision:old-nonce\n");
      await pause(80);
      assert.deepEqual(
        fs.readFileSync(h.env.TRACE, "utf8").trim().split("\n"),
        setup
          ? ["copy", "repair", "preparation", "setup-execute", "setup-wait"]
          : ["copy", "repair", "preparation"]
      );
      fs.writeFileSync(path.join(gate, "release.tmp"), "owned-run:revision:fresh-nonce\n");
      fs.renameSync(path.join(gate, "release.tmp"), path.join(gate, "release"));
      const ready = Date.now() + 2000;
      while (!fs.existsSync(path.join(h.db, ".parkbench-controls-ready")) && Date.now() < ready)
        await pause(10);
      assert.ok(fs.existsSync(path.join(h.db, ".parkbench-controls-ready")));
      const trace = fs.readFileSync(h.env.TRACE, "utf8").trim().split("\n");
      assert.ok(trace.indexOf("repair") > trace.indexOf("copy"));
      assert.ok(trace.indexOf("preparation") > trace.indexOf("repair"));
      assert.ok(trace.indexOf("broker") > trace.indexOf("preparation"));
      if (setup) assert.ok(trace.indexOf("setup-execute") > trace.indexOf("preparation"));
      assert.ok(fs.existsSync(path.join(gate, "consumed")));
      child.kill("SIGTERM");
      await exit;
    } finally {
      child.kill("SIGTERM");
      await Promise.race([exit, pause(1000)]);
      child.kill("SIGKILL");
      h.close();
    }
  });

test("durable release requires verified matching intent, current revision and deadline; restart never retracts possibly consumed release", async () => {
  const os = await import("node:os"),
    {
      createDatabaseStartupGate,
      startupGateBinding,
      publishDatabaseStartupRelease,
      inspectDatabaseStartupGate
    } = await import("../../packages/compose-runner/src/database-iops-startup-gate");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-release-"));
  try {
    const gate = createDatabaseStartupGate("owned", "revision", root, 30000);
    fs.mkdirSync(gate.directory);
    fs.writeFileSync(path.join(gate.directory, "held"), startupGateBinding(gate));
    const good: any = {
      verification: { status: "MATCHED" },
      applicationOutcome: "VERIFIED",
      applicationIntent: {
        runId: gate.runId,
        executionRevision: gate.executionRevision,
        startupNonce: gate.nonce
      }
    };
    for (const invalid of [
      { ...good, verification: { status: "PENDING" } },
      { ...good, applicationOutcome: "PENDING" },
      { ...good, applicationIntent: { ...good.applicationIntent, executionRevision: "old" } },
      { ...good, applicationIntent: { ...good.applicationIntent, startupNonce: "old" } }
    ]) {
      assert.throws(
        () => publishDatabaseStartupRelease(gate, invalid, Date.now() + 10000, () => false),
        /database_iops_unconfirmed/
      );
      assert.equal(fs.existsSync(path.join(gate.directory, "release")), false);
    }
    assert.throws(
      () => publishDatabaseStartupRelease(gate, good, Date.now() + 10000, () => true),
      /run_cancelled/
    );
    assert.throws(
      () => publishDatabaseStartupRelease(gate, good, Date.now() - 1, () => false),
      /database_iops_apply_failed/
    );
    assert.throws(
      () =>
        publishDatabaseStartupRelease(
          gate,
          good,
          Date.now() + 10000,
          () => false,
          () => {
            throw Error("execution_revision_stale");
          }
        ),
      /revision_stale/
    );
    assert.deepEqual(inspectDatabaseStartupGate(gate), {
      observedStage: "HELD",
      releasePossiblyConsumed: false
    });
    assert.equal(inspectDatabaseStartupGate(gate, true).releasePossiblyConsumed, true);
    publishDatabaseStartupRelease(gate, good, Date.now() + 10000, () => false);
    assert.equal(
      fs.readFileSync(path.join(gate.directory, "release"), "utf8"),
      startupGateBinding(gate)
    );
    assert.equal(inspectDatabaseStartupGate(gate).observedStage, "RELEASE_POSSIBLE");
    fs.renameSync(path.join(gate.directory, "release"), path.join(gate.directory, "consumed"));
    assert.equal(inspectDatabaseStartupGate(gate).observedStage, "CONSUMED");
    assert.throws(
      () => publishDatabaseStartupRelease(gate, good, Date.now() + 10000, () => false),
      /database_iops_unconfirmed/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("old images cannot claim finite startup or writer-supervision capabilities", async () => {
  const { requireDatabaseStartupCapabilities } =
    await import("../../packages/compose-runner/src/database-startup-capabilities");
  assert.throws(
    () => requireDatabaseStartupCapabilities({}, { finite: true, writers: true, setup: false }),
    /database_writer_unavailable/
  );
  assert.throws(
    () =>
      requireDatabaseStartupCapabilities(
        { "org.parkbench.writer-supervision": "writer-supervision.v1" },
        { finite: true, writers: true, setup: false }
      ),
    /database_iops_unsupported/
  );
  assert.throws(
    () =>
      requireDatabaseStartupCapabilities(
        {
          "org.parkbench.writer-supervision": "writer-supervision.v1",
          "org.parkbench.database-iops-startup": "database-iops-startup.v1"
        },
        { finite: true, writers: true, setup: false }
      ),
    /database_iops_unsupported/
  );
  requireDatabaseStartupCapabilities(
    {
      "org.parkbench.writer-supervision": "writer-supervision.v1",
      "org.parkbench.database-iops-startup": "database-iops-startup.v2",
      "org.parkbench.database-setup": "database-setup.v1"
    },
    { finite: true, writers: true, setup: true }
  );
});

for (const mode of ["deadline", "cancel", "consumed"] as const)
  test(`native held gate ${mode} never releases startup`, async () => {
    const os = await import("node:os");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-held-gate-"));
    if (mode === "consumed") fs.writeFileSync(path.join(root, "consumed"), "old execution");
    const child = spawn("sh", [path.resolve("docker/openedge-db/startup-gate.sh")], {
        env: {
          ...process.env,
          PARKBENCH_IOPS_GATE_DIR: root,
          PARKBENCH_RUN_ID: "owned",
          PARKBENCH_EXECUTION_REVISION: "revision",
          PARKBENCH_IOPS_GATE_NONCE: "nonce",
          PARKBENCH_IOPS_GATE_TIMEOUT_SECONDS: "1"
        },
        stdio: "ignore"
      }),
      exit = new Promise((resolve) => child.once("exit", resolve));
    try {
      if (mode === "cancel") {
        const until = Date.now() + 1000;
        while (!fs.existsSync(path.join(root, "held")) && Date.now() < until) await pause(10);
        fs.writeFileSync(path.join(root, "cancel"), "cancel");
      }
      assert.notEqual(await exit, 0);
      if (mode !== "consumed") assert.equal(fs.existsSync(path.join(root, "consumed")), false);
      assert.equal(fs.existsSync(path.join(root, "database-started")), false);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
