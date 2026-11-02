import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { compileDatabaseSetup } from "../../apps/control-plane/src/database-setup/compile-plan";
import { DatabaseSetup } from "../../packages/contracts/src/database-setup";
const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024
  }).trim();
function requireRunning(run: string) {
  const state = docker(["inspect", "--format", "{{.State.Status}}", run]);
  if (state === "exited" || state === "dead")
    throw new Error(`native_setup_container_exited:${docker(["logs", run])}`);
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined, timeout = 90000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await pause(250);
  }
  throw new Error("native_setup_test_wait_expired");
}
const nativeSetup: DatabaseSetup = {
  contractVersion: "database-setup.v1",
  steps: [
    {
      id: "build",
      definitionId: "idxbuild",
      optionSets: [
        { id: "c", scope: "table", table: "PUB.SetupCustomer" },
        { id: "o", scope: "table", table: "PUB.SetupOrder" }
      ]
    },
    {
      id: "compact",
      definitionId: "idxcompact",
      optionSets: [
        { id: "c", index: "PUB.SetupCustomer.CustomerId" },
        { id: "o", index: "PUB.SetupOrder.OrderId", compactionPercent: 75 }
      ]
    },
    ...["reorg", "reorg-again"].map((id) => ({
      id,
      definitionId: "tablereorg" as const,
      optionSets: [
        { id: "c", table: "PUB.SetupCustomer", useIndex: "CustomerId" },
        { id: "o", table: "PUB.SetupOrder", useIndex: "OrderId" }
      ]
    }))
  ]
};
test(
  "licensed run-owned setup preserves modified data, fences replay and hands off to distinct normal brokers for four runs",
  { skip: !enabled, timeout: 600000 },
  async () => {
    const image = process.env.PARKBENCH_DATABASE_SETUP_TEST_IMAGE;
    assert(image, "explicit opt-in requires PARKBENCH_DATABASE_SETUP_TEST_IMAGE");
    const id = `parkbench-f023-life-${Date.now().toString(36)}`,
      label = "org.parkbench.validation=feature023",
      root = path.resolve(".parkbench/validation/feature023/native-lifecycle", id);
    fs.mkdirSync(root, { recursive: true });
    const volumes: string[] = [],
      containers: string[] = [],
      timeline: any[] = [];
    let deleted = false;
    const call = (args: string[]) => {
      const result = docker(args);
      timeline.push({ at: new Date().toISOString(), args, stdout: result });
      return result;
    };
    const seed = id + "-seed";
    volumes.push(seed);
    const metadata = () =>
      docker([
        "run",
        "--rm",
        "--label",
        label,
        "--entrypoint",
        "sh",
        "-v",
        `${seed}:/source:ro`,
        image,
        "-c",
        "stat -c '%n %s %Y %a' /source/testdb/*"
      ]);
    try {
      call(["image", "inspect", image]);
      call(["volume", "create", "--label", label, seed]);
      call([
        "run",
        "--rm",
        "--label",
        label,
        "--entrypoint",
        "sh",
        "-v",
        `${seed}:/psc/wrk`,
        "-v",
        `${path.resolve("tests/fixtures/database-setup/native")}:/fixture:ro`,
        image,
        "-ec",
        'mkdir -p /psc/wrk/testdb; cd /psc/wrk/testdb; procopy "$DLC/prolang/utf/empty8" testdb; prostrct add testdb /fixture/areas.st; pro -b -db testdb -p /fixture/load.p; pro -b -db testdb -p /fixture/populate.p; prostrct list testdb; sed -i "s@/psc/wrk/testdb/testdb[^[:space:]]*@.@g" testdb.st'
      ]);
      const original = metadata();
      for (const buffers of [500, 1000])
        for (const repetition of [1, 2]) {
          const run = `${id}-b${buffers}-r${repetition}`,
            volume = run + "-data";
          volumes.push(volume);
          containers.push(run);
          call(["volume", "create", "--label", label, volume]);
          const plan = compileDatabaseSetup({
            runId: run,
            attemptId: "attempt-1",
            setup: nativeSetup,
            runtimeDirectory: path.join(root, run),
            databaseName: "testdb",
            image
          });
          const broker = path.join(root, run, "broker.argv");
          fs.writeFileSync(broker, `-B\n${buffers}\n`);
          fs.chmodSync(broker, 0o644);
          call([
            "run",
            "-d",
            "--name",
            run,
            "--label",
            label,
            "--restart",
            "no",
            "-v",
            `${volume}:/psc/wrk`,
            "-v",
            `${seed}:/run/parkbench/seed:ro`,
            "-v",
            `${broker}:/run/parkbench/broker.argv:ro`,
            "-v",
            `${plan.manifest.paths.input}:/run/parkbench/setup-input:ro`,
            "-v",
            `${plan.manifest.paths.output}:/run/parkbench/setup-output`,
            "-v",
            `${plan.manifest.paths.control}:/run/parkbench/setup-control`,
            "-e",
            "DB_NAME=testdb",
            "-e",
            `PARKBENCH_RUN_ID=${run}`,
            "-e",
            "PARKBENCH_SETUP_ATTEMPT_ID=attempt-1",
            "-e",
            "PARKBENCH_SEED_DB_DIR=/run/parkbench/seed/testdb",
            "-e",
            "PARKBENCH_DATABASE_ARGV_FILE=/run/parkbench/broker.argv",
            "-e",
            "PARKBENCH_DATABASE_RUN_CONTROLS=fixture-bi-preparation",
            "-e",
            "PARKBENCH_BI_CLUSTER_MODE=override",
            "-e",
            "PARKBENCH_BI_CLUSTER_KIB=16384",
            image
          ]);
          const statusPath = path.join(plan.manifest.paths.output, "status.json");
          const status = await until(() => {
            if (!fs.existsSync(statusPath)) return;
            const value = JSON.parse(fs.readFileSync(statusPath, "utf8"));
            if (value.state === "FAILED") throw new Error(JSON.stringify(value));
            if (value.state === "SUCCEEDED") return value;
            requireRunning(run);
            return undefined;
          });
          assert.equal(status.phase, "awaiting-normal-start");
          assert(!fs.existsSync(path.join(plan.manifest.paths.output, "normal-started")));
          call(["exec", run, "proutil", "/psc/wrk/testdb/testdb", "-C", "busy"]);
          const before = call([
            "exec",
            run,
            "sh",
            "-c",
            "stat -c '%n %s %Y' /psc/wrk/testdb/.parkbench-bi-prepared /psc/wrk/testdb/preparation.json"
          ]);
          fs.writeFileSync(
            path.join(plan.manifest.paths.control, "normal-start-release"),
            `${run}:attempt-1\n`
          );
          await until(() =>
            fs.existsSync(path.join(plan.manifest.paths.output, "normal-started"))
              ? true
              : undefined
          );
          const busy = spawnSync(
            "docker",
            ["exec", run, "proutil", "/psc/wrk/testdb/testdb", "-C", "busy"],
            { encoding: "utf8" }
          );
          assert.equal(busy.status, 6, busy.stdout + busy.stderr);
          const normalPids = call(["exec", run, "pgrep", "-x", "_mprosrv"]).split(/\s+/);
          for (const ordinal of ["0003", "0004"]) {
            const temporaryPids = fs
              .readFileSync(
                path.join(plan.manifest.paths.output, "steps", ordinal, "broker.pids"),
                "utf8"
              )
              .trim()
              .split(/\s+/);
            assert(temporaryPids.every((pid) => !normalPids.includes(pid)));
            assert(
              fs.existsSync(
                path.join(plan.manifest.paths.output, "steps", ordinal, "shutdown.confirmed")
              )
            );
          }
          const logs = call(["logs", run]);
          assert.equal((logs.match(/seed_copy_seconds=/g) ?? []).length, 1);
          // Stop, then replay this exact attempt: the fence must precede copy or BI mutation.
          call(["stop", "--time", "30", run]);
          call(["start", run]);
          await until(() =>
            call(["inspect", "--format", "{{.State.Status}}", run]) === "exited" ? true : undefined
          );
          assert.equal(call(["inspect", "--format", "{{.State.ExitCode}}", run]), "71");
          assert.equal((call(["logs", run]).match(/seed_copy_seconds=/g) ?? []).length, 1);
          const after = call([
            "run",
            "--rm",
            "--label",
            label,
            "--entrypoint",
            "sh",
            "-v",
            `${volume}:/psc/wrk:ro`,
            image,
            "-c",
            "stat -c '%n %s %Y' /psc/wrk/testdb/.parkbench-bi-prepared /psc/wrk/testdb/preparation.json"
          ]);
          assert.equal(after, before);
        }
      assert.equal(metadata(), original, "read-only source metadata must remain unchanged");
    } finally {
      for (const name of containers) docker(["rm", "-f", name]);
      for (const volume of volumes) docker(["volume", "rm", volume]);
      deleted = true;
      fs.writeFileSync(
        path.join(root, "evidence.json"),
        JSON.stringify({ image, timeline, deleted }, null, 2)
      );
    }
  }
);

import { readDatabaseSetupEvidence } from "../../packages/compose-runner/src/database-setup-evidence";
test(
  "licensed custom shell outcomes and detached-process barriers block progression, cancellation and unconfirmed scopes",
  { skip: !enabled, timeout: 300000 },
  async () => {
    const image = process.env.PARKBENCH_DATABASE_SETUP_TEST_IMAGE;
    assert(image, "explicit native opt-in requires a setup image");
    const id = `parkbench-f023-custom-${Date.now().toString(36)}`,
      root = path.resolve(".parkbench/validation/feature023/native-lifecycle", id),
      scripts = path.join(root, "source"),
      label = "org.parkbench.validation=feature023";
    fs.mkdirSync(scripts, { recursive: true });
    const source = path.join(scripts, "prepare.sh");
    fs.writeFileSync(
      source,
      `#!/bin/sh
printf 'cwd=%s\\n' "$PWD"
printf '<%s>\\n' "$@"
case "\${1:-}" in
 fail) exit 7 ;;
 detach)
   /usr/local/lib/parkbench/validation-detach /run/parkbench/setup-control
   ;;
esac
exit 0
`,
      { mode: 0o644 }
    );
    const sourceMetadata = () => {
      const stat = fs.statSync(source);
      return { size: stat.size, mtime: stat.mtimeMs, mode: stat.mode & 0o777 };
    };
    const original = sourceMetadata();
    const volumes: string[] = [],
      containers: string[] = [],
      results: any[] = [];
    const seed = id + "-seed";
    volumes.push(seed);
    try {
      docker(["volume", "create", "--label", label, seed]);
      docker([
        "run",
        "--rm",
        "--label",
        label,
        "--entrypoint",
        "sh",
        "-v",
        `${seed}:/psc/wrk`,
        image,
        "-ec",
        'mkdir -p /psc/wrk/testdb; cd /psc/wrk/testdb; procopy "$DLC/prolang/utf/empty8" testdb; prostrct list testdb; sed -i "s@/psc/wrk/testdb/testdb[^[:space:]]*@.@g" testdb.st'
      ]);
      for (const mode of [
        "success",
        "pipeline",
        "trailing",
        "outer",
        "missing-primary",
        "cancel",
        "unconfirmed"
      ]) {
        const run = id + "-" + mode,
          volume = run + "-data";
        volumes.push(volume);
        containers.push(run);
        docker(["volume", "create", "--label", label, volume]);
        const inputs =
          mode === "success"
            ? ["", '"customer group" --mode=fast\n\n', "detach", "after"]
            : mode === "pipeline"
              ? ["fail | cat", "never"]
              : mode === "trailing"
                ? ["fail; true", "never"]
                : mode === "outer"
                  ? ["; false", "never"]
                  : mode === "missing-primary"
                    ? [">", "never"]
                    : ["detach", "never"];
        const setup: DatabaseSetup = {
          contractVersion: "database-setup.v1",
          steps: [
            {
              id: "c",
              definitionId: "custom",
              scriptRef: "input:scripts/prepare.sh",
              optionSets: inputs.map((input, i) => ({ id: `o-${i}`, input }))
            }
          ]
        };
        const plan = compileDatabaseSetup({
          runId: run,
          attemptId: "attempt-1",
          setup,
          runtimeDirectory: path.join(root, run),
          databaseName: "testdb",
          image,
          scriptsRoot: scripts
        });
        docker([
          "run",
          "-d",
          "--name",
          run,
          "--label",
          label,
          "--restart",
          "no",
          "-v",
          `${volume}:/psc/wrk`,
          "-v",
          `${seed}:/run/parkbench/seed:ro`,
          "-v",
          `${plan.manifest.paths.input}:/run/parkbench/setup-input:ro`,
          "-v",
          `${plan.manifest.paths.output}:/run/parkbench/setup-output`,
          "-v",
          `${plan.manifest.paths.control}:/run/parkbench/setup-control`,
          "-e",
          "DB_NAME=testdb",
          "-e",
          `PARKBENCH_RUN_ID=${run}`,
          "-e",
          "PARKBENCH_SETUP_ATTEMPT_ID=attempt-1",
          "-e",
          "PARKBENCH_SEED_DB_DIR=/run/parkbench/seed/testdb",
          image
        ]);
        if (["success", "cancel", "unconfirmed"].includes(mode)) {
          const pending = await until(() => {
            const value = readDatabaseSetupEvidence(plan.manifest);
            if (value.phase === "waiting-processes") return value;
            if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state))
              throw new Error(`native_detached_fixture_did_not_wait:${JSON.stringify(value)}`);
            requireRunning(run);
            return undefined;
          });
          assert.equal(pending.state, "RUNNING");
          const setIndex = mode === "success" ? 2 : 0;
          assert.equal(pending.steps[0].optionSets[setIndex].primaryExitStatus, 0);
          assert.equal(pending.steps[0].optionSets[setIndex].processScopeState, "ACTIVE");
          assert(
            !fs.existsSync(
              path.join(
                plan.manifest.paths.output,
                `steps/0001/${mode === "success" ? "0004" : "0002"}.json`
              )
            )
          );
          assert(!fs.existsSync(path.join(plan.manifest.paths.output, "normal-started")));
          if (mode === "success")
            fs.writeFileSync(path.join(plan.manifest.paths.control, "child-release"), "");
          else if (mode === "cancel")
            fs.writeFileSync(path.join(plan.manifest.paths.control, "cancel"), "");
          else {
            const pid = docker(["exec", run, "pgrep", "-x", "custom-supervis"]).trim();
            assert(/^[0-9]+$/.test(pid));
            docker(["exec", run, "sh", "-c", 'kill -KILL "$1"', "sh", pid]);
          }
        }
        const evidence = await until(() => {
          const value = readDatabaseSetupEvidence(plan.manifest);
          if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state)) return value;
          requireRunning(run);
          return undefined;
        });
        results.push({ mode, evidence, configuration: setup });
        const first = evidence.steps[0].optionSets[0];
        if (mode === "success") {
          assert.equal(evidence.state, "SUCCEEDED");
          assert(
            evidence.steps[0].optionSets.every(
              (set) =>
                set.primaryExitStatus === 0 &&
                set.shellExitStatus === 0 &&
                set.processScopeState === "QUIESCENT" &&
                set.quiescentAt
            )
          );
          assert(
            docker(["exec", run, "cat", "/psc/wrk/testdb/native-child-result"]).includes("modified")
          );
          docker(["exec", run, "proutil", "/psc/wrk/testdb/testdb", "-C", "busy"]);
          const stdout = fs.readFileSync(
            path.join(plan.manifest.paths.output, "steps/0001/0002.stdout"),
            "utf8"
          );
          assert(stdout.includes("cwd=/psc/wrk/testdb"));
          assert(stdout.includes("<customer group>"));
        } else if (mode === "cancel") {
          assert.equal(evidence.state, "CANCELLED");
          assert.equal(first.processScopeState, "QUIESCENT");
        } else {
          assert.equal(evidence.state, "FAILED");
          assert.equal(evidence.steps[0].optionSets[1].state, "NOT_EXECUTED");
          if (mode === "pipeline" || mode === "trailing") {
            assert.equal(first.primaryExitStatus, 7);
            assert.equal(first.shellExitStatus, 0);
            assert.equal(first.exitStatus, 7);
          }
          if (mode === "outer") {
            assert.equal(first.primaryExitStatus, 0);
            assert.equal(first.shellExitStatus, 1);
            assert.equal(first.exitStatus, 1);
          }
          if (mode === "missing-primary") {
            assert.equal(first.primaryInvocationObserved, false);
            assert.equal(evidence.failure?.code, "database_setup_evidence_invalid");
          }
          if (mode === "unconfirmed") {
            assert.equal(first.processScopeState, "UNCONFIRMED");
            assert.equal(first.exitStatus, null);
            assert.equal(evidence.failure?.code, "database_setup_process_unconfirmed");
            assert.equal(evidence.cleanup, "UNCERTAIN");
          }
        }
        assert(!fs.existsSync(path.join(plan.manifest.paths.output, "normal-started")));
      }
      assert.deepEqual(sourceMetadata(), original);
      // Only the compiled libc helper is shipped; build tools and the C source stay in the build stage.
      docker([
        "run",
        "--rm",
        "--label",
        label,
        "--entrypoint",
        "sh",
        image,
        "-ec",
        "/usr/local/lib/parkbench/setup/custom-supervisor --check; ! command -v gcc; test ! -f /usr/local/lib/parkbench/setup/custom-supervisor.c"
      ]);
    } finally {
      const cleanup: any[] = [];
      for (const name of containers) {
        const result = spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
        cleanup.push({ name, exit: result.status });
      }
      for (const volume of volumes) {
        const result = spawnSync("docker", ["volume", "rm", volume], { encoding: "utf8" });
        cleanup.push({ volume, exit: result.status });
      }
      fs.writeFileSync(
        path.join(root, "evidence.json"),
        JSON.stringify(
          {
            image,
            results,
            sourceMetadata: original,
            cleanup,
            deleted: cleanup.every((item) => item.exit === 0)
          },
          null,
          2
        )
      );
      assert(
        cleanup.every((item) => item.exit === 0),
        "all native validation resources must be deleted"
      );
    }
  }
);
