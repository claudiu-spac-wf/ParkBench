import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
export interface ParkBenchConfig {
  host: string;
  port: number;
  dbPath: string;
  artifactRoot: string;
  runRoot?: string;
  prometheusUrl: string;
  grafanaUrl?: string;
  grafanaHealthUrl?: string;
  cadvisorUrl?: string;
  prometheusTargetDir?: string;
  prometheusScrapeInterval?: string;
  prometheusScrapeIntervalSeconds?: number;
  cadvisorHousekeepingSeconds?: number;
  prometheusRetention: string;
  platformImages?: {
    prometheus: string;
    grafana: string;
    cadvisor: string;
    nodeExporter: string;
    nodeBase: string;
    nginx: string;
  };
  discoveryRoots?: {
    scenarios: string;
    workloads: string;
    observers: string;
    seeds: string;
    archives: string;
  };
  openedge: {
    dbImage?: string;
    version?: string;
    databaseFeatures?: string[];
    pasImage?: string;
    observerImage?: string;
    /** Seed folder under the seeds discovery root that runs and compilation use by default. */
    defaultSeed?: string;
    /** Seed the final image build compiles against (defaults to defaultSeed). */
    compileSeed?: string;
    appArchive?: string;
    credentialRef?: string;
    dbObserverExecutable?: string;
    dbObserverProcedure?: string;
    dbObserverRuntimePath?: string;
    dbObserverArgs?: string[];
    progressRoot?: string;
    licensePath?: string;
    jdkImage?: string;
    jdkPath?: string;
    outputRoot?: string;
    workloadRoot?: string;
    databaseName?: string;
    dbBrokerPort?: number;
    dbMinPort?: number;
    dbMaxPort?: number;
    pasInstance?: string;
    pasPort?: number;
    imageManifestPath?: string;
  };
}
interface PathResolver {
  findRepositoryRoot(start?: string): string;
  resolveHostPath(
    input: string,
    options?: {
      root?: string;
      allowedRoot?: string;
      requireExisting?: boolean;
      allowMissingRoot?: boolean;
    }
  ): string;
  isPathWithin(candidate: string, root: string): boolean;
  mapHostPathToContainer(
    hostPath: string,
    hostRoot: string,
    containerRoot: string,
    options?: { root?: string }
  ): string;
}

function pathResolver(): PathResolver {
  const require = createRequire(__filename);
  const candidates = [
    path.resolve(__dirname, "../../../../scripts/lib/resolve-paths.cjs"),
    path.resolve(__dirname, "../../../scripts/lib/resolve-paths.cjs")
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate) as PathResolver;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("parkbench_path_resolver_not_found");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { root?: string } = {}
): ParkBenchConfig {
  const prometheusScrapeInterval = env.PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL ?? "5s";
  const prometheusScrapeIntervalSeconds = prometheusDurationSeconds(prometheusScrapeInterval);
  if (prometheusScrapeIntervalSeconds === undefined)
    throw new Error("platform_setting_invalid:PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL");
  const cadvisorHousekeepingSeconds = prometheusDurationSeconds(
    env.PARKBENCH_CADVISOR_HOUSEKEEPING_INTERVAL ?? "1s"
  );
  if (cadvisorHousekeepingSeconds === undefined)
    throw new Error("platform_setting_invalid:PARKBENCH_CADVISOR_HOUSEKEEPING_INTERVAL");
  const resolver = pathResolver();
  const configuredRoot = options.root ?? env.PARKBENCH_REPOSITORY_ROOT;
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : resolver.findRepositoryRoot(__dirname);
  const resolvePath = (value: string): string => {
    const hostPath = resolver.resolveHostPath(value, {
      root,
      allowMissingRoot: Boolean(env.PARKBENCH_REPOSITORY_ROOT && !options.root)
    });
    const containerRoot = env.PARKBENCH_CONTAINER_PATH_ROOT;
    const hostRoot = env.PARKBENCH_DOCKER_HOST_PATH_ROOT;
    if (!containerRoot || !hostRoot || !path.isAbsolute(containerRoot)) return hostPath;
    const canonicalHostRoot = resolver.resolveHostPath(hostRoot, { root });
    if (!resolver.isPathWithin(hostPath, canonicalHostRoot)) return hostPath;
    return resolver.mapHostPathToContainer(hostPath, canonicalHostRoot, containerRoot, { root });
  };
  return {
    host: env.PARKBENCH_HOST ?? "127.0.0.1",
    port: Number(env.PARKBENCH_PORT ?? 3000),
    dbPath:
      env.PARKBENCH_DB_PATH === ":memory:"
        ? ":memory:"
        : resolvePath(env.PARKBENCH_DB_PATH ?? ".parkbench/parkbench.sqlite"),
    artifactRoot: resolvePath(env.PARKBENCH_ARTIFACT_ROOT ?? ".parkbench/artifacts"),
    runRoot: resolvePath(env.PARKBENCH_RUN_ROOT ?? ".parkbench/runs"),
    prometheusUrl: env.PARKBENCH_PROMETHEUS_URL ?? "http://127.0.0.1:9090",
    grafanaUrl: env.PARKBENCH_GRAFANA_URL ?? "http://127.0.0.1:13001",
    grafanaHealthUrl:
      env.PARKBENCH_GRAFANA_HEALTH_URL ?? env.PARKBENCH_GRAFANA_URL ?? "http://127.0.0.1:13001",
    cadvisorUrl: env.PARKBENCH_CADVISOR_URL ?? "http://127.0.0.1:8080",
    prometheusTargetDir: resolvePath(
      env.PARKBENCH_PROMETHEUS_TARGET_DIR ?? ".parkbench/prometheus-targets"
    ),
    prometheusScrapeInterval,
    prometheusScrapeIntervalSeconds,
    cadvisorHousekeepingSeconds,
    prometheusRetention: env.PARKBENCH_PROMETHEUS_RETENTION ?? "7d",
    platformImages: {
      prometheus: env.PARKBENCH_PROMETHEUS_IMAGE ?? "",
      grafana: env.PARKBENCH_GRAFANA_IMAGE ?? "",
      cadvisor: env.PARKBENCH_CADVISOR_IMAGE ?? "",
      nodeExporter: env.PARKBENCH_NODE_EXPORTER_IMAGE ?? "",
      nodeBase: env.PARKBENCH_NODE_BASE_IMAGE ?? "",
      nginx: env.PARKBENCH_NGINX_IMAGE ?? ""
    },
    discoveryRoots: {
      scenarios: resolvePath(env.PARKBENCH_DISCOVERY_SCENARIOS_ROOT ?? "examples/scenarios"),
      workloads: resolvePath(
        env.PARKBENCH_DISCOVERY_WORKLOADS_ROOT ??
          env.PARKBENCH_OPENEDGE_WORKLOAD_ROOT ??
          "openedge/workloads/Workloads"
      ),
      observers: resolvePath(env.PARKBENCH_DISCOVERY_OBSERVERS_ROOT ?? ".parkbench/observers"),
      seeds: resolvePath(env.PARKBENCH_DISCOVERY_SEEDS_ROOT ?? ".parkbench/seeds"),
      archives: resolvePath(env.PARKBENCH_DISCOVERY_ARCHIVES_ROOT ?? ".parkbench/archives")
    },
    openedge: {
      dbImage: env.PARKBENCH_OPENEDGE_DB_IMAGE,
      version: env.PARKBENCH_OPENEDGE_VERSION ?? "12.8.11",
      databaseFeatures: (env.PARKBENCH_OPENEDGE_DB_FEATURES ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      pasImage: env.PARKBENCH_OPENEDGE_PAS_IMAGE,
      observerImage: env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE,
      defaultSeed: env.PARKBENCH_OPENEDGE_DEFAULT_SEED?.trim() || undefined,
      compileSeed:
        env.PARKBENCH_OPENEDGE_COMPILE_SEED?.trim() ||
        env.PARKBENCH_OPENEDGE_DEFAULT_SEED?.trim() ||
        undefined,
      appArchive: resolveOptionalPath(env.PARKBENCH_OPENEDGE_APP_ARCHIVE, resolvePath),
      credentialRef: env.PARKBENCH_OPENEDGE_CREDENTIAL_REF,
      dbObserverExecutable: env.PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE,
      dbObserverProcedure: env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE,
      dbObserverRuntimePath: env.PARKBENCH_OPENEDGE_DB_OBSERVER_RUNTIME_PATH,
      dbObserverArgs: parseJsonStringArray(env.PARKBENCH_OPENEDGE_DB_OBSERVER_ARGS),
      progressRoot: resolveOptionalPath(env.PARKBENCH_OPENEDGE_PROGRESS_ROOT, resolvePath),
      licensePath: resolveOptionalPath(env.PARKBENCH_OPENEDGE_LICENSE_PATH, resolvePath),
      jdkImage: env.PARKBENCH_OPENEDGE_JDK_IMAGE,
      jdkPath: env.PARKBENCH_OPENEDGE_JDK_PATH ?? "/usr/lib/jvm",
      outputRoot: resolveOptionalPath(env.PARKBENCH_OPENEDGE_OUTPUT_ROOT, resolvePath),
      workloadRoot: resolveOptionalPath(env.PARKBENCH_OPENEDGE_WORKLOAD_ROOT, resolvePath),
      databaseName: env.PARKBENCH_OPENEDGE_DATABASE_NAME?.trim() || "parkbench",
      dbBrokerPort: Number(env.PARKBENCH_OPENEDGE_DB_BROKER_PORT ?? 20931),
      dbMinPort: Number(env.PARKBENCH_OPENEDGE_DB_MINPORT ?? 20932),
      dbMaxPort: Number(env.PARKBENCH_OPENEDGE_DB_MAXPORT ?? 20941),
      pasInstance: env.PARKBENCH_OPENEDGE_PAS_INSTANCE ?? "oepas1",
      pasPort: Number(env.PARKBENCH_OPENEDGE_PAS_PORT ?? 8810),
      imageManifestPath: resolveOptionalPath(env.PARKBENCH_OPENEDGE_IMAGE_MANIFEST, resolvePath)
    }
  };
}

function prometheusDurationSeconds(value: string): number | undefined {
  if (typeof value !== "string" || !/^(?:\d+(?:ms|s|m|h|d|w|y))+$/.test(value)) return undefined;
  const scale = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  let seconds = 0;
  for (const match of value.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g))
    seconds += Number(match[1]) * scale[match[2] as keyof typeof scale];
  return seconds > 0 && Number.isFinite(seconds) ? seconds : undefined;
}

function resolveOptionalPath(
  value: string | undefined,
  resolvePath: (value: string) => string
): string | undefined {
  return value ? resolvePath(value) : undefined;
}

function parseJsonStringArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
      throw new Error("not_string_array");
    return parsed;
  } catch {
    throw new Error("openedge_observer_args_invalid");
  }
}
export function resolveInputReference(reference: string, allowedRoot = process.cwd()): string {
  if (reference.startsWith("input:")) return reference;
  const resolver = pathResolver();
  try {
    return resolver.resolveHostPath(reference, { root: allowedRoot, allowedRoot });
  } catch (error) {
    if (error instanceof Error && error.message === "path_symlink_dangling")
      throw new Error("input_path_symlink_dangling");
    throw new Error("input_path_outside_allowed_root");
  }
}
