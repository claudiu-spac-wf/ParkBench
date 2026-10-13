#!/usr/bin/env node
/* Licensed, disposable native validation. No mock or skip can satisfy a suite. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fixtureData } from "../../tests/fixtures/table-write-workloads/fixture-data.mjs";
import { createRunnerArchive } from "./create-runner-archive.mjs";
import {
  repositoryRoot,
  readInventory,
  writeRoot,
  validateInventory
} from "./generate-write-workloads.mjs";
const require = createRequire(import.meta.url);
const { databaseMemoryArguments } = require("../lib/db-memory.cjs");
const { loadEnvironment } = require("../lib/load-env.cjs");
const nativePropath =
  "/validation,/validation/Workloads/Write,/feature/tests/fixtures/table-write-workloads/abl,/psc/dlc/tty,/psc/dlc/tty/OpenEdge.Core.apl,/psc/dlc/tty/netlib/OpenEdge.Net.apl";
export const sha256 = (file) => {
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try { let bytes; while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
};

export function sourceFingerprints(root = writeRoot) {
  return Object.fromEntries(
    fs
      .readdirSync(root)
      .filter((n) => /\.(p|i|json)$/.test(n))
      .sort()
      .map((n) => [n, sha256(path.join(root, n))])
  );
}

export class NativeFixture {
  constructor(options = {}) {
    this.options = options;
    this.name = "parkbench-write-018-" + crypto.randomUUID().slice(0, 8);
    this.root = fs.mkdtempSync(path.join(repositoryRoot, ".parkbench/validation/write-018-"));
    fs.chmodSync(this.root, 0o777);
    this.started = false;
    this.port = "20931";
    this.database = "/psc/wrk/parkbench";
    this.image = options.image ?? process.env.PARKBENCH_OPENEDGE_DB_IMAGE;
    this.seed =
      options.seed ??
      path.join(
        process.env.PARKBENCH_DISCOVERY_SEEDS_ROOT ?? "",
        process.env.PARKBENCH_OPENEDGE_DEFAULT_SEED ?? ""
      );
    this.dockerCommand = process.env.PARKBENCH_OPENEDGE_DOCKER_COMMAND ?? "docker";
  }
  docker(args) {
    try {
      return execFileSync(this.dockerCommand, args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      });
    } catch (error) {
      throw new Error(
        "write_native_command_failed:" +
          String(error.stderr || error.stdout || error.message).slice(-3000)
      );
    }
  }
  async start() {
    if (!this.image || !fs.existsSync(path.join(this.seed, "parkbench.db")))
      throw new Error("write_native_prerequisites_missing:image_or_seed");
    this.seedHashes = Object.fromEntries(
      fs
        .readdirSync(this.seed)
        .filter((n) => /\.(db|st|b\d+|d\d+)$/.test(n))
        .map((n) => [n, sha256(path.join(this.seed, n))])
    );
    this.imageId = JSON.parse(this.docker(["image", "inspect", this.image]))[0].Id;
    this.docker([
      "run",
      "-d",
      "--pull=never",
      ...databaseMemoryArguments(process.env, this.options.memoryLimitBytes),
      "--name",
      this.name,
      "-v",
      repositoryRoot + ":/feature:ro",
      "-v",
      this.root + ":/validation:rw",
      "-v",
      this.seed + ":/run/parkbench/seed/db:ro",
      "-e",
      "DB_NAME=parkbench",
      "-e",
      "PARKBENCH_DB_INIT_MODE=seed",
      ...(this.options.databaseStartupWords ? ["-e", "PARKBENCH_OPENEDGE_DB_STARTUP_WORDS=" + this.options.databaseStartupWords] : []),
      this.imageId
    ]);
    this.started = true;
    const deadline = Date.now() + 120000;
    while (true) {
      try {
        this.docker(["exec", "--user", "pscadmin", this.name, "pgrep", "-x", "_mprosrv"]);
        break;
      } catch {
        if (
          Date.now() >= deadline ||
          this.docker(["inspect", "--format", "{{.State.Status}}", this.name]).trim() === "exited"
        )
          throw new Error("write_native_database_start_failed");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    fs.cpSync(writeRoot, path.join(this.root, "Workloads/Write"), {
      recursive: true,
      filter: (file) => !file.endsWith(".r")
    });
    return this;
  }
  invoke(driver, config, expectedFile) {
    if (expectedFile) fs.rmSync(path.join(this.root, expectedFile), { force: true });
    const output = this.docker([
      "exec",
      "--user",
      "pscadmin",
      "-e",
      "PROPATH=" + nativePropath,
      "-e",
      "PARKBENCH_WRITE_FIXTURE=1",
      "-e",
      "PARKBENCH_WRITE_WITNESS=/validation/assignments.csv",
      this.name,
      "/psc/dlc/bin/pro",
      "-T",
      "/psc/wrk",
      "-db",
      this.database,
      "-H",
      "127.0.0.1",
      "-S",
      this.port,
      "-b",
      "-catchStop",
      "1",
      "-p",
      driver,
      "-param",
      JSON.stringify(config)
    ]);
    if (expectedFile) {
      const file = path.join(this.root, expectedFile);
      if (!fs.existsSync(file))
        throw new Error(
          "write_native_evidence_missing:" + expectedFile + ":" + output.slice(-3000)
        );
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    return output;
  }
  compile(tables = readInventory().tables.map((t) => t.name)) {
    const fragments = tables.map(
      (table) =>
        'sourceName = "/validation/Workloads/Write/' +
        table +
        '.p".\n' +
        "COMPILE VALUE(sourceName) SAVE NO-ERROR.\nIF COMPILER:ERROR THEN DO:\n" +
        "  DO i = 1 TO ERROR-STATUS:NUM-MESSAGES: MESSAGE ERROR-STATUS:GET-MESSAGE(i). END.\n" +
        '  UNDO, THROW NEW Progress.Lang.AppError("write_native_compile_failed:' +
        table +
        '", 0).\nEND.\nfiles:Add(sourceName).'
    );
    const driver =
      "BLOCK-LEVEL ON ERROR UNDO, THROW.\nUSING Progress.Json.ObjectModel.JsonObject.\nUSING Progress.Json.ObjectModel.JsonArray.\n" +
      "DEFINE VARIABLE result AS JsonObject NO-UNDO.\nDEFINE VARIABLE files AS JsonArray NO-UNDO.\nDEFINE VARIABLE i AS INTEGER NO-UNDO.\nDEFINE VARIABLE sourceName AS CHARACTER NO-UNDO.\n" +
      "result = NEW JsonObject().\nfiles = NEW JsonArray().\n" +
      fragments.join("\n") +
      '\nresult:Add("ok", TRUE).\nresult:Add("files", files).\nresult:WriteFile("/validation/compile.json", TRUE).\nQUIT.\n';
    fs.writeFileSync(path.join(this.root, "compile.p"), driver);
    const result = this.invoke("/validation/compile.p", {}, "compile.json");
    if (
      result.ok !== true ||
      tables.some((t) => !fs.existsSync(path.join(this.root, "Workloads/Write/" + t + ".r")))
    )
      throw new Error("write_native_compile_incomplete");
    return result;
  }
  compileDrivers(names = ["prepare", "verify"]) {
    fs.mkdirSync(path.join(this.root, "drivers"), { recursive: true });
    const paths = names.map((name) => {
      if (!/^[a-z][a-z-]*$/.test(name)) throw new Error("write_driver_name_invalid");
      const source = path.join(
        repositoryRoot,
        "tests/fixtures/table-write-workloads/abl",
        name + ".p"
      );
      if (!fs.existsSync(source)) throw new Error("write_native_driver_missing:" + name);
      fs.copyFileSync(source, path.join(this.root, "drivers", name + ".p"));
      return "/validation/drivers/" + name + ".p";
    });
    return this.compileSources(paths);
  }
  compileSources(paths) {
    const report = "compile-" + crypto.randomUUID() + ".json";
    const statements = paths
      .map(
        (source) =>
          "COMPILE " +
          JSON.stringify(source) +
          ' SAVE NO-ERROR.\nIF COMPILER:ERROR THEN DO:\n  DO i = 1 TO ERROR-STATUS:NUM-MESSAGES: MESSAGE ERROR-STATUS:GET-MESSAGE(i). END.\n  UNDO, THROW NEW Progress.Lang.AppError("write_native_compile_failed:' +
          source +
          '", 0).\nEND.'
      )
      .join("\n");
    fs.writeFileSync(
      path.join(this.root, "compile-sources.p"),
      "BLOCK-LEVEL ON ERROR UNDO, THROW.\nUSING Progress.Json.ObjectModel.JsonObject.\nDEFINE VARIABLE result AS JsonObject NO-UNDO.\nDEFINE VARIABLE i AS INTEGER NO-UNDO.\n" +
        statements +
        '\nresult = NEW JsonObject().\nresult:Add("ok", TRUE).\nresult:WriteFile("/validation/' +
        report +
        '", TRUE).\nQUIT.\n'
    );
    const result = this.invoke("/validation/compile-sources.p", {}, report);
    if (
      result.ok !== true ||
      paths.some(
        (source) =>
          !fs.existsSync(
            path.join(this.root, source.slice("/validation/".length).replace(/\.(p|cls)$/, ".r"))
          )
      )
    )
      throw new Error("write_native_compile_incomplete");
    return { ...result, sources: paths };
  }
  prepareEmpty({ variant = "success", count = 200, schemaTransform } = {}) {
    this.stopPas();
    if (this.database === "/psc/wrk/write-fixture/parkbench") {
      this.docker([
        "exec",
        "--user",
        "pscadmin",
        this.name,
        "/psc/dlc/bin/proshut",
        this.database,
        "-by"
      ]);
      this.docker(["exec", "--user", "pscadmin", this.name, "rm", "-rf", "/psc/wrk/write-fixture"]);
      this.database = "/psc/wrk/parkbench";
      this.port = "20931";
    }
    this.invoke("/feature/tests/fixtures/table-write-workloads/abl/prepare.p", {
      command: "dump-schema",
      output: "/validation/schema.df"
    });
    const schema = path.join(this.root, "schema.df");
    if (!fs.existsSync(schema)) throw new Error("write_fixture_schema_dump_missing");
    // Fixtures use the exported schema in the empty database's available area.
    // Field/mandatory/index/sequence definitions are preserved unchanged.
    const definition = fs
        .readFileSync(schema, "utf8")
        .split(/\r?\n/)
        .filter((l) => !/^\s*(?:AREA|LOB-AREA)\s/.test(l))
        .join("\n");
    // Test-only invalid-data fixtures can alter the disposable schema. Normal
    // workload/byte-accounting fixtures preserve the seed's field definitions.
    fs.writeFileSync(schema, schemaTransform ? schemaTransform(definition) : definition);
    this.docker(["exec", "--user", "pscadmin", this.name, "mkdir", "-p", "/psc/wrk/write-fixture"]);
    this.docker([
      "exec",
      "--user",
      "pscadmin",
      this.name,
      "/psc/dlc/bin/procopy",
      "/psc/dlc/prolang/utf/empty8",
      "/psc/wrk/write-fixture/parkbench"
    ]);
    fs.writeFileSync(
      path.join(this.root, "load-schema.p"),
      'BLOCK-LEVEL ON ERROR UNDO, THROW.\nRUN prodict/load_df.p ("/validation/schema.df").\nQUIT.\n'
    );
    this.docker([
      "exec",
      "--user",
      "pscadmin",
      "-e",
      "PROPATH=" + nativePropath,
      this.name,
      "/psc/dlc/bin/pro",
      "-T",
      "/psc/wrk",
      "-db",
      "/psc/wrk/write-fixture/parkbench",
      "-b",
      "-p",
      "/validation/load-schema.p"
    ]);
    this.docker([
      "exec",
      "--user",
      "pscadmin",
      this.name,
      "/psc/dlc/bin/proserve",
      "/psc/wrk/write-fixture/parkbench",
      "-S",
      "20951",
      "-minport",
      "20952",
      "-maxport",
      "20961",
      "-L",
      "50000"
    ]);
    this.port = "20951";
    this.database = "/psc/wrk/write-fixture/parkbench";
    const data = fixtureData({ variant, count });
    fs.writeFileSync(path.join(this.root, "fixture-data.json"), JSON.stringify(data));
    const result = this.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/prepare.p",
      {
        command: "populate",
        data: "/validation/fixture-data.json",
        report: "/validation/prepare.json"
      },
      "prepare.json"
    );
    if (result.ok !== true || result.tables !== data.tables.length || result.variant !== variant)
      throw new Error("write_fixture_preparation_incomplete");
    return result;
  }
  snapshot(table, where = "TRUE", { requireKnown = false, relationships = true } = {}) {
    const report = "snapshot-" + crypto.randomUUID() + ".json";
    return this.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/verify.p",
      {
        table,
        where,
        requireKnown,
        ...(relationships
          ? { inventory: "/feature/scripts/openedge/table-write-inventory.json" }
          : {}),
        report: "/validation/" + report
      },
      report
    );
  }
  snapshotAll({ requireKnown = true, relationships = false } = {}) {
    const report = "snapshot-all-" + crypto.randomUUID() + ".json";
    return this.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/verify.p",
      {
        tables: readInventory().tables.map((t) => t.name),
        requireKnown,
        ...(relationships
          ? { inventory: "/feature/scripts/openedge/table-write-inventory.json" }
          : {}),
        report: "/validation/" + report
      },
      report
    );
  }
  exportPreparedSeed() {
    const seed = path.join(this.root, "prepared-seeds/banking-write-018");
    fs.mkdirSync(seed, { recursive: true });
    this.docker([
      "exec",
      "--user",
      "pscadmin",
      this.name,
      "/psc/dlc/bin/proshut",
      this.database,
      "-by"
    ]);
    this.docker([
      "exec",
      "--user",
      "pscadmin",
      this.name,
      "/psc/dlc/bin/prostrct",
      "list",
      this.database
    ]);
    this.docker(["cp", this.name + ":/psc/wrk/write-fixture/.", seed]);
    for (const filename of fs.readdirSync(seed)) {
      if (!/^parkbench\.(?:db|st|[bdat]\d+)$/.test(filename)) fs.rmSync(path.join(seed, filename));
    }
    const structure = path.join(seed, "parkbench.st");
    fs.writeFileSync(
      structure,
      // ParkBench seed structure paths name directories; prostrct list emits
      // complete extent filenames. The exported files all live in this root.
      fs
        .readFileSync(structure, "utf8")
        .replace(/\/psc\/wrk\/write-fixture\/parkbench\.[bdat]\d+/g, ".")
    );
    return seed;
  }
  invokeFailure(table, inputText) {
    const report = "failure-" + crypto.randomUUID() + ".json";
    const inputFile = report.replace(".json", ".input");
    fs.writeFileSync(path.join(this.root, inputFile), inputText);
    return this.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/verify-failure.p",
      {
        table,
        inputFile: "/validation/" + inputFile,
        report: "/validation/" + report
      },
      report
    );
  }
  invokeCreate(table, input) {
    const report = "create-" + crypto.randomUUID() + ".json";
    return this.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/verify-create.p",
      { table, input, report: "/validation/" + report },
      report
    );
  }
  invokeUpdate(table, input) {
    const report = "update-" + crypto.randomUUID() + ".json";
    return this.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/verify-update.p",
      { table, input, report: "/validation/" + report },
      report
    );
  }
  resetWitness() {
    if (!this.witnessPath) throw new Error("write_witness_not_enabled");
    fs.writeFileSync(this.witnessPath, "");
  }
  enableWitness(tables = readInventory().tables.map((t) => t.name)) {
    for (const table of tables) {
      const file = path.join(this.root, "Workloads/Write", table + ".p");
      const source = fs.readFileSync(file, "utf8");
      if (!source.startsWith("&GLOBAL-DEFINE PB-WRITE-WITNESS TRUE\n"))
        fs.writeFileSync(file, "&GLOBAL-DEFINE PB-WRITE-WITNESS TRUE\n" + source);
    }
    this.witnessPath = path.join(this.root, "assignments.csv");
    this.docker([
      "exec",
      this.name,
      "sh",
      "-c",
      "touch /validation/assignments.csv && chmod 666 /validation/assignments.csv"
    ]);
    return this.compile(tables);
  }
  async startPas() {
    if (this.pasName) throw new Error("write_pas_already_started");
    const image = this.options.pasImage ?? process.env.PARKBENCH_OPENEDGE_PAS_IMAGE;
    if (!image) throw new Error("write_native_prerequisites_missing:pas_image");
    this.pasImageId = JSON.parse(this.docker(["image", "inspect", image]))[0].Id;
    fs.mkdirSync(path.join(this.root, "runner"), { recursive: true });
    const handlerSource = fs.readFileSync(
      path.join(repositoryRoot, "openedge/runner/ParkBenchWorkHandler.cls"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(this.root, "runner/ParkBenchWorkHandler.cls"),
      this.handlerTransform ? this.handlerTransform(handlerSource) : handlerSource
    );
    this.compileSources(["/validation/runner/ParkBenchWorkHandler.cls"]);
    const archive = createRunnerArchive({
      outputRoot: path.join(this.root, "pas"),
      workloadRoot: path.join(this.root, "Workloads"),
      handlerPath: path.join(this.root, "runner/ParkBenchWorkHandler.cls"),
      pasoeImage: this.pasImageId,
      skipCompilation: true
    });
    if (!this.network) {
      this.network = this.name + "-network";
      this.docker(["network", "create", this.network]);
      this.docker(["network", "connect", this.network, this.name]);
    }
    this.pasName = this.name + "-pas";
    this.docker([
      "run",
      "-d",
      "--pull=never",
      "--name",
      this.pasName,
      "--network",
      this.network,
      "-p",
      "127.0.0.1::8810",
      "-v",
      archive.archive + ":/deploy/artifacts/oepas1.zip:ro",
      "-v",
      this.root + ":/validation:rw",
      "-e",
      "PARKBENCH_PAS_DB_CONNECTION=-db " +
        this.database +
        " -H " +
        this.name +
        " -S " +
        this.port +
        " -ld parkbench",
      "-e",
      "PARKBENCH_WRITE_WITNESS=/validation/assignments.csv",
      "-e",
      "PARKBENCH_WRITE_FIXTURE=1",
      this.pasImageId
    ]);
    const state = JSON.parse(this.docker(["inspect", this.pasName]))[0];
    this.baseUrl =
      "http://127.0.0.1:" + state.NetworkSettings.Ports["8810/tcp"][0].HostPort + "/parkbench/web";
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(this.baseUrl + "/health", {
          signal: AbortSignal.timeout(3000)
        });
        if (response.ok) return { imageId: this.pasImageId, archiveHash: sha256(archive.archive) };
      } catch {}
      if (
        this.docker(["inspect", "--format", "{{.State.Status}}", this.pasName]).trim() === "exited"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      "write_native_pas_start_failed:" + this.docker(["logs", "--tail", "40", this.pasName])
    );
  }
  async request(table, input, { timeoutMs = 65000 } = {}) {
    if (!this.baseUrl) throw new Error("write_native_pas_not_started");
    const descriptor = readInventory().tables.find((t) => t.name === table);
    if (!descriptor) throw new Error("write_test_table_invalid");
    return this.requestProcedure(descriptor.procedure, input, { timeoutMs });
  }
  async requestProcedure(procedure, input, { timeoutMs = 65000 } = {}) {
    if (!this.baseUrl) throw new Error("write_native_pas_not_started");
    const response = await fetch(this.baseUrl + "/work", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procName: procedure, input }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { status: response.status, body: await response.json() };
  }
  stopPas() {
    if (this.pasName) {
      this.docker(["rm", "-f", "-v", this.pasName]);
      this.pasName = undefined;
      this.baseUrl = undefined;
    }
  }
  close() {
    if (this.pasName) {
      this.docker(["rm", "-f", "-v", this.pasName]);
      this.pasName = undefined;
    }
    if (this.started) {
      this.docker(["rm", "-f", "-v", this.name]);
      this.started = false;
    }
    if (this.network) {
      this.docker(["network", "rm", this.network]);
      this.network = undefined;
    }
    if (this.seedHashes)
      for (const [name, digest] of Object.entries(this.seedHashes)) {
        if (sha256(path.join(this.seed, name)) !== digest)
          throw new Error("write_source_seed_changed:" + name);
      }
  }
}

export async function runSuite(options) {
  fs.mkdirSync(path.join(repositoryRoot, ".parkbench/validation"), { recursive: true });
  const suite = options.suite ?? "records";
  const reportPath = path.resolve(
    repositoryRoot,
    options.report ?? ".parkbench/validation/table-write-" + suite + ".json"
  );
  const report = {
    suite,
    ok: false,
    purpose: suite === "fixtures" ? "foundation-fixtures-only" : "workload-acceptance",
    startedAt: new Date().toISOString(),
    sourceHashes: sourceFingerprints(),
    cases: []
  };
  let fixture;
  try {
    loadEnvironment({ root: repositoryRoot, envFile: options.config, required: true });
    if (
      ![
        "fixtures",
        "build",
        "records",
        "creates",
        "updates",
        "failures",
        "runner",
        "scenario"
      ].includes(suite)
    )
      throw new Error("write_test_suite_invalid");
    validateInventory(readInventory(), { scaffold: suite === "fixtures" });
    if (suite !== "fixtures")
      for (const name of fs.readdirSync(writeRoot).filter((n) => n.endsWith(".p"))) {
        if (fs.readFileSync(path.join(writeRoot, name), "utf8").includes("PB-SCAFFOLD TRUE"))
          throw new Error("write_native_provisional_scaffold_rejected");
      }
    fixture = new NativeFixture(options);
    await fixture.start();
    report.evidenceRoot = path.relative(repositoryRoot, fixture.root);
    report.imageId = fixture.imageId;
    report.seedHashes = fixture.seedHashes;
    const names =
      options.tables && options.tables !== "all"
        ? options.tables.split(",")
        : readInventory().tables.map((t) => t.name);
    if (names.some((n) => !readInventory().tables.some((t) => t.name === n)))
      throw new Error("write_test_table_invalid");
    report.compilation = suite === "fixtures" ? fixture.compileDrivers() : fixture.compile(names);
    {
      // Suite modules own actual assertions; their absence is a failure.
      const modulePath = path.join(
        repositoryRoot,
        "tests/fixtures/table-write-workloads/" + suite + "-suite.mjs"
      );
      if (!fs.existsSync(modulePath)) throw new Error("write_native_suite_driver_missing:" + suite);
      const module = await import(modulePath);
      report.cases = await module.run({ fixture, options, inventory: readInventory(), report });
      if (!report.cases.length || report.cases.some((c) => c.ok !== true || c.skipped))
        throw new Error("write_native_required_case_failed_or_skipped");
    }
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try {
      fixture?.close();
    } catch (error) {
      report.ok = false;
      report.cleanupError = error.message;
      throw error;
    } finally {
      report.completedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!/^--(?:config|suite|tables|report|case|scenario)$/.test(key) || !process.argv[i + 1])
        throw new Error("write_test_arguments_invalid");
      options[key.slice(2)] = process.argv[i + 1];
    }
    await runSuite(options);
    console.log("table_write_native_validation_passed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
