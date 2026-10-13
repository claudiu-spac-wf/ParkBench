#!/usr/bin/env node

if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log("parkbench-openedge-compiler-adapter/1.0.0");
  process.exit(0);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveCompilerSchema } from "./compiler-schema.mjs";
const require = createRequire(import.meta.url);
const { databaseMemoryArguments } = require("../lib/db-memory.cjs");
const environment = require("../lib/load-env.cjs");
environment.loadEnvironment();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compileDriver = path.join(repoRoot, "scripts/openedge/compile-source.p");
const databaseName =
  process.env.PARKBENCH_OPENEDGE_COMPILER_DB_NAME ??
  process.env.PARKBENCH_OPENEDGE_DATABASE_NAME ??
  "parkbench";
// A supplied definition file initializes an empty database. Legacy seed paths never mount data.
const schemaFile =
  process.env.PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE ||
  process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA;
const databaseHost = process.env.PARKBENCH_OPENEDGE_COMPILER_DB_HOST ?? "127.0.0.1";
const databasePort = process.env.PARKBENCH_OPENEDGE_COMPILER_DB_PORT ?? "20931";
const compilerPropath =
  process.env.PARKBENCH_OPENEDGE_COMPILER_PROPATH ??
  "/parkbench/source,/psc/dlc/tty,/psc/dlc/tty/OpenEdge.Core.apl,/psc/dlc/tty/netlib/OpenEdge.Net.apl";
const dockerCommand = process.env.PARKBENCH_OPENEDGE_DOCKER_COMMAND ?? "docker";
const databaseImage = process.env.PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE;
if (!databaseImage) {
  console.error("compiler_db_image_required:PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE");
  process.exit(1);
}
environment.validateExplicitTaggedImage(databaseImage);
const readyTimeoutMs = Number.parseInt(
  process.env.PARKBENCH_OPENEDGE_COMPILER_DB_READY_TIMEOUT_MS ?? "120000",
  10
);

function docker(args, options = {}) {
  return execFileSync(dockerCommand, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function inspectStatus(container) {
  return docker(["inspect", "--format", "{{.State.Status}}", container]).trim();
}

function containerLogs(container) {
  try {
    return docker(["logs", "--tail", "80", container]).trim();
  } catch {
    return "";
  }
}

function sleep(milliseconds) {
  // The adapter starts one broker per source batch. An
  // Atomics wait keeps the polling interval quiet without spinning a CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ready(container) {
  try {
    docker([
      "exec",
      "--user",
      "pscadmin",
      container,
      "/bin/sh",
      "-c",
      `test -f /psc/wrk/${databaseName}/${databaseName}.db && pgrep -x _mprosrv >/dev/null`
    ]);
    return true;
  } catch {
    return false;
  }
}

function compile(container, sourceName) {
  try {
    return docker([
      "exec",
      "--user",
      "pscadmin",
      "-e",
      `PROPATH=/parkbench/source/${path.posix.dirname(sourceName)},${compilerPropath}`,
      container,
      "/psc/dlc/bin/pro",
      "-T",
      "/psc/wrk",
      "-db",
      `/psc/wrk/${databaseName}`,
      "-H",
      databaseHost,
      "-S",
      databasePort,
      "-b",
      "-p",
      "/parkbench/compile-source.p",
      "-param",
      `/parkbench/source/${sourceName}`
    ]);
  } catch (error) {
    const detail = [error?.stdout, error?.stderr]
      .filter(Boolean)
      .join(" ")
      .replaceAll(/\s+/g, " ")
      .trim();
    throw new Error(`compiler_command_failed${detail ? `:${detail.slice(-2000)}` : ""}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const requested = args[0] === "--batch" ? args.slice(1) : args;
  if (!requested.length || (args[0] !== "--batch" && requested.length !== 1))
    throw new Error("compiler_source_required");
  const sourcePaths = [...new Set(requested.map((file) => path.resolve(file)))];
  for (const sourcePath of sourcePaths)
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
      throw new Error("compiler_source_missing");
  if (!fs.existsSync(compileDriver)) throw new Error("compiler_driver_missing");
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1000)
    throw new Error("compiler_db_ready_timeout_invalid");

  let sourceDirectory = path.dirname(sourcePaths[0]);
  while (
    sourcePaths.some((file) => path.relative(sourceDirectory, file).startsWith(`..${path.sep}`))
  )
    sourceDirectory = path.dirname(sourceDirectory);
  if (sourceDirectory === path.parse(sourceDirectory).root)
    throw new Error("compiler_sources_root_invalid");
  const localRoot = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
  const hostRoot = process.env.PARKBENCH_DOCKER_HOST_PATH_ROOT;
  const toHostPath = (directory) =>
    localRoot &&
    hostRoot &&
    (directory === localRoot || directory.startsWith(`${localRoot}${path.sep}`))
      ? path.join(hostRoot, path.relative(localRoot, directory))
      : directory;
  const hostSourceDirectory = toHostPath(sourceDirectory);
  if (!schemaFile && process.env.PARKBENCH_OPENEDGE_COMPILER_SEED_DIR)
    throw new Error("compiler_schema_required:PARKBENCH_OPENEDGE_COMPILE_SCHEMA");
  const schema = schemaFile ? resolveCompilerSchema(schemaFile, repoRoot) : undefined;
  const compiledPaths = sourcePaths.map((file) => `${file.slice(0, -path.extname(file).length)}.r`);
  for (const file of compiledPaths) fs.rmSync(file, { force: true });
  const stagedDriver = path.join(sourceDirectory, ".parkbench-compile-source.p");
  fs.copyFileSync(compileDriver, stagedDriver);
  const stagedStructure = path.join(sourceDirectory, ".parkbench-compiler.st");
  if (schema) fs.writeFileSync(stagedStructure, schema.structure);
  const container = `parkbench-compiler-${os.hostname().replaceAll(/[^a-zA-Z0-9_.-]/g, "-")}-${process.pid}-${Date.now()}`;
  let attempted = false;
  let completed = false;
  try {
    attempted = true;
    docker([
      "run",
      "-d",
      "--pull=never",
      ...databaseMemoryArguments(),
      "--platform",
      "linux/amd64",
      "--name",
      container,
      "-v",
      `${hostSourceDirectory}:/parkbench/source:rw`,
      "-v",
      `${path.join(hostSourceDirectory, ".parkbench-compile-source.p")}:/parkbench/compile-source.p:ro`,
      "-e",
      `DB_NAME=${databaseName}`,
      "-e",
      "PARKBENCH_DB_INIT_MODE=empty",
      ...(schema
        ? [
            "--entrypoint",
            "/bin/sh",
            "-v",
            `${toHostPath(schema.schemaFile)}:/parkbench/compiler.df:ro`,
            "-v",
            `${toHostPath(stagedStructure)}:/parkbench/compiler.st:ro`,
            "-v",
            `${toHostPath(path.join(repoRoot, "scripts/openedge/init-compiler-db.sh"))}:/parkbench/init-compiler-db.sh:ro`,
            "-v",
            `${toHostPath(path.join(repoRoot, "scripts/openedge/load-compiler-schema.p"))}:/parkbench/load-compiler-schema.p:ro`
          ]
        : []),
      databaseImage,
      ...(schema ? ["/parkbench/init-compiler-db.sh"] : [])
    ]);

    const deadline = Date.now() + readyTimeoutMs;
    while (!ready(container)) {
      if (Date.now() >= deadline) {
        const logs = containerLogs(container);
        throw new Error(`compiler_db_timeout${logs ? `:${logs}` : ""}`);
      }
      if (inspectStatus(container) === "exited") {
        const logs = containerLogs(container);
        throw new Error(`compiler_db_exited${logs ? `:${logs}` : ""}`);
      }
      sleep(1000);
    }

    for (let index = 0; index < sourcePaths.length; index++) {
      const sourceName = path
        .relative(sourceDirectory, sourcePaths[index])
        .split(path.sep)
        .join("/");
      compile(container, sourceName);
      if (!fs.existsSync(compiledPaths[index]) || !fs.statSync(compiledPaths[index]).isFile())
        throw new Error(`compiler_output_missing:${sourceName}`);
    }
    completed = true;
  } finally {
    if (!completed) for (const file of compiledPaths) fs.rmSync(file, { force: true });
    fs.rmSync(stagedDriver, { force: true });
    if (schema) fs.rmSync(stagedStructure, { force: true });
    if (attempted) {
      try {
        // -v also removes the container's /psc/wrk volume, which holds the empty compiler database.
        docker(["rm", "-f", "-v", container], { stdio: "ignore" });
      } catch {
        // Preserve the compiler failure; cleanup is best effort.
      }
    }
  }
}

try {
  main();
} catch (error) {
  const message = String(error).replaceAll(/\s+/g, " ").trim();
  console.error(
    message.length <= 2000 ? message : `${message.slice(0, 120)} ... ${message.slice(-1800)}`
  );
  process.exitCode = 1;
}
