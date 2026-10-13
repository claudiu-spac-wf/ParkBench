import {encodeDatabaseArgv} from '../../packages/compose-runner/src/database-argv';
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveDatabaseRunControls } from "../../packages/contracts/src/database-run-controls";
import { validateDatabaseRunControlsEvidence } from "../../packages/compose-runner/src/database-run-controls-evidence";

const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "licensed run controls apply exactly, preserve the source, restart safely, and clean up owned writers",
  { skip: !enabled, timeout: 300000 },
  async () => {
    const identity = `parkbench-f021-${Date.now().toString(36)}`;
    const image = process.env.PARKBENCH_RUN_CONTROLS_TEST_IMAGE ?? "parkbench/openedge-db:dev";
    const seedVolume = identity + "-seed";
    const containers: string[] = [],
      volumes = [seedVolume];
    const evidence: any[] = [];
    const root = path.resolve(".parkbench/validation/feature021/p1/native-controls");
    fs.mkdirSync(root, { recursive: true });
    docker(["volume", "create", "--label", "org.parkbench.validation=feature021", seedVolume]);
    const seedCommand =
      'mkdir -p /psc/wrk/seed; cd /psc/wrk/seed; procopy "$DLC/prolang/utf/empty8" controls >/dev/null; prostrct list controls >/dev/null; sed -i "s@/psc/wrk/seed/controls.[bd][0-9]*@.@g" controls.st';
    const sourceMetadata = () =>
      docker([
        "run",
        "--rm",
        "--label",
        "org.parkbench.validation=feature021",
        "--entrypoint",
        "sh",
        "-v",
        `${seedVolume}:/seed:ro`,
        image,
        "-c",
        "stat -c '%n %s %Y %a' /seed/seed/controls.*"
      ]);
    const nativeState = async (name: string) => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const status = docker(["inspect", "--format", "{{.State.Status}}", name]);
        if (status === "exited") {
          const logs = spawnSync("docker", ["logs", "--tail", "30", name], {
            encoding: "utf8",
            timeout: 30000
          });
          throw new Error(`native_controls_container_exited:${logs.stdout}${logs.stderr}`);
        }
        try {
          const body = docker([
            "exec",
            name,
            "cat",
            "/psc/wrk/controls/database-run-controls.json"
          ]);
          const state = JSON.parse(body);
          if (state.verification === "matched" && state.writerHealth === "verified") return state;
        } catch {
          /* Startup capture is pending. */
        }
        await delay(500);
      }
      throw new Error("native_controls_readiness_timeout");
    };
    try {
      docker([
        "run",
        "--rm",
        "--label",
        "org.parkbench.validation=feature021",
        "--entrypoint",
        "sh",
        "-v",
        `${seedVolume}:/psc/wrk`,
        image,
        "-c",
        seedCommand
      ]);
      const original = sourceMetadata();
      // Capability is declared explicitly for this licensed fixture and then proved by native membership.
      const cases: Array<{
        apws: number;
        biw: boolean;
        mib?: number;
        buffers?: number;
        failureCode?: string;
        startupWords?: string;
        loss?: boolean;
      }> = [
        { apws: 2, biw: true, mib: 16 },
        { apws: 0, biw: false },
        { apws: 0, biw: false, mib: 0.015625 },
        { apws: 9, biw: true, mib: 255.984375 },
        { apws: 0, biw: true, mib: 0.5 },
        { apws: 2, biw: false, mib: 16 },
        // 12.8.11 raises the documented minimum of 3 to an effective 20; retain the mismatch instead of silently accepting it.
        { apws: 2, biw: false, mib: 16, buffers: 3, failureCode: "database_run_control_unapplied" },
        {
          apws: 2,
          biw: true,
          mib: 16,
          startupWords: "-bibufs=64 -n=4",
          failureCode: "database_writer_capacity_insufficient"
        },
        {
          apws: 2,
          biw: true,
          mib: 16,
          startupWords: "-bibufs=32",
          failureCode: "database_run_control_unapplied"
        },
        { apws: 2, biw: true, mib: 16, loss: true }
      ];
      for (const [index, setting] of cases.entries()) {
        const name = identity + "-" + index,
          volume = name + "-data";
        containers.push(name);
        volumes.push(volume);
        const controls = resolveDatabaseRunControls(
          {},
          {
            "database.apwCount": setting.apws,
            "database.biwEnabled": setting.biw,
            ...(setting.mib === undefined ? {} : { "database.biClusterSizeMiB": setting.mib })
          },
          { version: "12.8.11", features: ["enterprise"] }
        );
        const argvPath=path.join(root,`${name}-broker.argv`);
        const argv=(setting.startupWords??`-bibufs=${setting.buffers??64}`).split(' ').flatMap(assignment=>assignment.split('='));
        fs.writeFileSync(argvPath,encodeDatabaseArgv(argv));
        docker([
          "run",
          "-d",
          "--name",
          name,
          "--label",
          "org.parkbench.validation=feature021",
          "--label",
          `parkbench.run_id=${name}`,
          "--label",
          "parkbench.component=database",
          "-v",
          `${seedVolume}:/run/parkbench/seed/db:ro`,
          "-v",
          `${argvPath}:/run/parkbench/broker.argv:ro`,
          "-v",
          `${volume}:/psc/wrk`,
          "-e",
          "DB_NAME=controls",
          "-e",
          "PARKBENCH_SEED_DB_DIR=/run/parkbench/seed/db/seed",
          "-e",
          `PARKBENCH_SEED_IDENTITY=${seedVolume}`,
          "-e",
          `PARKBENCH_RUN_ID=${name}`,
          "-e",
          `PARKBENCH_APW_COUNT=${setting.apws}`,
          "-e",
          `PARKBENCH_BIW_ENABLED=${setting.biw}`,
          "-e",
          `PARKBENCH_BI_CLUSTER_MODE=${controls.biCluster.mode}`,
          ...(controls.biCluster.mode === "override"
            ? ["-e", `PARKBENCH_BI_CLUSTER_KIB=${controls.biCluster.nativeKiB}`]
            : []),
          "-e",
          "PARKBENCH_DATABASE_ARGV_FILE=/run/parkbench/broker.argv",
          "-e",
          `PARKBENCH_EXPECTED_BI_BUFFERS=${setting.buffers ?? 64}`,
          "-e",
          "PARKBENCH_REQUIRED_DATABASE_CONNECTIONS=4",
          "-e",
          `PARKBENCH_DATABASE_RUN_CONTROLS=${JSON.stringify(controls)}`,
          image
        ]);
        const waitForExit = async () => {
          const deadline = Date.now() + 45000;
          while (Date.now() < deadline) {
            if (docker(["inspect", "--format", "{{.State.Status}}", name]) === "exited") return;
            await delay(500);
          }
          throw new Error("native_writer_failure_not_detected");
        };
        const retained = path.join(root, name + ".json");
        if (setting.failureCode) {
          await waitForExit();
          docker(["cp", `${name}:/psc/wrk/controls/database-run-controls.json`, retained]);
          const state = JSON.parse(fs.readFileSync(retained, "utf8"));
          assert.equal(state.reason, setting.failureCode);
          const ready = spawnSync(
            "docker",
            [
              "cp",
              `${name}:/psc/wrk/controls/.parkbench-controls-ready`,
              path.join(root, name + "-ready")
            ],
            { encoding: "utf8", timeout: 30000 }
          );
          assert.notEqual(ready.status, 0, "failed startup must not publish native readiness");
          evidence.push({ case: setting, state });
          assert.equal(sourceMetadata(), original);
          continue;
        }
        const first = await nativeState(name);
        validateDatabaseRunControlsEvidence(first, controls, setting.buffers ?? 64);
        assert.equal(first.observed.apwCount, setting.apws);
        assert.equal(first.observed.biwCount, Number(setting.biw));
        assert.equal(first.observed.nativeClusterKiB, (setting.mib ?? 0.5) * 1024);
        assert.equal(
          first.preparation.status,
          setting.mib === undefined ? "not_requested" : "prepared"
        );
        const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", name]));
        assert.equal(mounts.find((m: any) => m.Name === seedVolume).RW, false);
        if (index === 0) {
          docker(["restart", "-t", "15", name]);
          const restarted = await nativeState(name);
          validateDatabaseRunControlsEvidence(restarted, controls, 64);
          assert.equal(restarted.preparation.startedAt, first.preparation.startedAt);
          assert.equal(restarted.preparation.finishedAt, first.preparation.finishedAt);
          evidence.push({ case: "same-run-restart", state: restarted });
        }
        evidence.push({ case: setting, state: first });
        if (setting.loss) {
          const user = first.observed.writers.find((w: any) => w.type === "APW").connectionId;
          docker([
            "exec",
            name,
            "proshut",
            "/psc/wrk/controls/controls",
            "-C",
            "disconnect",
            String(user)
          ]);
          await waitForExit();
          docker(["cp", `${name}:/psc/wrk/controls/database-run-controls.json`, retained]);
          const state = JSON.parse(fs.readFileSync(retained, "utf8"));
          assert.equal(state.reason, "database_writer_lost");
          assert.equal(state.writerHealth, "lost");
          evidence.push({ case: "owned-writer-loss", state });
          assert.equal(sourceMetadata(), original);
          continue;
        }
        docker(["stop", "-t", "15", name]);
        docker(["cp", `${name}:/psc/wrk/controls/database-run-controls.json`, retained]);
        assert.equal(JSON.parse(fs.readFileSync(retained, "utf8")).writerHealth, "stopped");
        assert.equal(sourceMetadata(), original);
      }
      const failureVolume = identity + "-prepare-failure";
      volumes.push(failureVolume);
      const failureName = identity + "-offline-failure";
      containers.push(failureName);
      // Change permissions only after repairing the owned copy, so the actual preparation utility fails.
      const result = spawnSync(
        "docker",
        [
          "run",
          "--name",
          failureName,
          "--label",
          "org.parkbench.validation=feature021",
          "--entrypoint",
          "sh",
          "-v",
          `${seedVolume}:/input:ro`,
          "-v",
          `${failureVolume}:/psc/wrk`,
          "-e",
          `PARKBENCH_RUN_ID=${failureName}`,
          "-e",
          `PARKBENCH_SEED_IDENTITY=${seedVolume}`,
          "-e",
          "PARKBENCH_BI_CLUSTER_MODE=override",
          "-e",
          "PARKBENCH_BI_CLUSTER_KIB=16384",
          image,
          "-c",
          "mkdir -p /psc/wrk/controls; /usr/local/bin/parkbench-db-copy-seed.sh /input/seed /psc/wrk/controls controls; chmod 0444 /psc/wrk/controls/controls.b1; exec /usr/local/bin/parkbench-db-prepare-controls.sh /psc/wrk/controls controls"
        ],
        { encoding: "utf8", timeout: 60000 }
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /database_bi_preparation_failed/);
      const preparationFile = path.join(root, "preparation-failure.json");
      docker(["cp", `${failureName}:/psc/wrk/controls/preparation.json`, preparationFile]);
      assert.equal(JSON.parse(fs.readFileSync(preparationFile, "utf8")).status, "failed");
      docker([
        "cp",
        `${failureName}:/psc/wrk/controls/bi-preparation.log`,
        path.join(root, "preparation-failure.log")
      ]);
      assert.equal(sourceMetadata(), original);
      fs.writeFileSync(
        path.join(root, "acceptance.json"),
        JSON.stringify(
          {
            version: "12.8.11",
            sourceMetadataUnchanged: true,
            sourceReadOnly: true,
            cases: evidence
          },
          null,
          2
        )
      );
    } finally {
      for (const name of containers) {
        for (const file of [
          "database-run-controls.json",
          "preparation.json",
          "startup-state.json",
          "startup-state.log",
          "writer-start.log",
          "bi-preparation.log"
        ])
          try {
            docker(["cp", `${name}:/psc/wrk/controls/${file}`, path.join(root, name + "-" + file)]);
          } catch {
            /* Capture may not exist yet. */
          }
      }
      if (process.env.PARKBENCH_RETAIN_FAILED_RUN_CONTROLS !== "1")
        for (const name of containers)
          try {
            docker(["rm", "-f", name]);
          } catch {
            /* Already removed. */
          }
      if (process.env.PARKBENCH_RETAIN_FAILED_RUN_CONTROLS !== "1")
        for (const name of volumes)
          try {
            docker(["volume", "rm", name]);
          } catch {
            /* Retain on a failed cleanup. */
          }
    }
  }
);
