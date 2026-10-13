const fs = require("node:fs");
const path = require("node:path");

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class EnvironmentFileError extends Error {
  constructor(code, file, line, setting, detail) {
    super(
      `${code}:${path.basename(file)}:${line}${setting ? `:${setting}` : ""}${detail ? `:${detail}` : ""}`
    );
    this.name = "EnvironmentFileError";
    this.code = code;
    this.file = file;
    this.line = line;
    this.setting = setting;
  }
}

function findRepositoryRoot(start = __dirname) {
  let current = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, "scripts"))
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("parkbench_repository_root_not_found");
    current = parent;
  }
}

function parseValue(raw, file, line, setting) {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || value[value.length - 1] !== quote)
      throw new EnvironmentFileError("env_unterminated_quote", file, line, setting);
    const contents = value.slice(1, -1);
    return quote === '"' ? contents.replace(/\\(["\\])/g, "$1") : contents;
  }
  return value;
}

function parseEnvFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { values: {}, keys: [], exists: false };
    throw new EnvironmentFileError("env_file_unreadable", file, 0);
  }
  const values = {};
  const keys = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = rawLine.indexOf("=");
    if (separator < 1) throw new EnvironmentFileError("env_assignment_malformed", file, line);
    const setting = rawLine.slice(0, separator).trim();
    if (!NAME.test(setting))
      throw new EnvironmentFileError("env_name_invalid", file, line, setting);
    if (Object.prototype.hasOwnProperty.call(values, setting))
      throw new EnvironmentFileError("env_duplicate_setting", file, line, setting);
    values[setting] = parseValue(rawLine.slice(separator + 1), file, line, setting);
    keys.push(setting);
  }
  return { values, keys, exists: true };
}

function resolveEnvFile(root, requested) {
  const value = requested || ".env.local";
  return require("./resolve-paths.cjs").resolveHostPath(value, { root });
}

function loadEnvironment(options = {}) {
  const root = path.resolve(options.root || findRepositoryRoot());
  const file = resolveEnvFile(root, options.envFile || process.env.PARKBENCH_ENV_FILE);
  const parsed = parseEnvFile(file);
  if (!parsed.exists && options.required)
    throw new EnvironmentFileError("env_file_missing", file, 0);
  const values = { ...parsed.values };
  const sources = {};
  const conflicts = [];
  const preferFile = options.preferFile === true;
  for (const [key, value] of Object.entries(parsed.values)) {
    const processValue = process.env[key];
    if (preferFile || processValue === undefined) {
      process.env[key] = value;
      values[key] = value;
      sources[key] = "environment_file";
      if (preferFile && processValue !== undefined && processValue !== value) {
        conflicts.push({
          key,
          sources: ["environment_file", "process_environment"],
          effectiveSource: "environment_file"
        });
      }
    } else {
      values[key] = processValue;
      sources[key] = "process_environment";
      if (processValue !== value) {
        conflicts.push({
          key,
          sources: ["environment_file", "process_environment"],
          effectiveSource: "process_environment"
        });
      }
    }
  }
  return { root, file, exists: parsed.exists, keys: parsed.keys, values, sources, conflicts };
}

function reportEnvironmentConflicts(result, write = console.error) {
  for (const conflict of result.conflicts ?? [])
    write(
      `environment_conflict:${conflict.key}:sources=${conflict.sources.join(",")}:effective=${conflict.effectiveSource}`
    );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validatePlatformEnvironment() {
  if (!process.env.PARKBENCH_IMAGE_TAG)
    throw new Error("platform_setting_required:PARKBENCH_IMAGE_TAG");
  try {
    validateImageTag(process.env.PARKBENCH_IMAGE_TAG);
  } catch {
    throw new Error("platform_setting_invalid:PARKBENCH_IMAGE_TAG");
  }
  const keys = [
    "PARKBENCH_PROMETHEUS_IMAGE",
    "PARKBENCH_GRAFANA_IMAGE",
    "PARKBENCH_CADVISOR_IMAGE",
    "PARKBENCH_NODE_EXPORTER_IMAGE",
    "PARKBENCH_NODE_BASE_IMAGE",
    "PARKBENCH_NGINX_IMAGE",
    "PARKBENCH_LOADGEN_IMAGE",
    "PARKBENCH_OBSERVER_IMAGE",
    "PARKBENCH_OPENEDGE_DB_IMAGE",
    "PARKBENCH_OPENEDGE_PAS_IMAGE",
    "PARKBENCH_OPENEDGE_JDK_IMAGE"
  ];
  for (const key of keys) {
    const value = process.env[key];
    if (!value) throw new Error(`platform_setting_required:${key}`);
    try {
      validateExplicitTaggedImage(value);
    } catch {
      throw new Error(`platform_setting_invalid:${key}`);
    }
  }
  const scrapeInterval = process.env.PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL || "5s";
  if (
    !/^(?:\d+(?:ms|s|m|h|d|w|y))+$/.test(scrapeInterval) ||
    ![...scrapeInterval.matchAll(/(\d+)(?:ms|s|m|h|d|w|y)/g)].some((match) => Number(match[1]) > 0)
  )
    throw new Error("platform_setting_invalid:PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL");
}

function validateExplicitTaggedImage(value) {
  if (typeof value !== "string" || !value || /\s/.test(value)) throw new Error("image_invalid");
  const at = value.indexOf("@");
  const named = at >= 0 ? value.slice(0, at) : value;
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  const tag = colon > slash ? named.slice(colon + 1) : "";
  if (!tag) throw new Error("image_tag_required");
  if (tag.toLowerCase() === "latest") throw new Error("image_latest_forbidden");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(named.slice(0, colon)))
    throw new Error("image_invalid");
  return value;
}

function validateImageTag(value) {
  if (typeof value !== "string" || !value) throw new Error("image_tag_required");
  if (value.length > 128 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value))
    throw new Error("image_tag_invalid");
  if (value.toLowerCase() === "latest") throw new Error("image_tag_latest_forbidden");
  return value;
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : undefined;
  const envIndex = argv.indexOf("--env-file");
  const envFile = envIndex >= 0 ? argv[envIndex + 1] : undefined;
  const shell = argv.includes("--shell");
  const required = argv.includes("--required");
  const preferFile = argv.includes("--prefer-file");
  const result = loadEnvironment({ root, envFile, required, preferFile });
  reportEnvironmentConflicts(result);
  if (argv.includes("--platform")) validatePlatformEnvironment();
  if (shell) {
    for (const key of result.keys) {
      if (process.env[key] !== undefined)
        console.log(`export ${key}=${shellQuote(process.env[key])}`);
    }
    console.log(`export PARKBENCH_ENV_FILE=${shellQuote(result.file)}`);
  }
  return result;
}

module.exports = {
  EnvironmentFileError,
  findRepositoryRoot,
  loadEnvironment,
  reportEnvironmentConflicts,
  parseEnvFile,
  validatePlatformEnvironment,
  validateExplicitTaggedImage,
  validateImageTag
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "env_load_failed");
    process.exitCode = 1;
  }
}
