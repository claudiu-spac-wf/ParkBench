import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveCompilerSchema } from "./compiler-schema.mjs";
import { loadContracts } from "../lib/contracts.mjs";
const require = createRequire(import.meta.url);
const { loadEnvironment, findRepositoryRoot } = require("../lib/load-env.cjs");
const repoRoot = findRepositoryRoot(new URL("..", import.meta.url).pathname);
loadEnvironment({ root: repoRoot });

const DEFAULTS = {
  progressRoot: process.env.PARKBENCH_OPENEDGE_PROGRESS_ROOT ?? "../IMAGES",
  license: process.env.PARKBENCH_OPENEDGE_LICENSE_PATH ?? "../progress.cfg",
  dbImage:
    process.env.PARKBENCH_OPENEDGE_DB_BASE_IMAGE ??
    process.env.PARKBENCH_OPENEDGE_DB_IMAGE ??
    "progresssoftware/prgs-oedb:12.8.11_ent",
  pasoeImage:
    process.env.PARKBENCH_OPENEDGE_PAS_BASE_IMAGE ??
    process.env.PARKBENCH_OPENEDGE_PAS_IMAGE ??
    "progresssoftware/prgs-pasoe:12.8.11",
  jdkPath: process.env.PARKBENCH_OPENEDGE_JDK_PATH ?? "/usr/lib/jvm",
  seedsRoot: process.env.PARKBENCH_DISCOVERY_SEEDS_ROOT ?? ".parkbench/seeds",
  compileSchema: process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA,
  compileSeed:
    process.env.PARKBENCH_OPENEDGE_COMPILE_SEED || process.env.PARKBENCH_OPENEDGE_DEFAULT_SEED,
  databaseName: process.env.PARKBENCH_OPENEDGE_DATABASE_NAME || "parkbench",
  workloadRoot: process.env.PARKBENCH_OPENEDGE_WORKLOAD_ROOT ?? "openedge/workloads/Workloads",
  outputRoot: process.env.PARKBENCH_OPENEDGE_OUTPUT_ROOT ?? ".parkbench/openedge",
  imageStage: "all",
  jdkImage: process.env.PARKBENCH_OPENEDGE_JDK_IMAGE
};

export function parseArgs(argv = process.argv.slice(2)) {
  const result = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unknown_argument:${arg}`);
    const key = arg.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`argument_value_required:${arg}`);
    index += 1;
    const names = {
      progress_root: "progressRoot",
      license: "license",
      db_image: "dbImage",
      pasoe_image: "pasoeImage",
      jdk_image: "jdkImage",
      jdk_path: "jdkPath",
      seeds_root: "seedsRoot",
      compile_seed: "compileSeed",
      compile_schema: "compileSchema",
      workload_root: "workloadRoot",
      output_root: "outputRoot",
      image_stage: "imageStage"
    };
    if (!names[key]) throw new Error(`unknown_argument:${arg}`);
    result[names[key]] = value;
  }
  return result;
}

export function helpText() {
  return `OpenEdge image preflight/build options:
  --progress-root PATH   supplied Progress asset tree (default ../IMAGES)
  --license PATH          private progress.cfg (default ../progress.cfg)
  --db-image IMAGE        imported DB image
  --pasoe-image IMAGE     imported PASOE image
  --jdk-image IMAGE       imported compatible JDK image (required)
  --jdk-path PATH         JDK path inside the JDK image
  --seeds-root PATH       folder holding the seed databases (default .parkbench/seeds)
  --compile-seed NAME     reference seed name recorded in the manifest
  --compile-schema PATH   matching .df loaded into the empty compiler database
  --workload-root PATH    workload source root
  --output-root PATH      ignored generated output root
  --image-stage STAGE     generic, final, or all
`;
}

export function normalizeOptions(input = {}) {
  const options = { ...DEFAULTS, ...input };
  options.progressRoot = resolveRepositoryPath(options.progressRoot);
  options.license = resolveRepositoryPath(options.license);
  options.workloadRoot = resolveRepositoryPath(options.workloadRoot);
  options.outputRoot = resolveRepositoryPath(options.outputRoot);
  options.seedsRoot = resolveRepositoryPath(options.seedsRoot);
  if (!options.jdkImage) throw new Error("jdk_image_required:configure --jdk-image");
  if (!["generic", "final", "all"].includes(options.imageStage))
    throw new Error("image_stage_invalid:use generic, final, or all");
  for (const [key, value] of Object.entries({
    db_image: options.dbImage,
    pasoe_image: options.pasoeImage,
    jdk_image: options.jdkImage
  })) {
    try {
      validateImageReference(value, key);
    } catch (error) {
      throw new Error(`${key.replace(/_image$/, "")}_image_invalid`);
    }
  }
  return options;
}

function resolveRepositoryPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repoRoot, value);
}

export function validateCompilerAdapter(configuredPath, root = repoRoot) {
  if (!configuredPath)
    throw new Error("compiler_adapter_setting_required:PARKBENCH_OPENEDGE_COMPILER");
  const file = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(root, configuredPath);
  if (!fs.existsSync(file)) throw new Error("compiler_adapter_missing:PARKBENCH_OPENEDGE_COMPILER");
  let stat;
  try {
    stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    throw new Error("compiler_adapter_not_executable:PARKBENCH_OPENEDGE_COMPILER");
  }
  if (!stat.isFile())
    throw new Error("compiler_adapter_not_executable:PARKBENCH_OPENEDGE_COMPILER");
  return "available";
}

function validateImageReference(value, key) {
  if (typeof value !== "string" || !value) throw new Error(`${key}_image_required`);
  if (/\s/.test(value)) throw new Error(`${key}_image_invalid`);
  const named = value.split("@", 1)[0];
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  const tag = colon > slash ? named.slice(colon + 1) : "";
  if (!tag) throw new Error(`${key}_image_tag_required`);
  if (tag.toLowerCase() === "latest") throw new Error(`${key}_image_latest_forbidden`);
}

export function dockerInspect(image, label = "image") {
  try {
    const output = execFileSync("docker", ["image", "inspect", image], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const values = JSON.parse(output);
    if (!Array.isArray(values) || !values[0]) throw new Error("empty_inspection");
    return values[0];
  } catch {
    throw new Error(`image_unavailable:${label}`);
  }
}

export function checkPath(file, label, directory = false) {
  if (!fs.existsSync(file)) throw new Error(`${label}_missing`);
  const stat = fs.statSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${label}_wrong_type`);
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new Error(`${label}_unreadable`);
  }
}

/** Resolves and validates the seed database the final stage compiles against. */
export function resolveCompileSeed(options) {
  if (!options.compileSeed)
    throw new Error("compile_seed_required:PARKBENCH_OPENEDGE_DEFAULT_SEED");
  const seedDir = path.join(options.seedsRoot, options.compileSeed);
  if (!fs.existsSync(seedDir) || !fs.statSync(seedDir).isDirectory())
    throw new Error(`compile_seed_missing:${options.compileSeed}`);
  const seed = loadContracts().validateSeedDirectory(seedDir);
  return { name: seed.name, databaseName: seed.databaseName, seedDir };
}

function seedReadiness(options) {
  if (options.imageStage === "generic") return { status: "not_required" };
  return {
    status: "available",
    seed: resolveCompileSeed(options),
    schema: resolveCompilerSchema(options.compileSchema, repoRoot)
  };
}

export function runPreflight(input = {}) {
  const options = normalizeOptions(input);
  const seed = seedReadiness(options);
  if (seed.seed && seed.schema)
    Object.assign(seed.seed, {
      schemaFile: seed.schema.schemaFile,
      schemaSha256: seed.schema.sha256
    });
  if (options.imageStage !== "generic") {
    validateCompilerAdapter(process.env.PARKBENCH_OPENEDGE_COMPILER);
  }
  checkPath(options.progressRoot, "progress_assets", true);
  checkPath(options.license, "license");
  const entries = fs.readdirSync(options.progressRoot);
  if (!entries.some((name) => /DATABASE|OEDB/i.test(name)))
    throw new Error("progress_database_assets_not_found");
  if (!entries.some((name) => /PASOE/i.test(name)))
    throw new Error("progress_pasoe_assets_not_found");
  const db = dockerInspect(options.dbImage, "db");
  const pasoe = dockerInspect(options.pasoeImage, "pasoe");
  const jdk = dockerInspect(options.jdkImage, "jdk");
  if (!jdk.Id) throw new Error("jdk_image_inspection_incomplete");
  const expectedArchitecture = process.arch === "x64" ? "amd64" : process.arch;
  for (const [name, image] of Object.entries({ db: db, pasoe: pasoe, jdk: jdk })) {
    if (image.Architecture && image.Architecture !== expectedArchitecture)
      throw new Error(
        `image_architecture_mismatch:${name}:${image.Architecture}:${expectedArchitecture}`
      );
  }
  {
    try {
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--entrypoint",
          "/bin/sh",
          options.jdkImage,
          "-c",
          `test -d '${options.jdkPath.replaceAll("'", "")}' && test -x '${options.jdkPath.replaceAll("'", "")}/bin/java'`
        ],
        {
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch {
      throw new Error("jdk_path_unavailable:PARKBENCH_OPENEDGE_JDK_PATH");
    }
  }
  if (!Number.isInteger(20931) || !Number.isInteger(8810)) throw new Error("fixed_ports_invalid");
  return {
    options,
    images: { db, pasoe, jdk },
    seed: seed.seed,
    diagnostics: {
      progressAssets: "available",
      license: "available",
      importedImages: { db: "available", pasoe: "available", jdk: "available" },
      compilerAdapter: options.imageStage === "generic" ? "not_required" : "executable",
      jdk: "available",
      workloadSources: "available",
      outputRoot: "configured",
      databaseName: seed.seed?.databaseName ?? options.databaseName,
      compileSeed: seed.seed?.name ?? options.compileSeed ?? null,
      seedReadiness: seed.status,
      dbBrokerPort: 20931,
      dbDynamicPorts: "20932-20941",
      pasInstance: "oepas1",
      pasPort: 8810,
      imageStage: options.imageStage
    }
  };
}

function main() {
  try {
    const args = parseArgs();
    if (args.help) {
      console.log(helpText());
      return;
    }
    console.log(
      JSON.stringify(
        {
          valid: true,
          stage: "input_preflight",
          component: "openedge-inputs",
          checks: [
            "progress_assets",
            "license_input",
            "imported_images",
            "jdk_path",
            "compiler_adapter"
          ],
          ...runPreflight(args).diagnostics
        },
        null,
        2
      )
    );
  } catch (error) {
    const code = safeErrorCode(error);
    console.error(
      JSON.stringify(
        {
          valid: false,
          error: code,
          stage: "input_preflight",
          component: "openedge-inputs",
          diagnosticCode: code.split(":", 1)[0],
          recoveryAction: recoveryAction(code)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

function safeErrorCode(error) {
  const value = String(error?.message ?? error ?? "openedge_preflight_failed");
  const code = value
    .split(/[:\s]/, 1)[0]
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase();
  return code || "openedge_preflight_failed";
}

function recoveryAction(code) {
  if (code.includes("image"))
    return "Check the named image setting and import the required image into the Docker Engine selected by the Docker CLI.";
  if (code.includes("license"))
    return "Set PARKBENCH_OPENEDGE_LICENSE_PATH to the locally supplied license file.";
  if (code.includes("progress"))
    return "Set PARKBENCH_OPENEDGE_PROGRESS_ROOT to the locally supplied Progress assets.";
  if (code.includes("compiler"))
    return "Set PARKBENCH_OPENEDGE_COMPILER to an executable local compiler adapter.";
  if (code.includes("compile_schema"))
    return "Set PARKBENCH_OPENEDGE_COMPILE_SCHEMA to the .df used to create the run seed; compilation loads it into an empty database.";
  if (code.includes("seed"))
    return "Set PARKBENCH_OPENEDGE_DEFAULT_SEED to a Linux OpenEdge database folder under PARKBENCH_DISCOVERY_SEEDS_ROOT.";
  if (code.includes("jdk"))
    return "Check the configured JDK image and PARKBENCH_OPENEDGE_JDK_PATH.";
  return "Review the configured OpenEdge inputs and rerun the OpenEdge preflight.";
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) main();
