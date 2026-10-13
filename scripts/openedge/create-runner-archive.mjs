#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const environment = require("../lib/load-env.cjs");
const { prepareRunnerArchive } = await import("./package-runner.mjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    outputRoot: process.env.PARKBENCH_OPENEDGE_OUTPUT_ROOT ?? ".parkbench/openedge",
    stage: "final",
    workloadRoot: process.env.PARKBENCH_OPENEDGE_WORKLOAD_ROOT ?? "openedge/workloads/Workloads",
    pasoeImage: undefined,
    allowEmpty: false,
    skipCompilation: false,
    manifest: undefined,
    handlerPath: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--allow-empty") {
      result.allowEmpty = true;
      continue;
    }
    if (argument === "--skip-compilation") {
      result.skipCompilation = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unknown_argument:${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`argument_value_required:${argument}`);
    index += 1;
    if (argument === "--output-root") result.outputRoot = value;
    else if (argument === "--stage") result.stage = value;
    else if (argument === "--workload-root") result.workloadRoot = value;
    else if (argument === "--pasoe-image") result.pasoeImage = value;
    else if (argument === "--manifest") result.manifest = value;
    else if (argument === "--handler-path") result.handlerPath = value;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (!["generic", "final"].includes(result.stage))
    throw new Error("stage_invalid:use generic or final");
  return result;
}

export function helpText() {
  return `Create the oepas1 PAS runner archive without building an image.
  --output-root PATH     generated OpenEdge output root (default .parkbench/openedge)
  --stage STAGE          generic or final (default final)
  --workload-root PATH   workload source root
  --pasoe-image IMAGE    optional PASOE image used to copy oeabl.war
  --allow-empty          allow a missing or empty workload root
  --skip-compilation     package already compiled staged workloads
  --manifest PATH        archive contents manifest to embed
  --handler-path PATH    staged compiled ParkBench handler source
`;
}

export function createRunnerArchive(options = {}) {
  const outputRoot = path.resolve(repoRoot, options.outputRoot ?? ".parkbench/openedge");
  const stage = options.stage ?? "final";
  const workloadRoot = path.resolve(
    repoRoot,
    options.workloadRoot ?? "openedge/workloads/Workloads"
  );
  if (!["generic", "final"].includes(stage)) throw new Error("stage_invalid:use generic or final");
  const result = prepareRunnerArchive({
    workloadRoot,
    outputRoot,
    stage,
    handlerPath:
      options.handlerPath ?? path.join(repoRoot, "openedge/runner/ParkBenchWorkHandler.cls"),
    servicePath: path.join(repoRoot, "openedge/runner/service.json"),
    runtimePath: path.join(repoRoot, "openedge/runner/runtime.properties"),
    pasoeBaseImage: options.pasoeImage,
    allowEmpty: options.allowEmpty === true,
    compileHandler: stage === "final" && !options.skipCompilation,
    compileWorkloads: !options.skipCompilation,
    archiveContents: options.manifest
      ? JSON.parse(require("node:fs").readFileSync(options.manifest, "utf8"))
      : undefined
  });
  return { outputRoot, stage, artifact: result.artifact, archive: result.archive };
}

function main() {
  try {
    environment.loadEnvironment({ root: repoRoot });
    const options = parseArgs();
    if (options.help) {
      console.log(helpText());
      return;
    }
    console.log(JSON.stringify({ valid: true, ...createRunnerArchive(options) }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ valid: false, error: String(error) }, null, 2));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) main();
