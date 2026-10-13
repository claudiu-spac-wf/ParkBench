import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES,
  OPENEDGE_WORKLOAD_TIMEOUT_MS,
  validateBenchmarkImageManifest,
  parseWorkRequestBody
} from "../../packages/contracts/src";
import { parameterPlan } from "../../packages/compose-runner/src/parameters";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
import { validateScenario } from "../../packages/contracts/src/validator";
import { syntheticImageManifest, zipEntry } from "../helpers/openedge";
import { createTemporaryPathFixture } from "../helpers/environment-fixture";

describe("OpenEdge image-build contract", () => {
  it("stages every generic DB and observer COPY source in its generated context", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-observer-context-"));
    const stageRoot = path.join(temporaryRoot, "stage");
    const outputRoot = path.join(temporaryRoot, "output");
    const stagedLicense = path.join(temporaryRoot, "license.cfg");
    const archive = path.join(temporaryRoot, "runner.zip");
    fs.mkdirSync(stageRoot, { recursive: true });
    for (const file of [stagedLicense, archive]) fs.writeFileSync(file, "fixture");
    const builderUrl = pathToFileURL(
      path.join(process.cwd(), "scripts/openedge/build-images.mjs")
    ).href;
    const script = `
      import { createContexts } from ${JSON.stringify(builderUrl)};
      const contexts = createContexts(
        { outputRoot: ${JSON.stringify(outputRoot)} },
        { stageRoot: ${JSON.stringify(stageRoot)}, stagedLicense: ${JSON.stringify(stagedLicense)} },
        ${JSON.stringify(archive)}
      );
      console.log(JSON.stringify(contexts));
    `;
    const contexts = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    );
    fs.writeFileSync(
      path.join(contexts.observer, "parkbench-db-observer-v2.r"),
      "compiled fixture"
    );
    const dockerfile = fs.readFileSync(path.join(contexts.observer, "Dockerfile"), "utf8");
    const copySources = [...dockerfile.matchAll(/^COPY\s+(?!--from=)(\S+)/gm)].map(
      (match) => match[1]
    );
    for (const source of copySources) {
      assert.equal(fs.existsSync(path.join(contexts.observer, source)), true, source);
    }
    assert.equal(fs.existsSync(path.join(contexts.observer, "scripts/lib/load-env.cjs")), true);
    assert.match(dockerfile, /RUN npm ci --omit=dev/);
    assert.equal(fs.existsSync(path.join(contexts.observer, "package-lock.json")), true);
    const dbDockerfile = fs.readFileSync(path.join(contexts.db, "Dockerfile"), "utf8");
    const dbCopySources = [...dbDockerfile.matchAll(/^COPY\s+(?!--from=)(\S+)/gm)].map(
      (match) => match[1]
    );
    for (const source of dbCopySources) {
      assert.equal(fs.existsSync(path.join(contexts.db, source)), true, source);
    }
    assert.ok(dbDockerfile.includes("microdnf install -y tar gzip"));
    // Feature 014: the DB image carries no seed; runs mount one and copy it (copy-seed.sh).
    assert.doesNotMatch(dbDockerfile, /seed\/|\.tar\.gz|sports/i);
    assert.equal(fs.existsSync(path.join(contexts.db, "seed")), false);
    assert.match(dbDockerfile, /COPY copy-seed\.sh \/usr\/local\/bin\/parkbench-db-copy-seed\.sh/);
    assert.doesNotMatch(dbDockerfile, /load_df/);
    const pasDockerfile = fs.readFileSync(path.join(contexts.pasoe, "Dockerfile"), "utf8");
    assert.match(pasDockerfile, /FROM \$\{DB_BASE_IMAGE\} AS db-source/);
    assert.doesNotMatch(pasDockerfile, /sports/i);
    assert.match(pasDockerfile, /COPY apply-db-connection\.sh/);
    const builder = fs.readFileSync(
      path.join(process.cwd(), "scripts/openedge/build-images.mjs"),
      "utf8"
    );
    assert.equal((builder.match(/DB_BASE_IMAGE: options\.dbImage/g) ?? []).length, 3);
    const copyScript = fs.readFileSync(path.join(contexts.db, "copy-seed.sh"), "utf8");
    assert.ok(copyScript.includes('cp -R "$seed_dir/." "$database_workdir/"'));
    assert.ok(copyScript.includes("prostrct repair"));
    assert.match(
      dockerfile,
      /COPY parkbench-db-observer-v2\.r \/app\/openedge\/observers\/db\/parkbench-db-observer-v2\.r/
    );
  });

  it("writes and parses generated path values without evaluating shell metacharacters", async () => {
    const fixture = createTemporaryPathFixture("parkbench-generated env ");
    try {
      const outputRoot = fixture.resolve("generated assets;$(touch marker)");
      const marker = fixture.resolve("marker");
      const manifest = syntheticImageManifest("generic");
      manifest.runnerArchive.path = `app archives/runner;$(touch ${marker}).zip`;
      const builderUrl = pathToFileURL(
        path.join(process.cwd(), "scripts/openedge/build-images.mjs")
      ).href;
      const script = `
        const { writeStageOutputs } = await import(${JSON.stringify(builderUrl)});
        console.log(JSON.stringify(writeStageOutputs(${JSON.stringify(outputRoot)}, "generic", ${JSON.stringify(manifest)})));
      `;
      const outputs = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: process.cwd(),
          encoding: "utf8"
        })
      );
      const { parseEnvFile } = createRequire(path.join(process.cwd(), "package.json"))(
        path.join(process.cwd(), "scripts/lib/load-env.cjs")
      ) as { parseEnvFile(file: string): { values: Record<string, string> } };
      const parsed = parseEnvFile(outputs.envPath);
      assert.equal(parsed.values.PARKBENCH_OPENEDGE_SEED_PATH, undefined);
      assert.equal(
        parsed.values.PARKBENCH_OPENEDGE_APP_ARCHIVE,
        path.resolve(outputRoot, manifest.runnerArchive.path)
      );
      assert.equal(parsed.values.PARKBENCH_OPENEDGE_OBSERVER_IMAGE, manifest.observer.reference);

      const loaded = spawnSync(
        "bash",
        [
          "-c",
          'eval "$(node "$1" -- --root "$2" --env-file "$3" --shell)"; printf "%s" "$PARKBENCH_OPENEDGE_APP_ARCHIVE"',
          "bash",
          path.join(process.cwd(), "scripts/lib/load-env.cjs"),
          process.cwd(),
          outputs.envPath
        ],
        {
          env: {
            ...process.env,
            PARKBENCH_OPENEDGE_APP_ARCHIVE: undefined
          },
          encoding: "utf8"
        }
      );
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.equal(loaded.stdout, parsed.values.PARKBENCH_OPENEDGE_APP_ARCHIVE);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("packages the generic handler source without compiling before the DB image exists", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-generic-archive-"));
    const workloadRoot = path.join(temporaryRoot, "workloads");
    const outputRoot = path.join(temporaryRoot, "output");
    const compiler = path.join(temporaryRoot, "compiler.sh");
    fs.mkdirSync(workloadRoot, { recursive: true });
    fs.writeFileSync(compiler, "#!/bin/sh\nexit 91\n");
    fs.chmodSync(compiler, 0o755);
    const packageRunner = pathToFileURL(
      path.join(process.cwd(), "scripts/openedge/package-runner.mjs")
    ).href;
    const handlerPath = path.join(process.cwd(), "openedge/runner/ParkBenchWorkHandler.cls");
    const servicePath = path.join(process.cwd(), "openedge/runner/service.json");
    const runtimePath = path.join(process.cwd(), "openedge/runner/runtime.properties");
    const script = `
      const { prepareRunnerArchive } = await import(${JSON.stringify(packageRunner)});
      const result = prepareRunnerArchive({
        workloadRoot: ${JSON.stringify(workloadRoot)},
        outputRoot: ${JSON.stringify(outputRoot)},
        stage: "generic",
        handlerPath: ${JSON.stringify(handlerPath)},
        servicePath: ${JSON.stringify(servicePath)},
        runtimePath: ${JSON.stringify(runtimePath)},
        allowEmpty: true,
        compileHandler: false
      });
      if (result.handlerCompiled) process.exit(92);
      console.log(result.archive);
    `;
    const archive = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PARKBENCH_OPENEDGE_COMPILER: compiler }
    }).trim();
    assert.equal(fs.existsSync(archive), true);
    assert.equal(fs.statSync(compiler).size > 0, true);
    const appArchive = path.join(temporaryRoot, "parkbench-app.zip");
    fs.writeFileSync(appArchive, zipEntry(archive, "ablapps/parkbench.zip")!);
    const runtimeProperties = zipEntry(appArchive, "tlr/openedge.properties.merge")!.toString(
      "utf8"
    );
    assert.doesNotMatch(runtimeProperties, /sports/i);
    assert.match(
      runtimeProperties,
      /agentStartupParam=-pf \$\{catalina\.base\}\/ablapps\/parkbench\/conf\/startup\.pf/
    );
    const startup = zipEntry(appArchive, "conf/startup.pf")!.toString("utf8");
    assert.equal(startup.trim(), "-db parkbench -H database -S 20931");
  });

  it("accepts a complete generic manifest but preserves the ParkBench gate", () => {
    const manifest = validateBenchmarkImageManifest(syntheticImageManifest("generic"));
    assert.equal(manifest.imageStage, "generic");
    assert.equal(manifest.parkBenchReady, false);
    assert.throws(() => validateBenchmarkImageManifest(manifest, true), /final_openedge_manifest/);
  });

  it("accepts a complete final manifest with tagged image references", () => {
    const manifest = validateBenchmarkImageManifest(syntheticImageManifest("final"), true);
    assert.equal(manifest.imageStage, "final");
    assert.equal(manifest.parkBenchReady, true);
    for (const image of [manifest.db, manifest.pasoe, manifest.observer, manifest.jdk])
      assert.match(image.reference, /:test$/);
  });

  it("accepts tag-only generated image references while retaining digest compatibility", () => {
    const manifest = syntheticImageManifest("final");
    for (const image of [manifest.db, manifest.pasoe, manifest.observer, manifest.jdk]) {
      image.reference = `${image.repository}:fixture`;
      delete image.digest;
    }
    const parsed = validateBenchmarkImageManifest(manifest, true);
    assert.ok(parsed.db.reference.endsWith(":fixture"));
  });

  it("rejects final manifests whose observer protocol or catalog identity is stale", () => {
    const manifest = syntheticImageManifest("final");
    manifest.observerContract.protocolVersion = 1;
    assert.throws(
      () => validateBenchmarkImageManifest(manifest, true),
      /openedge_manifest_observer_contract_invalid/
    );
  });

  it("deploys v4 named capture while retaining historical v3 metadata", () => {
    const current = syntheticImageManifest("final");
    assert.equal(validateBenchmarkImageManifest(current, true).observerContract.protocolVersion, 4);
    const historical = structuredClone(current);
    historical.observerContract.protocolVersion = 3;
    assert.equal(validateBenchmarkImageManifest(historical).observerContract.protocolVersion, 3);
    assert.throws(() => validateBenchmarkImageManifest(historical, true), /rebuild_required/);
  });

  it("preserves historical v2 capability metadata but rejects it before a new run", () => {
    const old = syntheticImageManifest("final");
    old.observerContract.protocolVersion = 2;
    delete old.observerContract.tableCoverage;
    assert.equal(validateBenchmarkImageManifest(old).observerContract.protocolVersion, 2);
    assert.throws(() => validateBenchmarkImageManifest(old, true), /all_table_rebuild_required/);
    const current = syntheticImageManifest("final");
    assert.equal(
      validateBenchmarkImageManifest(current, true).observerContract.tableCoverage,
      "all_tables"
    );
    delete current.observerContract.tableCoverage;
    assert.throws(() => validateBenchmarkImageManifest(current, true), /observer_contract_invalid/);
  });

  it("uses the fixed ParkBench endpoint and one-minute timeout", () => {
    const parsed = validateScenario(scenario);
    assert.equal(parsed.target.pasProtocol, "http");
    assert.equal(parsed.target.pasPort, 8810);
    assert.equal(parsed.target.timeoutMs, OPENEDGE_WORKLOAD_TIMEOUT_MS);
    assert.equal(parsed.workload.operations[0].path, "/work");
    assert.deepEqual(parsed.workload.operations[0].bodyTemplate, {
      procName: "Workloads/ParkBench/bank_mix.p",
      input: { mode: "run", op: "reference-point", key: "generated" }
    });
  });

  it("rejects a pre-feature-014 v1 manifest with a rebuild hint", () => {
    const manifest = syntheticImageManifest("final");
    manifest.schemaVersion = "image-build.v1";
    assert.throws(
      () => validateBenchmarkImageManifest(manifest, true),
      /openedge_manifest_rebuild_required/
    );
    const missingSchema = syntheticImageManifest("final");
    delete missingSchema.compileSchema;
    assert.throws(
      () => validateBenchmarkImageManifest(missingSchema, true),
      /openedge_manifest_compile_schema_invalid/
    );
  });

  it("compiles through a ready empty DB container loaded from definitions", () => {
    const driver = fs.readFileSync(
      path.join(process.cwd(), "scripts/openedge/compile-source.p"),
      "utf8"
    );
    const adapter = fs.readFileSync(
      path.join(process.cwd(), "scripts/openedge/compile-with-db.mjs"),
      "utf8"
    );
    assert.match(driver, /COMPILE VALUE\(sourcePath\) SAVE NO-ERROR\./);
    assert.match(adapter, /\/psc\/dlc\/bin\/pro/);
    assert.match(adapter, /test -f \/psc\/wrk\/\$\{databaseName\}\/\$\{databaseName\}\.db/);
    assert.match(adapter, /compiler_db_ready_timeout/);
    assert.match(adapter, /--pull/);
    assert.match(adapter, /PARKBENCH_DB_INIT_MODE=empty/);
    assert.match(adapter, /PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE/);
    assert.doesNotMatch(adapter, /\/run\/parkbench\/seed/);
    assert.match(adapter, /PARKBENCH_DB_INIT_MODE=empty/);
    // The empty compiler DB lives in an anonymous volume; removal must drop it too.
    assert.match(adapter, /"rm", "-f", "-v"/);
    assert.doesNotMatch(adapter, /sports/i);
  });

  it("can execute the native observer launcher on Linux without a carriage-return interpreter", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "observer-launcher-"));
    const executable = path.join(temporary, "parkbench-openedge-db-observer");
    try {
      fs.copyFileSync("docker/openedge-observer/parkbench-openedge-db-observer", executable);
      fs.chmodSync(executable, 0o755);
      const result = spawnSync(executable, [], {
        encoding: "utf8",
        env: { ...process.env, PARKBENCH_OBSERVER_READ_ONLY: "false" }
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 42, result.stderr);
      assert.match(result.stderr, /observer_read_only_required/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("advertises the compiled v3 collector in the final observer image stage", () => {
    const dockerfile = fs.readFileSync("docker/openedge-observer/Dockerfile", "utf8");
    const runtimeStage = dockerfile.split(/\r?\nFROM /).at(-1)!;
    assert.match(runtimeStage, /ARG OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION=3/);
    const builder = fs.readFileSync("scripts/openedge/build-images.mjs", "utf8");
    assert.match(builder, /OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION: "3"/);
  });

  it("compiles the canonical database observer after creating the generic DB image", () => {
    const builder = fs.readFileSync(
      path.join(process.cwd(), "scripts/openedge/build-images.mjs"),
      "utf8"
    );
    const launcher = fs.readFileSync(
      path.join(process.cwd(), "docker/openedge-observer/parkbench-openedge-db-observer"),
      "utf8"
    );
    assert.match(
      builder,
      /compileObserverProcedure\(contexts\.observer, dbImage\.reference, options\.databaseName\)/
    );
    // The generic stage needs no seed; only the final stage resolves a compile seed.
    assert.doesNotMatch(builder, /writeSeedArchive|seedArchive/);
    assert.match(builder, /scripts\/openedge\/compile-with-db\.mjs/);
    assert.match(builder, /openedge\/observers\/db\/parkbench-db-observer-v2\.p/);
    assert.match(launcher, /parkbench-db-observer-v2\.r/);
    assert.doesNotMatch(builder, /docker\/openedge-observer\/parkbench-db-observer\.p/);
  });

  it("reports a safe compiler adapter version without Docker or build side effects", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-compiler-version-"));
    const marker = path.join(temporaryRoot, "docker-was-called");
    const docker = path.join(temporaryRoot, "docker");
    fs.writeFileSync(docker, `#!/bin/sh\ntouch '${marker}'\nexit 99\n`);
    fs.chmodSync(docker, 0o755);
    const output = execFileSync(
      process.execPath,
      [path.join(process.cwd(), "scripts/openedge/compile-with-db.mjs"), "--version"],
      {
        encoding: "utf8",
        env: { ...process.env, PARKBENCH_OPENEDGE_DOCKER_COMMAND: docker }
      }
    ).trim();
    assert.match(output, /^parkbench-openedge-compiler-adapter\/\d+\.\d+\.\d+$/);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), ["docker"]);
  });

  it("keeps database observer and deterministic load-seed controls allowlisted", () => {
    const plan = parameterPlan({ "-B": 10000, "pas.maxThreads": 4 });
    assert.deepEqual(plan.databaseStartupArgs, ["-B", "10000"]);
    assert.equal(plan.pasEnvironment.PARKBENCH_PAS_MAX_THREADS, "4");
    const paired = parameterPlan({ "database.metricsEnabled": false, "workload.seed": 2020 });
    assert.equal(paired.databaseMetricsEnabled, false);
    assert.equal(paired.workloadSeed, 2020);
    assert.throws(() => parameterPlan({ "database.readOnly": true }), /network_broker/);
    assert.throws(() => parameterPlan({ "workload.seed": -1 }), /invalid_parameter:workload\.seed/);
  });

  it("does not place licensed/generated inputs in tracked fixture files", () => {
    const gitignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
    assert.match(gitignore, /progress\.cfg/);
    assert.match(gitignore, /\.parkbench\/openedge/);
    assert.ok(OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES >= 1024 * 1024);
  });

  it("parses only the fixed request envelope", () => {
    assert.deepEqual(parseWorkRequestBody('{"procName":"Workloads/Read/test.p","input":null}'), {
      procName: "Workloads/Read/test.p",
      input: null
    });
    assert.throws(
      () => parseWorkRequestBody('{"procName":"Workloads/Read/test.p","input":1,"extra":true}'),
      /invalid_work_request/
    );
  });
});

it("uses the static v2 collector and fixed raw bootstrap with fresh compilation", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  assert.match(read("scripts/openedge/build-images.mjs"), /parkbench-db-observer-v2\.p/);
  assert.match(read("scripts/openedge/compile-source.p"), /PB_HAS_/);
  assert.match(read("scripts/openedge/compile-with-db.mjs"), /compiledPaths.*fs\.rmSync\(file/);
  const bootstrap = read("openedge/observers/db/prepare-run-db-observer.p");
  assert.match(bootstrap, /SESSION:TEMP-DIRECTORY/);
  assert.match(bootstrap, /parkbench-db-observer-v2\.p/);
  assert.doesNotMatch(bootstrap, /sourcePath = SESSION:PARAMETER|CREATE QUERY|QUERY-PREPARE/);
  assert.match(
    read("docker/observer/Dockerfile"),
    /ENV PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE=.*prepare-run-db-observer\.p/
  );
  assert.ok(
    fs.existsSync(path.join(process.cwd(), "openedge/observers/db/parkbench-db-observer.p"))
  );
});

it("builds the matching distribution before packaging native observer code and schemas", () => {
  const build = fs.readFileSync("scripts/openedge/build-images.mjs", "utf8");
  assert.ok(
    build.indexOf('execFileSync("npm", ["run", "build"]') <
      build.indexOf("generic = await buildGeneric")
  );
  assert.match(build, /protocolVersion: 4/);
});
