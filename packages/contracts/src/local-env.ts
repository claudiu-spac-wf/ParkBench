import path from "node:path";
import { createRequire } from "node:module";
import { parseImageReference, parseImageTag } from "./image-reference";

export type LocalEnvironmentState = "loaded" | "missing";
export interface LocalEnvironmentProfile {
  root: string;
  file: string;
  state: LocalEnvironmentState;
  sourceKeys: string[];
  values: Record<string, string>;
  sources: Record<string, "environment_file" | "process_environment">;
  conflicts: Array<{
    key: string;
    sources: ["environment_file", "process_environment"];
    effectiveSource: "process_environment";
  }>;
}

interface EnvironmentLoader {
  findRepositoryRoot(start?: string): string;
  loadEnvironment(options?: {
    root?: string;
    envFile?: string;
    required?: boolean;
    preferFile?: boolean;
  }): {
    root: string;
    file: string;
    exists: boolean;
    keys: string[];
    values: Record<string, string>;
    sources: Record<string, "environment_file" | "process_environment">;
    conflicts: LocalEnvironmentProfile["conflicts"];
  };
}

function loader(): EnvironmentLoader {
  const require = createRequire(__filename);
  const candidates = [
    path.resolve(__dirname, "../../../../scripts/lib/load-env.cjs"),
    path.resolve(__dirname, "../../../scripts/lib/load-env.cjs")
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate) as EnvironmentLoader;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("parkbench_environment_loader_not_found");
}

export function loadLocalEnvironment(
  options: { required?: boolean; root?: string; envFile?: string; preferFile?: boolean } = {}
): LocalEnvironmentProfile {
  const loaded = loader().loadEnvironment({
    root: options.root,
    envFile: options.envFile,
    required: options.required,
    preferFile: options.preferFile
  });
  return {
    root: loaded.root,
    file: loaded.file,
    state: loaded.exists ? "loaded" : "missing",
    sourceKeys: loaded.keys,
    values: loaded.values,
    sources: loaded.sources,
    conflicts: loaded.conflicts
  };
}

export function loadOpenEdgeImageEnvironment(root: string, outputRoot?: string): LocalEnvironmentProfile {
  const repositoryRoot = path.resolve(root);
  const imageOutputRoot = outputRoot
    ? path.resolve(repositoryRoot, outputRoot)
    : path.join(repositoryRoot, ".parkbench/openedge");
  return loadLocalEnvironment({
    root: repositoryRoot,
    envFile: path.join(imageOutputRoot, "images.env"),
    required: true,
    preferFile: true
  });
}

const PLATFORM_IMAGE_KEYS = [
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
] as const;

export function requirePlatformEnvironment(root?: string): LocalEnvironmentProfile {
  const profile = loadLocalEnvironment({ root, required: true });
  if (!process.env.PARKBENCH_IMAGE_TAG)
    throw new Error("platform_setting_required:PARKBENCH_IMAGE_TAG");
  try {
    parseImageTag(process.env.PARKBENCH_IMAGE_TAG);
  } catch (error) {
    throw new Error(
      `platform_setting_invalid:PARKBENCH_IMAGE_TAG:${String(error).replace(/^Error:\s*/, "")}`
    );
  }
  for (const key of PLATFORM_IMAGE_KEYS) {
    const value = process.env[key];
    if (!value) throw new Error(`platform_setting_required:${key}`);
    try {
      parseImageReference(value);
    } catch (error) {
      throw new Error(`platform_setting_invalid:${key}:${String(error).replace(/^Error:\s*/, "")}`);
    }
  }
  return profile;
}

export function redactedEnvironmentDiagnostic(error: unknown): string {
  const text = String(error).replace(/=[^:\s]+/g, "=<redacted>");
  return text.replace(/(password|secret|token|credential|license)[^:]*/gi, "$1");
}
