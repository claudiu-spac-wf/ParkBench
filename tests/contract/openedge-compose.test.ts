import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
import { generateRunCompose } from "../../packages/compose-runner/src";
import { dockerHostPath, mapContainerPath } from "../../packages/compose-runner/src/orchestrator";
import { createTemporaryPathFixture } from "../helpers/environment-fixture";
import { imageReference } from "../helpers/openedge";
import { createSeedFixture } from "../helpers/seed";

describe("OpenEdge Compose contract", () => {
  it("shares mutable workload files through an isolated directory mount", () => {
    const runtimeDirectory = path.resolve(".parkbench/runs/run-directory/runtime");
    const bundle = generateRunCompose(
      "run-directory",
      "exp-directory",
      scenario as any,
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test"),
        runtimeDirectory,
        summaryPath: path.join(runtimeDirectory, "summary.json"),
        shutdownPath: path.join(runtimeDirectory, "shutdown"),
        workloadStartPath: path.join(runtimeDirectory, "workload-start"),
        phaseClockPath: path.join(runtimeDirectory, "phase-clock.json")
      }
    );
    assert.ok(bundle.file.includes(`${runtimeDirectory}:/run/parkbench/runtime:rw`));
    for (const file of ["summary.json", "shutdown", "workload-start", "phase-clock.json"])
      assert.ok(bundle.file.includes(`/run/parkbench/runtime/${file}`));
    assert.doesNotMatch(
      bundle.file,
      /:\/run\/parkbench\/(?:shutdown|workload-start|phase-clock\.json):/
    );
    assert.ok(bundle.localPaths.includes(runtimeDirectory));
  });

  it("keeps host-side bind mounts unchanged when only a Docker host root is configured", () => {
    const localPath = "/home/operator/.parkbench/runs/run.yml";
    assert.equal(
      dockerHostPath(localPath, {
        PARKBENCH_DOCKER_HOST_PATH_ROOT: "/home/operator/.parkbench"
      }),
      localPath
    );
    assert.throws(
      () => dockerHostPath(localPath, { PARKBENCH_CONTAINER_PATH_ROOT: "/var/lib/parkbench" }),
      /docker_host_path_mapping_required/
    );
  });

  it("maps seed folders through the seeds root's own host path", () => {
    fs.mkdirSync(path.resolve(".parkbench"), { recursive: true });
    const root = fs.mkdtempSync(path.resolve(".parkbench", "seed-mapping-"));
    try {
      const containerRoot = path.join(root, "container");
      const seed = createSeedFixture(path.join(containerRoot, "seeds"));
      const env = {
        PARKBENCH_CONTAINER_PATH_ROOT: containerRoot,
        PARKBENCH_DOCKER_HOST_PATH_ROOT: path.join(root, "data"),
        PARKBENCH_DISCOVERY_SEEDS_ROOT: path.join(containerRoot, "seeds"),
        PARKBENCH_DOCKER_HOST_SEEDS_ROOT: "/mnt/d/Projects/PUG/BenchmarkDb"
      };
      assert.equal(dockerHostPath(seed, env), "/mnt/d/Projects/PUG/BenchmarkDb/one_gb_lnx");
      // Without the seeds mapping, seeds fall back to the data root, as before.
      assert.equal(
        dockerHostPath(seed, { ...env, PARKBENCH_DOCKER_HOST_SEEDS_ROOT: "" }),
        path.join(root, "data", "seeds", "one_gb_lnx")
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the ParkBench runner topology and run-owned mounts", () => {
    const bundle = generateRunCompose(
      "run-compose",
      "exp-compose",
      scenario as any,
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        seed: "./.parkbench/test-seeds/one_gb_lnx",
        databaseName: "parkbench",
        schemaReadinessProcedures: ["Workloads/ParkBench/bank_mix.p"],
        applicationArchive: "./.parkbench/test-oepas1.zip",
        summaryPath: "./.parkbench/runs/run-compose/summary.json",
        shutdownPath: "./.parkbench/runs/run-compose/shutdown",
        workloadStartPath: "./.parkbench/runs/run-compose/workload-start",
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test"),
        variantId: "baseline"
      }
    );
    assert.match(bundle.file, /PARKBENCH_TARGET_BASE_URL: "http:\/\/pas:8810\/parkbench\/web"/);
    assert.match(
      bundle.file,
      new RegExp(`run-metrics:\\n        aliases:\\n          - ${bundle.projectName}-file-sampler`)
    );
    assert.match(bundle.file, /run-db-data:\/psc\/wrk/);
    assert.match(bundle.file, /run-service-data-pas-1:\/psc\/wrk/);
    assert.match(
      bundle.file,
      new RegExp(
        `${path.resolve(".parkbench/test-oepas1.zip")}:\\/deploy\\/artifacts\\/oepas1\\.zip`
      )
    );
    assert.match(bundle.file, /run-db-data:\/psc\/wrk:ro/);
    assert.match(bundle.file, /\/run\/parkbench\/shutdown:rw/);
    assert.match(bundle.file, /\/run\/parkbench\/workload-start:ro/);
    assert.match(bundle.file, /DB_BROKER_PORT: "20931"/);
    assert.ok(
      bundle.file.includes(
        `${path.resolve(".parkbench/test-seeds/one_gb_lnx")}:/run/parkbench/seed/db:ro`
      )
    );
    assert.equal((bundle.file.match(/DB_NAME: "parkbench"/g) ?? []).length, 2);
    assert.match(bundle.file, /PARKBENCH_PAS_DB_CONNECTION: "-db parkbench -H database -S 20931"/);
    // The DB observer reads its label sets from the run database itself.
    assert.doesNotMatch(bundle.file, /PARKBENCH_DB_LABELS_FILE|observer-labels/);
    assert.match(
      bundle.file,
      /PARKBENCH_SCHEMA_READINESS_PROCEDURES: "Workloads\/ParkBench\/bank_mix\.p"/
    );
    assert.match(bundle.file, /PARKBENCH_FILE_SAMPLER_PATH: "\/psc\/wrk\/parkbench"/);
    assert.doesNotMatch(bundle.file, /sports/i);
    assert.match(bundle.file, /DB_MINPORT: "20932"/);
    assert.match(bundle.file, /DB_MAXPORT: "20941"/);
    assert.equal((bundle.file.match(/PARKBENCH_PAS_PROTOCOL:/g) ?? []).length, 1);
    assert.equal((bundle.file.match(/PARKBENCH_RUN_ID:/g) ?? []).length, 5);
    assert.equal((bundle.file.match(/PARKBENCH_EXPERIMENT_ID:/g) ?? []).length, 4);
  });

  it("isolates every PAS replica writable volume", () => {
    const bundle = generateRunCompose(
      "run-compose-replicas",
      "exp-compose",
      { ...(scenario as any), target: { ...(scenario as any).target, pasReplicas: 2 } },
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test")
      }
    );
    assert.match(bundle.file, /run-service-data-pas-1:/);
    assert.match(bundle.file, /run-service-data-pas-2:/);
    assert.equal(bundle.resources.filter((resource) => resource.type === "volume").length, 3);
  });

  it("uses the packaged observer procedure without creating a host mount", () => {
    const bundle = generateRunCompose(
      "run-packaged-observer",
      "exp-compose",
      scenario as any,
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test"),
        dbObserverExecutable: "parkbench-openedge-db-observer",
        dbObserverProcedure: "/app/openedge/observers/db/parkbench-db-observer.p"
      }
    );
    assert.match(
      bundle.file,
      /PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE: \/app\/openedge\/observers\/db\/parkbench-db-observer\.p/
    );
    assert.doesNotMatch(
      bundle.file,
      /\/app\/openedge\/observers\/db\/parkbench-db-observer\.p:\/run\/parkbench\/parkbench-db-observer\.p/
    );
  });

  it("runs the database observer in the OpenEdge observer image", () => {
    const bundle = generateRunCompose(
      "run-openedge-observer-image",
      "exp-compose",
      scenario as any,
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test"),
        dbObserverImage: imageReference("openedge-observer", "test"),
        dbObserverExecutable: "parkbench-openedge-db-observer",
        dbObserverProcedure: "/app/openedge/observers/db/parkbench-db-observer.r"
      }
    );

    assert.match(
      bundle.file,
      new RegExp(`db-observer:\\n    image: ${imageReference("openedge-observer", "test")}`)
    );
    assert.match(
      bundle.file,
      new RegExp(`pas-observer:\\n    image: ${imageReference("observer", "test")}`)
    );
    assert.match(
      bundle.file,
      new RegExp(`file-sampler:\\n    image: ${imageReference("observer", "test")}`)
    );
  });

  it("passes credential values through Compose without serializing them", () => {
    const bundle = generateRunCompose(
      "run-credential",
      "exp-compose",
      scenario as any,
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        credentialRef: "credential:pas-tomcat",
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test")
      }
    );
    assert.match(
      bundle.file,
      /PARKBENCH_CREDENTIAL_PAS_TOMCAT: "\$\{PARKBENCH_CREDENTIAL_PAS_TOMCAT\}"/
    );
    assert.doesNotMatch(bundle.file, /Basic|password/i);
  });

  it("translates mapped run inputs from the control-plane namespace to the Docker host", () => {
    const fixture = createTemporaryPathFixture("parkbench-run-path-map-");
    try {
      const containerRoot = fixture.resolve("container root");
      const hostRoot = fixture.resolve("docker host root");
      fs.mkdirSync(containerRoot, { recursive: true });
      const containerInput = `${containerRoot}/openedge inputs/seed dir`;
      const bundle = generateRunCompose(
        "run-path-mapping",
        "exp-path-mapping",
        scenario as any,
        { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
        {
          seed: containerInput,
          applicationArchive: `${containerRoot}/openedge inputs/app archive.zip`,
          loadgenImage: imageReference("loadgen", "test"),
          observerImage: imageReference("observer", "test")
        }
      );

      assert.equal(
        mapContainerPath(containerInput, containerRoot, hostRoot),
        `${hostRoot}/openedge inputs/seed dir`
      );
      assert.match(bundle.file, /openedge inputs\/seed dir:\/run\/parkbench\/seed\/db/);
      // The Docker renderer rewrites exact "<local path>:" prefixes, so the mounted seed folder
      // must be listed for control-plane-to-host translation.
      assert.ok(bundle.localPaths.includes(containerInput));
      assert.match(
        bundle.file,
        /openedge inputs\/app archive\.zip:\/deploy\/artifacts\/oepas1\.zip/
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps an external non-symlink input explicit as a bind mount", () => {
    const externalInput = path.resolve("../external fixtures/seed");
    const bundle = generateRunCompose(
      "run-external-input",
      "exp-external-input",
      scenario as any,
      { db: imageReference("db", "test"), pas: imageReference("pas", "test") },
      {
        seed: externalInput,
        loadgenImage: imageReference("loadgen", "test"),
        observerImage: imageReference("observer", "test")
      }
    );
    assert.match(
      bundle.file,
      new RegExp(`${externalInput.replaceAll("/", "\\/")}:\\/run\\/parkbench\\/seed\\/db`)
    );
    assert.ok(bundle.localPaths.includes(externalInput));
  });

  it("passes frozen literal arguments and managed ranges without reopening an unchecked seed PF", (context) => {
    try {
      execFileSync("docker", ["image", "inspect", "parkbench/openedge-db:dev"], {
        stdio: "ignore"
      });
    } catch {
      context.skip("local database image unavailable");
      return;
    }
    fs.mkdirSync(path.resolve(".parkbench"), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), ".parkbench/entrypoint-"));
    const mockDir = path.join(root, "mockbin");
    const outputDir = path.join(root, "output");
    fs.mkdirSync(mockDir);
    fs.mkdirSync(outputDir);
    try {
      const seed = createSeedFixture(path.join(root, "seeds"), "one_gb_lnx", {
        startupPf: "-B 500\n"
      });
      fs.writeFileSync(
        path.join(mockDir, "proserve"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$PARKBENCH_ARGV_FILE"\n'
      );
      for (const name of ["pgrep", "tail", "prostrct"])
        fs.writeFileSync(path.join(mockDir, name), "#!/bin/sh\nexit 0\n");
      for (const name of ["proserve", "pgrep", "tail", "prostrct"])
        fs.chmodSync(path.join(mockDir, name), 0o755);
      fs.writeFileSync(path.join(mockDir,"broker.argv"),"-B\n1000\n-spin\n2\n-diagPrefix\nliteral $*\n-ssj\n0\n");
      const dockerArgs = (environment: string[]) => [
        "run",
        "--rm",
        "--user",
        "root",
        "--entrypoint",
        "/bin/sh",
        "-v",
        `${path.resolve("docker/openedge-db/entrypoint.sh")}:/entrypoint.sh:ro`,
        "-v",
        `${path.resolve("docker/openedge-db/copy-seed.sh")}:/usr/local/bin/parkbench-db-copy-seed.sh:ro`,
        "-v",
        `${seed}:/run/parkbench/seed/db:ro`,
        "-v",
        `${mockDir}:/mockbin:ro`,
        "-v",
        `${outputDir}:/output:rw`,
        "-e",
        "PATH=/mockbin:/psc/dlc/bin:/usr/bin:/bin",
        "-e",
        "PARKBENCH_DB_WORKDIR=/output",
        "-e",
        "PARKBENCH_DATABASE_ARGV_FILE=/mockbin/broker.argv",
        "-e",
        "PARKBENCH_ARGV_FILE=/output/argv",
        ...environment,
        "parkbench/openedge-db:dev",
        "/entrypoint.sh"
      ];
      execFileSync("docker", dockerArgs(["-e", "DB_NAME=parkbench"]), { stdio: "pipe" });
      assert.deepEqual(fs.readFileSync(path.join(outputDir, "argv"), "utf8").trim().split("\n"), [
        "parkbench",
        "-S",
        "20931",
        "-minport",
        "20932",
        "-maxport",
        "20941",
        "-tablerangesize",
        "64",
        "-indexrangesize",
        "256",
        "-B",
        "1000",
        "-spin",
        "2",
        "-diagPrefix",
        "literal $*",
        "-ssj",
        "0"
      ]);
      assert.throws(
        () => execFileSync("docker", dockerArgs([]), { stdio: "pipe" }),
        (error: any) => error.status === 41 && /db_name_unset/.test(String(error.stderr))
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Database Latency sidecars", () => {
  const inputs = (parameters?: Record<string, string | number | boolean>) => ({
    loadgenImage: imageReference("loadgen", "test"),
    observerImage: imageReference("observer", "test"),
    variantId: "baseline",
    ...(parameters ? { parameters } : {})
  });
  const twoReplicas = { ...scenario, target: { ...scenario.target, pasReplicas: 2 } } as any;
  const images = { db: imageReference("db", "test"), pas: imageReference("pas", "test") };
  const withoutParameterLines = (file: string) =>
    file
      .split("\n")
      .filter(
        (line) =>
          !/PARKBENCH_(EFFECTIVE_CONFIGURATION|DATABASE_PARAMETERS|PAS_PARAMETERS|PARAMETER_ADAPTER_VERSION):/.test(
            line
          )
      )
      .join("\n");

  it("adds nothing when the latency is 0 or absent", () => {
    const absent = generateRunCompose("run-lat", "exp-lat", twoReplicas, images, inputs());
    const zero = generateRunCompose(
      "run-lat",
      "exp-lat",
      twoReplicas,
      images,
      inputs({ "network.databaseLatencyMs": 0 })
    );
    assert.equal(withoutParameterLines(zero.file), withoutParameterLines(absent.file));
    assert.doesNotMatch(zero.file, /latency-|cap_add|NET_ADMIN|network_mode/);
    assert.deepEqual(
      zero.resources.map((resource) => resource.name),
      absent.resources.map((resource) => resource.name)
    );
  });

  it("adds one NET_ADMIN sidecar per PAS replica and one for the database", () => {
    const bundle = generateRunCompose(
      "run-lat",
      "exp-lat",
      twoReplicas,
      images,
      inputs({ "network.databaseLatencyMs": 20 })
    );
    for (const target of ["database", "pas-1", "pas-2"]) {
      const block = new RegExp(
        [
          `  latency-${target}:`,
          `    image: observer:test`,
          "    labels:",
          '      parkbench.managed: "true"',
          '      parkbench.run_id: "run-lat"',
          '      parkbench.experiment_id: "exp-lat"',
          `      parkbench.component: "latency-${target}"`,
          `    network_mode: "service:${target}"`,
          "    cap_add:",
          "      - NET_ADMIN",
          '    user: "0:0"',
          "    depends_on:",
          `      - ${target}`,
          '    command: \\["sleep", "infinity"\\]'
        ].join("\\n")
      );
      assert.match(bundle.file, block, target);
      assert.ok(bundle.resources.some((resource) => resource.name === `latency-${target}`));
    }
    assert.equal((bundle.file.match(/cap_add:/g) ?? []).length, 3);
    assert.equal((bundle.file.match(/NET_ADMIN/g) ?? []).length, 3);
  });
});

it("raw defaults execute the fixed v2 preparation procedure", () => {
  const runner = fs.readFileSync(
    path.join(process.cwd(), "packages/compose-runner/src/run-compose.ts"),
    "utf8"
  );
  assert.match(runner, /: "\/app\/openedge\/observers\/db\/prepare-run-db-observer\.p"/);
  assert.match(
    runner,
    /procedure === "\/app\/openedge\/observers\/db\/parkbench-db-observer-v2\.r"/
  );
});
