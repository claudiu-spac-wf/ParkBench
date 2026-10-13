import { inspectSeedStartupFile } from "../../packages/compose-runner/src/input-checks";
import { generateRunCompose } from "../../packages/compose-runner/src/run-compose";
import { databaseParameterInput } from "../../packages/contracts/src/database-parameter-options";
import scenario from "../../examples/scenarios/crud-rest.json";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  databaseParameterTokens,
  validateDatabaseParameterConfiguration,
  databaseParameterOptions
} from "../../packages/contracts/src/database-parameter-options";
import { encodeDatabaseArgv } from "../../packages/compose-runner/src/database-argv";
import { resolveDatabaseRunControls } from "../../packages/contracts/src/database-run-controls";
import { deriveDatabaseParameterSnapshot } from "../../packages/observers/src/openedge-db/parameter-snapshot";
import { resolveDatabaseStartup } from "../../packages/contracts/src/matrix-expansion";
const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "licensed catalog exercises documented boundaries, literal text, enum case and valued false with retained native evidence",
  { skip: !enabled, timeout: 300000 },
  async () => {
    const prefix = `parkbench-f021-catalog-${Date.now().toString(36)}`,
      seed = prefix + "-seed",
      image = "parkbench/openedge-db:dev";
    const names: string[] = [],
      volumes = [seed],
      evidence: any[] = [];
    const root = path.resolve(".parkbench/validation/feature021/p3/native-catalog");
    fs.mkdirSync(root, { recursive: true });
    const caps = databaseParameterOptions({ version: "12.8.11", features: ["enterprise"] });
    const pfRoot = path.join(root, "controlled-pf");
    fs.mkdirSync(pfRoot, { recursive: true });
    const pf = "/run/parkbench/seed/db/extra.pf";
    fs.writeFileSync(path.join(pfRoot, "nested.pf"), '-spin 3\n-diagPrefix "PF literal space"\n');
    fs.writeFileSync(path.join(pfRoot, "extra.pf"), "-B 1000\n-pf nested.pf\n");
    const inspection = inspectSeedStartupFile(pfRoot, [pf]);
    const pfStartup = resolveDatabaseStartup(
      { ...inspection, entries: inspection.parsed.entries },
      { "-B": 500 },
      { "-pf": pf, "-B": 1500, "-bibufs": 64 }
    );
    const pfBundle = generateRunCompose(
      prefix + "-pf",
      "validation",
      scenario as any,
      { db: image, pas: "parkbench/openedge-pasoe:dev" },
      { parameters: { "-pf": pf, "-B": 1500, "-bibufs": 64 }, databaseStartup: pfStartup }
    );
    assert.doesNotMatch(pfBundle.brokerArgv, /-pf/);
    assert.match(pfBundle.brokerArgv, /-B\n1500\n/);
    const pfValues = Object.fromEntries(
      pfStartup.parameters
        .filter((p) => p.name !== "-pf")
        .map((p) => [p.name, databaseParameterInput(p.name, p.displayValue)])
    );
    const cases: Record<string, string | number | boolean>[] = [
      {
        "-numCheckpointStats": 8,
        "-prefetchFactor": 0,
        "-diagEvtLevel": -15,
        "-diagFS": " ",
        "-secsize": 0,
        "-threadedServer": false,
        "-ssj": false,
        "-ipver": "ipv4",
        "-diagPrefix": "literal space",
        "-T": "/psc/wrk/parkbench/literal spaces"
      },
      {
        "-numCheckpointStats": 1024,
        "-prefetchFactor": 100,
        "-diagEvtLevel": 15,
        "-secsize": 32768,
        "-threadedServer": true,
        "-ssj": true,
        "-schlockwq": true,
        "-diagFormat": "JSON",
        "-diagPrefix": 'quote "value"'
      },
      {
        "-TXERetryLimit": 100000,
        "-TXESkipLimit": 100000,
        "-diagPause": 0,
        "-lgTruncateSize": 1,
        "-lgArchiveEnable": true,
        "-limitLgPayload": false
      },
      pfValues
    ];
    try {
      docker(["volume", "create", "--label", "org.parkbench.validation=feature021", seed]);
      docker([
        "run",
        "--rm",
        "--label",
        "org.parkbench.validation=feature021",
        "--entrypoint",
        "sh",
        "-v",
        `${seed}:/psc/wrk`,
        image,
        "-c",
        'mkdir -p /psc/wrk/seed; cd /psc/wrk/seed; procopy "$DLC/prolang/utf/empty8" parkbench >/dev/null; prostrct list parkbench >/dev/null; sed -i "s@/psc/wrk/seed/parkbench.[bd][0-9]*@.@g" parkbench.st'
      ]);
      const source = () =>
        docker([
          "run",
          "--rm",
          "--label",
          "org.parkbench.validation=feature021",
          "--entrypoint",
          "sh",
          "-v",
          `${seed}:/seed:ro`,
          image,
          "-c",
          "stat -c '%n %s %Y %a' /seed/seed/parkbench.*"
        ]);
      const before = source();
      for (const [i, values] of cases.entries()) {
        validateDatabaseParameterConfiguration(values, caps);
        for (const [name, lo, hi] of [
          ["-numCheckpointStats", 8, 1024],
          ["-prefetchFactor", 0, 100],
          ["-diagEvtLevel", -15, 15]
        ] as const) {
          assert.throws(() => validateDatabaseParameterConfiguration({ [name]: lo - 1 }, caps));
          assert.throws(() => validateDatabaseParameterConfiguration({ [name]: hi + 1 }, caps));
        }
        const name = prefix + "-" + i,
          volume = name + "-data",
          argvFile = path.join(root, name + "-broker.argv");
        names.push(name);
        volumes.push(volume);
        const requested = { "-bibufs": 64, ...values };
        const tokens = Object.entries(requested).flatMap(([key, value]) =>
          databaseParameterTokens(key, value)
        );
        fs.writeFileSync(argvFile, i === 3 ? pfBundle.brokerArgv : encodeDatabaseArgv(tokens));
        const dirsFile = path.join(root, name + "-directories");
        fs.writeFileSync(dirsFile, encodeDatabaseArgv(values["-T"] ? [String(values["-T"])] : []));
        const controls = resolveDatabaseRunControls(
          {},
          { "database.apwCount": 0, "database.biwEnabled": false },
          { version: "12.8.11", features: ["enterprise"] }
        );
        docker([
          "run",
          "-d",
          "--name",
          name,
          "--label",
          "org.parkbench.validation=feature021",
          "--label",
          `parkbench.run_id=${name}`,
          "-v",
          `${seed}:/run/parkbench/seed/db:ro`,
          "-v",
          `${volume}:/psc/wrk`,
          "-v",
          `${argvFile}:/run/parkbench/broker.argv:ro`,
          "-v",
          `${dirsFile}:/run/parkbench/broker-directories:ro`,
          "-e",
          "DB_NAME=parkbench",
          "-e",
          "PARKBENCH_SEED_DB_DIR=/run/parkbench/seed/db/seed",
          "-e",
          `PARKBENCH_RUN_ID=${name}`,
          "-e",
          `PARKBENCH_DATABASE_RUN_CONTROLS=${JSON.stringify(controls)}`,
          "-e",
          "PARKBENCH_APW_COUNT=0",
          "-e",
          "PARKBENCH_BIW_ENABLED=false",
          "-e",
          "PARKBENCH_BI_CLUSTER_MODE=inherit",
          "-e",
          "PARKBENCH_EXPECTED_BI_BUFFERS=64",
          "-e",
          "PARKBENCH_REQUIRED_DATABASE_CONNECTIONS=4",
          "-e",
          "PARKBENCH_DATABASE_ARGV_FILE=/run/parkbench/broker.argv",
          image
        ]);
        let state: any;
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          if (docker(["inspect", "--format", "{{.State.Status}}", name]) === "exited") {
            const logs = docker(["logs", name]);
            const retained = docker([
              "run",
              "--rm",
              "--label",
              "org.parkbench.validation=feature021",
              "--entrypoint",
              "sh",
              "-v",
              `${volume}:/retain:ro`,
              image,
              "-c",
              "cat /retain/parkbench/parkbench.lg 2>/dev/null || true"
            ]);
            fs.writeFileSync(path.join(root, name + "-failed.log"), logs + "\n" + retained);
            throw new Error(`native_catalog_exit:${logs}\n${retained}`);
          }
          try {
            state = JSON.parse(
              docker(["exec", name, "cat", "/psc/wrk/parkbench/database-run-controls.json"])
            );
            if (state.verification === "matched") break;
          } catch {}
          await delay(500);
        }
        assert.equal(state?.verification, "matched");
        const body = docker([
          "run",
          "--rm",
          "--label",
          "org.parkbench.validation=feature021",
          "--network",
          `container:${name}`,
          "--entrypoint",
          "parkbench-openedge-db-observer",
          "-e",
          "PARKBENCH_OBSERVER_READ_ONLY=true",
          "-e",
          "DB_NAME=parkbench",
          "-e",
          "DB_HOST=127.0.0.1",
          "-e",
          "DB_BROKER_PORT=20931",
          "parkbench/openedge-observer:dev",
          "/app/openedge/observers/db/parkbench-db-observer-v2.r",
          "parameter-capture"
        ]);
        const capture = JSON.parse(body.slice(body.indexOf("{")));
        const startup = resolveDatabaseStartup(
          { startupFile: { status: "absent" }, entries: [], databaseName: "parkbench" },
          {},
          requested
        );
        const snapshot = deriveDatabaseParameterSnapshot(
          capture,
          { runId: name, experimentId: prefix, variantId: String(i), repetition: 1 },
          startup
        );
        const mismatches = snapshot.verificationResults.filter(
          (r) => r.verification === "mismatched"
        );
        assert.deepEqual(mismatches, []);
        fs.writeFileSync(path.join(root, name + "-capture.json"), JSON.stringify(capture, null, 2));
        fs.writeFileSync(
          path.join(root, name + "-snapshot.json"),
          JSON.stringify(snapshot, null, 2)
        );
        fs.writeFileSync(path.join(root, name + "-startup.log"), docker(["logs", name]));
        evidence.push({
          runId: name,
          requested,
          tokens,
          ...(i === 3 ? { frozenParameterFile: pfStartup } : {}),
          nativeReadiness: state,
          verificationResults: snapshot.verificationResults
        });
        docker(["stop", "-t", "30", name]);
        docker(["rm", name]);
        docker(["volume", "rm", volume]);
      }
      assert.equal(source(), before);
      fs.writeFileSync(
        path.join(root, "acceptance.json"),
        JSON.stringify({ sourceUnchanged: true, sourceMetadata: before, cases: evidence }, null, 2)
      );
    } finally {
      for (const name of names)
        spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 60000 });
      for (const volume of volumes)
        spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore", timeout: 60000 });
    }
  }
);
