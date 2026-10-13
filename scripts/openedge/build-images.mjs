import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { collectSensitiveValues, redactDiagnosticText } from "../redact-diagnostics.mjs";
const require = createRequire(import.meta.url);
const environment = require("../lib/load-env.cjs");
environment.loadEnvironment();
const { verifySelectedDockerTarget } = require("../lib/docker-target.cjs");
if (!process.argv.includes("--help")) environment.validatePlatformEnvironment();
import { parseArgs, helpText, runPreflight } from "./preflight.mjs";
import { cleanupPrivateStage, stageInputs, writeAtomic } from "./stage-inputs.mjs";
import { prepareRunnerArchive } from "./package-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const diagnosticSecrets = collectSensitiveValues(repoRoot, process.env);
const handlerPath = path.join(repoRoot, "openedge/runner/ParkBenchWorkHandler.cls");
const servicePath = path.join(repoRoot, "openedge/runner/service.json");
const runtimePath = path.join(repoRoot, "openedge/runner/runtime.properties");
const observerProcedure = path.join(repoRoot, "openedge/observers/db/parkbench-db-observer-v2.p");

export async function buildImages(input = {}) {
  verifySelectedDockerTarget({ root: repoRoot });
  // Images must package the matching adapter/schema, not a previous dist build.
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  const options = input.options ?? input;
  const requestedStage = options.imageStage ?? "all";
  const genericStartedAt = Date.now();
  let generic;
  if (requestedStage === "generic" || requestedStage === "all") {
    generic = await buildGeneric(options, genericStartedAt);
  }
  if (requestedStage === "final" || requestedStage === "all") {
    const genericManifest = generic?.manifest ?? readGenericManifest(options.outputRoot);
    return await buildFinal(options, genericManifest, genericStartedAt);
  }
  return generic;
}

async function buildGeneric(rawOptions, totalStartedAt) {
  const preflight = runPreflight({ ...rawOptions, imageStage: "generic" });
  const startedAt = Date.now();
  const { options } = preflight;
  const staged = stageInputs(options, "generic", preflight.images);
  try {
    const archive = prepareRunnerArchive({
      workloadRoot: path.join(staged.stageRoot, "generic-workloads"),
      outputRoot: options.outputRoot,
      stage: "generic",
      stageRoot: staged.stageRoot,
      handlerPath,
      servicePath,
      runtimePath,
      pasoeBaseImage: options.pasoeImage,
      allowEmpty: true,
      compileHandler: false
    });
    // The generic stage needs no seed: the DB image carries none, and the VST-only observer
    // compiles against an empty database.
    const contexts = createContexts(options, staged, archive.archive);
    const dbTag = "12.8.11-db-generic";
    const pasTag = "12.8.11-runner-generic";
    const observerTag = "12.8.11-db-observer";
    const dbImage = buildImage(
      "parkbench/openedge-db",
      dbTag,
      contexts.db,
      {
        DB_BASE_IMAGE: options.dbImage,
        JDK_IMAGE: options.jdkImage,
        JDK_PATH: options.jdkPath
      },
      options.outputRoot,
      "generic-db"
    );
    const pasImage = buildImage(
      "parkbench/openedge-pasoe",
      pasTag,
      contexts.pasoe,
      {
        DB_BASE_IMAGE: options.dbImage,
        PASOE_BASE_IMAGE: options.pasoeImage,
        JDK_IMAGE: options.jdkImage,
        JDK_PATH: options.jdkPath,
        PARKBENCH_IMAGE_STAGE: "generic",
        PARKBENCH_READY: "false"
      },
      options.outputRoot,
      "generic-pasoe"
    );
    compileObserverProcedure(contexts.observer, dbImage.reference, options.databaseName);
    const observerImage = buildImage(
      "parkbench/openedge-observer",
      observerTag,
      contexts.observer,
      {
        OBSERVER_BASE_IMAGE: options.dbImage,
        NODE_BASE_IMAGE: process.env.PARKBENCH_NODE_BASE_IMAGE,
        OPENEDGE_DB_OBSERVER_PROTOCOL_VERSION: "3",
        OPENEDGE_DB_OBSERVER_SOURCE_SHA256: createHash("sha256")
          .update(fs.readFileSync(observerProcedure))
          .digest("hex")
      },
      options.outputRoot,
      "generic-observer"
    );
    const manifest = makeManifest({
      stage: "generic",
      startedAt,
      totalStartedAt,
      dbImage,
      pasImage,
      observerImage,
      jdkImage: artifactFor(options.jdkImage),
      databaseName: options.databaseName,
      archive,
      inputs: staged.inputs,
      workloads: []
    });
    const paths = writeStageOutputs(options.outputRoot, "generic", manifest);
    return { manifest, paths };
  } finally {
    cleanupPrivateStage(staged);
  }
}

async function buildFinal(rawOptions, genericManifest, totalStartedAt) {
  validateGenericManifest(genericManifest);
  const labels = JSON.parse(
    execFileSync(
      process.env.PARKBENCH_OPENEDGE_DOCKER_COMMAND ?? "docker",
      [
        "image",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        genericManifest.observer.reference
      ],
      { encoding: "utf8" }
    )
  );
  const expectedHash = createHash("sha256")
    .update(fs.readFileSync(observerProcedure))
    .digest("hex");
  if (
    labels?.["org.parkbench.openedge-db-observer.procedure"] !== "parkbench-db-observer-v2.r" ||
    labels?.["org.parkbench.openedge-db-observer.source-sha256"] !== expectedHash
  )
    throw new Error("generic_observer_rebuild_required:rebuild generic before final");
  const preflight = runPreflight({ ...rawOptions, imageStage: "final" });
  const startedAt = Date.now();
  const { options } = preflight;
  const compileSeed = preflight.seed;
  if (!compileSeed) throw new Error("compile_seed_required:PARKBENCH_OPENEDGE_DEFAULT_SEED");
  const staged = stageInputs(options, "final", preflight.images);
  try {
    const archive = withCompilerDatabase(genericManifest.db.reference, compileSeed, () =>
      prepareRunnerArchive({
        workloadRoot: options.workloadRoot,
        outputRoot: options.outputRoot,
        stage: "final",
        stageRoot: staged.stageRoot,
        handlerPath,
        servicePath,
        runtimePath,
        pasoeBaseImage: options.pasoeImage,
        allowEmpty: false,
        compileHandler: true
      })
    );
    if (!archive.handlerCompiled || archive.procedures.some((procedure) => !procedure.compiled))
      throw new Error("workload_compilation_required:configure PARKBENCH_OPENEDGE_COMPILER");
    const contexts = createContexts(options, staged, archive.archive);
    const pasImage = buildImage(
      "parkbench/openedge-pasoe",
      "12.8.11-runner-final",
      contexts.pasoe,
      {
        DB_BASE_IMAGE: options.dbImage,
        PASOE_BASE_IMAGE: options.pasoeImage,
        JDK_IMAGE: options.jdkImage,
        JDK_PATH: options.jdkPath,
        PARKBENCH_IMAGE_STAGE: "final",
        PARKBENCH_READY: "true"
      },
      options.outputRoot,
      "final-pasoe"
    );
    const totalDurationMs = Math.max(0, Date.now() - totalStartedAt);
    const manifest = makeManifest({
      stage: "final",
      startedAt,
      totalStartedAt,
      dbImage: genericManifest.db,
      pasImage,
      observerImage: genericManifest.observer,
      jdkImage: genericManifest.jdk,
      databaseName: compileSeed.databaseName,
      compileSchema: {
        seed: compileSeed.name,
        databaseName: compileSeed.databaseName,
        schemaSha256: compileSeed.schemaSha256
      },
      archive,
      inputs: [
        ...staged.inputs,
        ...archive.procedures.flatMap((procedure) => [
          {
            kind: "workloads",
            reference: procedure.procName,
            version: "source",
            private: false
          },
          ...(procedure.contract
            ? [
                {
                  kind: "workloads",
                  reference: procedure.contract.path,
                  version: "contract",
                  private: false
                }
              ]
            : [])
        ])
      ],
      workloads: archive.procedures.map((procedure) => ({
        procName: procedure.procName,
        compiled: procedure.compiled,
        signature: procedure.signature,
        pathStatus: procedure.pathStatus,
        ...(procedure.contract
          ? {
              contract: {
                path: procedure.contract.path
              }
            }
          : {}),
        imageReference: pasImage.reference
      })),
      totalBuildDurationMs: totalDurationMs
    });
    const paths = writeStageOutputs(options.outputRoot, "final", manifest);
    return { manifest, paths };
  } finally {
    cleanupPrivateStage(staged);
  }
}

/**
 * Points compile-with-db at the DB image and, for workloads, at a seed database. Without a
 * seed the compiler uses an empty database, which is enough for the VST-only observer.
 */
export function withCompilerDatabase(imageReference, seed, callback) {
  const values = {
    PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE: imageReference,
    PARKBENCH_OPENEDGE_COMPILER_SEED_DIR: "",
    PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE: seed?.schemaFile ?? "",
    PARKBENCH_OPENEDGE_COMPILE_SCHEMA: seed?.schemaFile ?? "",
    PARKBENCH_OPENEDGE_COMPILER_DB_NAME: seed?.databaseName
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function compileObserverProcedure(observerContext, databaseImageReference, databaseName) {
  const source = path.join(observerContext, "parkbench-db-observer-v2.p");
  const compiled = path.join(observerContext, "parkbench-db-observer-v2.r");
  fs.rmSync(compiled, { force: true });
  withCompilerDatabase(databaseImageReference, { databaseName }, () =>
    execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/openedge/compile-with-db.mjs"), source],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
  );
  if (!fs.existsSync(compiled) || !fs.statSync(compiled).isFile())
    throw new Error("openedge_db_observer_compile_output_missing");
  return { source, compiled };
}

export function createContexts(options, staged, archive) {
  const contextsRoot = path.join(staged.stageRoot, "contexts");
  const db = path.join(contextsRoot, "db");
  const pasoe = path.join(contextsRoot, "pasoe");
  const observer = path.join(contextsRoot, "observer");
  for (const directory of [db, pasoe, observer]) fs.mkdirSync(directory, { recursive: true });
  for (const manifest of [
    "package.json",
    "package-lock.json",
    "apps/control-plane/package.json",
    "apps/loadgen/package.json",
    "apps/observer/package.json",
    "apps/web/package.json",
    "packages/compose-runner/package.json",
    "packages/contracts/package.json",
    "packages/metrics/package.json",
    "packages/observers/package.json",
    "packages/test-support/package.json"
  ])
    copy(path.join(repoRoot, manifest), path.join(observer, manifest));
  copy(path.join(repoRoot, "docker/openedge-db/Dockerfile"), path.join(db, "Dockerfile"));
  copy(path.join(repoRoot, "docker/openedge-db/entrypoint.sh"), path.join(db, "entrypoint.sh"));
  copy(path.join(repoRoot, "docker/openedge-db/copy-seed.sh"), path.join(db, "copy-seed.sh"));
  for (const file of ["prepare-controls.sh", "controls-lifecycle.sh", "compile-startup-state.p"])
    copy(path.join(repoRoot, "docker/openedge-db", file), path.join(db, file));
  copy(
    path.join(repoRoot, "openedge/observers/db/parkbench-db-startup-state.p"),
    path.join(db, "parkbench-db-startup-state.p")
  );
  copy(path.join(repoRoot, "docker/openedge-pasoe/Dockerfile"), path.join(pasoe, "Dockerfile"));
  copy(
    path.join(repoRoot, "docker/openedge-pasoe/entrypoint.sh"),
    path.join(pasoe, "entrypoint.sh")
  );
  copy(
    path.join(repoRoot, "docker/openedge-pasoe/apply-db-connection.sh"),
    path.join(pasoe, "apply-db-connection.sh")
  );
  copy(
    path.join(repoRoot, "docker/openedge-pasoe/runtime.properties"),
    path.join(pasoe, "runtime.properties")
  );
  copy(
    path.join(repoRoot, "docker/openedge-observer/Dockerfile"),
    path.join(observer, "Dockerfile")
  );
  copy(
    path.join(repoRoot, "docker/openedge-observer/parkbench-openedge-db-observer"),
    path.join(observer, "parkbench-openedge-db-observer")
  );
  copy(observerProcedure, path.join(observer, "parkbench-db-observer-v2.p"));
  copy(
    path.join(repoRoot, "scripts/lib/load-env.cjs"),
    path.join(observer, "scripts/lib/load-env.cjs")
  );
  copy(
    path.join(repoRoot, "scripts/lib/resolve-paths.cjs"),
    path.join(observer, "scripts/lib/resolve-paths.cjs")
  );
  copyDirectory(path.join(repoRoot, "dist"), path.join(observer, "dist"));
  for (const directory of [db, pasoe, observer])
    fs.mkdirSync(path.join(directory, "license"), { recursive: true });
  copy(staged.stagedLicense, path.join(db, "license/progress.cfg"));
  copy(staged.stagedLicense, path.join(pasoe, "license/progress.cfg"));
  copy(staged.stagedLicense, path.join(observer, "license/progress.cfg"));
  fs.mkdirSync(path.join(pasoe, "runner"), { recursive: true });
  copy(
    path.isAbsolute(archive) ? archive : path.resolve(archive),
    path.join(pasoe, "runner/oepas1.zip")
  );
  return { db, pasoe, observer };
}

function buildImage(repository, tag, context, buildArgs, outputRoot, logName) {
  tag = process.env.PARKBENCH_IMAGE_TAG || tag;
  if (tag.endsWith("latest")) throw new Error("image_tag_latest_forbidden");
  const reference = `${repository}:${tag}`;
  try {
    const output = execFileSync(
      "docker",
      [
        "build",
        "--pull=false",
        ...Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
        "-t",
        reference,
        context
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    fs.mkdirSync(path.join(outputRoot, "images"), { recursive: true });
    writeAtomic(path.join(outputRoot, "images", `${logName}.log`), redact(output));
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
    const diagnosticCode = classifyBuildFailure(output);
    fs.mkdirSync(path.join(outputRoot, "images"), { recursive: true });
    writeAtomic(path.join(outputRoot, "images", `${logName}.log`), redact(output));
    const buildError = new Error(`docker_build_failed:${logName}`);
    buildError.buildDiagnostic = {
      stage: logName.startsWith("generic-") ? "openedge_generic" : "openedge_final",
      component: logName,
      diagnosticCode,
      diagnosticLog: `images/${logName}.log`,
      recoveryAction: recoveryActionForBuild(diagnosticCode)
    };
    throw buildError;
  }
  return artifactFor(reference);
}

function artifactFor(reference) {
  let inspection;
  try {
    inspection = JSON.parse(
      execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8" })
    )[0];
  } catch {
    throw new Error(`image_inspection_failed:${reference}`);
  }
  const namedReference = reference.split("@", 1)[0];
  const separator = namedReference.lastIndexOf(":");
  const hasTag = separator > namedReference.lastIndexOf("/");
  const repository = hasTag ? namedReference.slice(0, separator) : namedReference;
  const tag = hasTag ? namedReference.slice(separator + 1) : "imported";
  return {
    repository,
    tag,
    reference
  };
}

function makeManifest({
  stage,
  startedAt,
  dbImage,
  pasImage,
  observerImage,
  jdkImage,
  databaseName,
  compileSchema,
  archive,
  inputs,
  workloads,
  totalBuildDurationMs
}) {
  const manifest = {
    schemaVersion: "image-build.v2",
    imageStage: stage,
    parkBenchReady: stage === "final",
    createdAt: new Date().toISOString(),
    db: dbImage,
    pasoe: pasImage,
    observer: observerImage,
    observerContract: {
      protocolVersion: 4,
      tableCoverage: "all_tables",
      parameterCaptureVersion: "openedge-db-parameter-capture.v1"
    },
    jdk: jdkImage,
    databaseName,
    ...(compileSchema ? { compileSchema } : {}),
    runnerArchive: archive.artifact,
    workloadRoot: "Workloads",
    buildDurationMs: Math.max(0, Date.now() - startedAt),
    ...(totalBuildDurationMs === undefined ? {} : { totalBuildDurationMs }),
    inputs,
    workloads
  };
  return manifest;
}

export function writeStageOutputs(outputRoot, stage, manifest) {
  const directory = stage === "generic" ? path.join(outputRoot, "stages/generic") : outputRoot;
  if (stage === "final") assertFinalOutputOwnership(outputRoot);
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const envPath = path.join(directory, "images.env");
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeAtomic(
    envPath,
    `${[
      `PARKBENCH_OPENEDGE_DB_IMAGE=${manifest.db.reference}`,
      `PARKBENCH_OPENEDGE_PAS_IMAGE=${manifest.pasoe.reference}`,
      `PARKBENCH_OPENEDGE_OBSERVER_IMAGE=${manifest.observer.reference}`,
      `PARKBENCH_OPENEDGE_APP_ARCHIVE=${quoteEnvironmentValue(path.resolve(outputRoot, manifest.runnerArchive.path))}`,
      "PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE=parkbench-openedge-db-observer",
      "PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE=/app/openedge/observers/db/parkbench-db-observer-v2.r",
      `PARKBENCH_OPENEDGE_IMAGE_MANIFEST=${quoteEnvironmentValue(manifestPath)}`,
      `PARKBENCH_OPENEDGE_IMAGE_STAGE=${manifest.imageStage}`,
      `PARKBENCH_OPENEDGE_PARKBENCH_READY=${manifest.parkBenchReady}`
    ].join("\n")}\n`
  );
  return { manifestPath, envPath };
}

function quoteEnvironmentValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function readGenericManifest(outputRoot) {
  if (!outputRoot) throw new Error("generic_manifest_required_for_final_stage");
  const file = path.join(path.resolve(outputRoot), "stages/generic/manifest.json");
  if (!fs.existsSync(file)) throw new Error("generic_manifest_required_for_final_stage");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("generic_manifest_invalid");
  }
}

function validateGenericManifest(manifest) {
  if (
    manifest?.schemaVersion !== "image-build.v2" ||
    manifest.imageStage !== "generic" ||
    manifest.parkBenchReady !== false
  )
    throw new Error("generic_manifest_not_usable");
  for (const item of [manifest.db, manifest.observer]) {
    const reference = item?.reference ?? "";
    const named = reference.split("@", 1)[0];
    const slash = named.lastIndexOf("/");
    const colon = named.lastIndexOf(":");
    const tag = colon > slash ? named.slice(colon + 1) : "";
    if (!tag || tag.toLowerCase() === "latest") throw new Error("generic_manifest_image_invalid");
  }
}

function assertFinalOutputOwnership(outputRoot) {
  const root = path.resolve(outputRoot);
  const manifestPath = path.join(root, "manifest.json");
  const envPath = path.join(root, "images.env");
  const manifestOwned = isParkBenchFinalManifest(manifestPath);
  const envOwned = isParkBenchFinalEnvironment(envPath);
  if ((fs.existsSync(manifestPath) && !manifestOwned) || (fs.existsSync(envPath) && !envOwned))
    throw new Error("openedge_output_conflict:preserving_unowned_file");
}

function isParkBenchFinalManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    // v1 manifests are ParkBench-owned too; a v2 final build replaces them.
    return (
      ["image-build.v1", "image-build.v2"].includes(value.schemaVersion) &&
      value.imageStage === "final"
    );
  } catch {
    return false;
  }
}

function isParkBenchFinalEnvironment(file) {
  try {
    const value = fs.readFileSync(file, "utf8");
    return (
      value.includes("PARKBENCH_OPENEDGE_IMAGE_STAGE=final") &&
      value.includes("PARKBENCH_OPENEDGE_PARKBENCH_READY=true")
    );
  } catch {
    return false;
  }
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

export function redact(value) {
  return redactDiagnosticText(value, diagnosticSecrets);
}

function classifyBuildFailure(value) {
  const text = String(value).toLowerCase();
  if (
    /copy .*not found|failed to compute cache key.*not found|no such file or directory/.test(text)
  )
    return "build_context_source_missing";
  if (/permission denied|cannot connect to the docker daemon|docker daemon.*unavailable/.test(text))
    return "docker_engine_access_failed";
  if (/no space left on device|disk quota exceeded/.test(text)) return "disk_space_exhausted";
  if (/no matching manifest|exec format error|platform .* does not match/.test(text))
    return "image_architecture_mismatch";
  if (/pull access denied|manifest unknown|not found.*image/.test(text))
    return "base_image_unavailable";
  return "docker_build_failed";
}

function recoveryActionForBuild(code) {
  if (code === "build_context_source_missing")
    return "Check the generic observer Dockerfile COPY sources and generated build context, then rerun bootstrap.";
  if (code === "docker_engine_access_failed")
    return "Restore access to the Docker Engine selected by the Docker CLI and rerun bootstrap.";
  if (code === "disk_space_exhausted")
    return "Free disk space on the ParkBench build filesystem and rerun bootstrap.";
  if (code === "image_architecture_mismatch")
    return "Use a locally available base image compatible with the supported amd64 host.";
  if (code === "base_image_unavailable")
    return "Import the configured base image into the selected Docker Engine, then rerun bootstrap.";
  return "Review the retained redacted Docker build log and rerun bootstrap after correcting the reported cause.";
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(helpText());
    return;
  }
  buildImages(args)
    .then((result) =>
      console.log(
        JSON.stringify(
          {
            valid: true,
            imageStage: result.manifest.imageStage,
            parkBenchReady: result.manifest.parkBenchReady,
            manifestPath: path
              .relative(repoRoot, result.paths.manifestPath)
              .split(path.sep)
              .join("/"),
            component: "openedge-images"
          },
          null,
          2
        )
      )
    )
    .catch((error) => {
      const diagnostic = error?.buildDiagnostic ?? {};
      const message = /^[a-z][a-z0-9_]*(?::[a-z0-9_-]+)?$/.test(String(error?.message ?? ""))
        ? String(error.message)
        : "openedge_build_failed";
      console.error(
        JSON.stringify(
          {
            valid: false,
            error: message,
            stage: diagnostic.stage ?? "openedge_build",
            component: diagnostic.component ?? "openedge-images",
            diagnosticCode: diagnostic.diagnosticCode ?? message.split(":", 1)[0],
            diagnosticLog: diagnostic.diagnosticLog ?? "images/build.log",
            recoveryAction:
              diagnostic.recoveryAction ??
              "Review the OpenEdge input preflight and rerun the build after correcting the failed check."
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    });
}

if (import.meta.url === new URL(`file://${path.resolve(process.argv[1] ?? "")}`).href) main();
