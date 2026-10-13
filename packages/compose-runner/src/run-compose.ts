import path from "node:path";
import { encodeDatabaseArgv } from "./database-argv";
import {
  databaseParameterInput,
  databaseParameterTokens,
  databaseParameterDefinition,
  DATABASE_PARAMETER_REGISTRY_VERSION
} from "../../contracts/src/database-parameter-options";
import { legacyDatabaseParameterDefinition } from "../../contracts/src/database-parameter-options-v1";
import { createRequire } from "node:module";
import { Scenario } from "../../contracts/src/scenario";
import { composeProjectName } from "./project-name";
import { ownershipLabels } from "./ownership";
import { ParameterPlan, parameterPlan } from "./parameters";
import { checkImageReference } from "./input-checks";
import type { DatabaseStartupParameters } from "../../contracts/src/database-startup";
import type { DatabaseRunControls } from "../../contracts/src/database-run-controls";

interface CpuSetTools {
  databaseMemoryLimit(env?: NodeJS.ProcessEnv): string;
  cpuSetForService(service: string, env?: NodeJS.ProcessEnv): string;
  validateCpuSetConfiguration(env?: NodeJS.ProcessEnv): { setting: string; reason: string } | null;
}

function cpuSetTools(): CpuSetTools {
  const require = createRequire(__filename);
  const candidates = [
    path.resolve(__dirname, "../../../scripts/lib/cpuset.cjs"),
    path.resolve(__dirname, "../../../../scripts/lib/cpuset.cjs")
  ];
  for (const candidate of candidates) {
    try {
      require.resolve(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      continue;
    }
    // Only an absent candidate permits fallback. Preserve errors in its dependencies.
    return require(candidate) as CpuSetTools;
  }
  throw new Error("parkbench_cpuset_helper_not_found");
}
export interface ComposeBundle {
  projectName: string;
  file: string;
  brokerArgv?: string;
  brokerDirectories?: string;
  scenario: Scenario;
  metricsNetworkName: string;
  localPaths: string[];
  summaryPath?: string;
  shutdownPath?: string;
  workloadStartPath?: string;
  observerPorts?: Record<string, number>;
  /** `/work` procedures validated through the PAS observer before measurement. */
  schemaReadinessProcedures?: string[];
  databaseRunControls?: DatabaseRunControls;
  databaseRunControlEvidence?: import("./database-run-controls-evidence").DatabaseRunControlsEvidence;
  databaseName?: string;
  expectedBiBuffers?: number;
  databaseConnectionDemand?: number;
  resources: Array<{ type: string; name: string; labels: Record<string, string> }>;
}
export interface RunInputMounts {
  /** Seed folder (an on-disk Linux OpenEdge database), mounted read-only into the database. */
  seed?: string;
  /** The seed's database name; drives DB_NAME, the PAS connection and the DB observer. */
  databaseName?: string;
  /** `/work` procedures whose workload contract asks for schema readiness validation. */
  schemaReadinessProcedures?: string[];
  applicationArchive?: string;
  credentialRef?: string;
  variantId?: string;
  repetition?: number;
  phaseScale?: number;
  summaryPath?: string;
  shutdownPath?: string;
  workloadStartPath?: string;
  parameters?: Record<string, string | number | boolean>;
  databaseStartup?: DatabaseStartupParameters;
  databaseRunControls?: DatabaseRunControls;
  dbObserverProcedure?: string;
  dbObserverExecutable?: string;
  dbObserverArgs?: string[];
  dbObserverRuntimePath?: string;
  phaseClockPath?: string;
  /** Isolated run-owned directory for mutable workload hand-off files. */
  runtimeDirectory?: string;
  loadgenImage?: string;
  observerImage?: string;
  dbObserverImage?: string;
}
export function generateRunCompose(
  runId: string,
  experimentId: string,
  scenario: Scenario,
  images: { db: string; pas: string },
  inputs: RunInputMounts = {}
): ComposeBundle {
  if (inputs.runtimeDirectory) {
    for (const [filename, value] of Object.entries({
      "summary.json": inputs.summaryPath,
      shutdown: inputs.shutdownPath,
      "workload-start": inputs.workloadStartPath,
      "phase-clock.json": inputs.phaseClockPath
    })) {
      if (value !== path.join(inputs.runtimeDirectory, filename))
        throw new Error("workload_runtime_path_invalid");
    }
  }
  const projectName = composeProjectName(runId);
  const metricsNetworkName = process.env.PARKBENCH_METRICS_NETWORK ?? "parkbench-platform";
  const labels = ownershipLabels(runId, experimentId, "run");
  const services = [
    `database`,
    ...Array.from({ length: scenario.target.pasReplicas }, (_, i) => `pas-${i + 1}`),
    "loadgen",
    "db-observer",
    "pas-observer",
    "file-sampler"
  ];
  const volumeLabels = (component: string): string =>
    Object.entries({ ...labels, "parkbench.component": component })
      .map(([key, value]) => `      ${key}: "${escapeYaml(value)}"`)
      .join("\n");
  const pasVolumeLines = Array.from({ length: scenario.target.pasReplicas }, (_, index) => {
    const component = `run-service-data-pas-${index + 1}`;
    return [
      `  ${component}:`,
      `    name: ${escapeYaml(`${projectName}_${component}`)}`,
      "    labels:",
      volumeLabels(component)
    ].join("\n");
  });
  const volumeLines = [
    "volumes:",
    "  run-db-data:",
    `    name: ${escapeYaml(`${projectName}_run-db-data`)}`,
    "    labels:",
    volumeLabels("run-db-data"),
    ...pasVolumeLines
  ];
  const loadgenImage = inputs.loadgenImage ?? process.env.PARKBENCH_LOADGEN_IMAGE ?? "";
  const observerImage = inputs.observerImage ?? process.env.PARKBENCH_OBSERVER_IMAGE ?? "";
  const dbObserverImage =
    inputs.dbObserverImage?.trim() ||
    process.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE?.trim() ||
    observerImage;
  checkImageReference(images.db);
  checkImageReference(images.pas);
  checkImageReference(loadgenImage);
  checkImageReference(observerImage);
  checkImageReference(dbObserverImage);
  const runtimeParameters = parameterPlan(inputs.parameters ?? {}, {
    rejectNetworkBrokerReadOnly: Boolean(
      inputs.applicationArchive && !inputs.applicationArchive.startsWith("input:")
    ),
    databaseName: inputs.databaseName,
    legacyDatabaseParameters: !!inputs.databaseStartup && !inputs.databaseStartup.registryVersion,
    databaseRunControls: inputs.databaseRunControls
  });
  if (
    inputs.databaseStartup?.registryVersion &&
    inputs.databaseStartup.registryVersion !== DATABASE_PARAMETER_REGISTRY_VERSION
  )
    throw new Error("database_parameter_registry_unsupported");
  if (inputs.databaseStartup) {
    runtimeParameters.databaseStartupArgs = inputs.databaseStartup.parameters.flatMap((p) => {
      if (p.name === "-pf") {
        if (!inputs.databaseStartup!.expandedParameterFiles?.includes(p.displayValue))
          throw new Error("database_startup_file_required:controlled_pf_expansion");
        return [];
      }
      if (inputs.databaseStartup!.registryVersion)
        return databaseParameterTokens(p.name, databaseParameterInput(p.name, p.displayValue));
      const old = legacyDatabaseParameterDefinition(p.name);
      if (!old) throw new Error(`legacy_database_parameter_unknown:${p.name}`);
      return old.kind === "flag"
        ? p.displayValue === "true"
          ? [p.name]
          : []
        : [p.name, p.displayValue];
    });
  }
  if (!inputs.databaseStartup && runtimeParameters.databaseStartupArgs.includes("-pf"))
    throw new Error("database_startup_file_required:controlled_pf_expansion");
  const brokerArgv = encodeDatabaseArgv(runtimeParameters.databaseStartupArgs);
  const effectiveNative =
    inputs.databaseStartup?.parameters.map((p) => [p.name, p.displayValue] as const) ??
    Object.entries(inputs.parameters ?? {});
  const brokerDirectories = encodeDatabaseArgv(
    effectiveNative
      .filter(([name]) => databaseParameterDefinition(name)?.ownership.rule === "owned_path")
      .flatMap(([name, value]) =>
        name === "-aiarcdir" ? String(value).split(",") : [String(value)]
      )
  );
  delete runtimeParameters.databaseEnvironment.PARKBENCH_OPENEDGE_DB_STARTUP_ARGS;
  delete runtimeParameters.databaseEnvironment.PARKBENCH_OPENEDGE_DB_STARTUP_WORDS;
  runtimeParameters.databaseEnvironment.PARKBENCH_DATABASE_ARGV_FILE = "/run/parkbench/broker.argv";
  if (inputs.seed) runtimeParameters.databaseEnvironment.PARKBENCH_SEED_IDENTITY = inputs.seed;
  const expectedBiBuffers = Number(
    inputs.databaseStartup?.parameters.find((p) => p.name === "-bibufs")?.displayValue ??
      inputs.parameters?.["-bibufs"]
  );
  const databaseConnectionDemand =
    Math.max(
      scenario.target.pasReplicas,
      scenario.workload.load.concurrency ?? scenario.workload.load.maxInFlightPerWorker ?? 1
    ) + 3;
  runtimeParameters.databaseEnvironment.PARKBENCH_REQUIRED_DATABASE_CONNECTIONS =
    String(databaseConnectionDemand);
  if (Number.isSafeInteger(expectedBiBuffers) && expectedBiBuffers >= 3)
    runtimeParameters.databaseEnvironment.PARKBENCH_EXPECTED_BI_BUFFERS = String(expectedBiBuffers);
  const cpuSetIssue = cpuSetTools().validateCpuSetConfiguration(process.env);
  if (cpuSetIssue) throw new Error(`cpu_affinity_${cpuSetIssue.reason}:${cpuSetIssue.setting}`);
  const pasProtocol = scenario.target.pasProtocol ?? "http";
  const pasPort = scenario.target.pasPort ?? 8810;
  const pasWebBasePath =
    inputs.applicationArchive && !inputs.applicationArchive.startsWith("input:")
      ? "/parkbench/web"
      : "";
  const pasHealthPath = `${pasWebBasePath}${scenario.target.healthPath ?? "/health"}`;
  const schemaReadinessProcedures = [...new Set(inputs.schemaReadinessProcedures ?? [])];
  const fileSamplerPath = String(
    scenario.observers.find((observer) => observer.kind === "file_sampler_v1")?.configuration
      ?.path ?? "/psc/wrk"
  );
  const configuredObserverExecutable =
    inputs.dbObserverExecutable ?? process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE;
  const configuredObserverProcedure =
    inputs.dbObserverProcedure ?? process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE;
  const observerExecutable = configuredObserverExecutable
    ? mapRuntimePath(configuredObserverExecutable, inputs.dbObserverRuntimePath)
    : undefined;
  const observerProcedure = configuredObserverProcedure
    ? isPackagedObserverProcedure(configuredObserverProcedure)
      ? configuredObserverProcedure
      : "/run/parkbench/parkbench-db-observer.p"
    : "/app/openedge/observers/db/prepare-run-db-observer.p";
  const envLines = [
    inputs.seed ? `      PARKBENCH_SEED_REF: "${escapeYaml(inputs.seed)}"` : "",
    inputs.applicationArchive
      ? `      PARKBENCH_APP_ARCHIVE_REF: "${escapeYaml(inputs.applicationArchive)}"`
      : "",
    inputs.credentialRef
      ? `      PARKBENCH_CREDENTIAL_REF: "${escapeYaml(inputs.credentialRef)}"`
      : ""
  ].filter(Boolean);
  const credentialKey = credentialEnvironmentKey(inputs.credentialRef);
  const serviceImage = (service: string): string =>
    service === "database"
      ? images.db
      : isPasReplica(service)
        ? images.pas
        : service === "db-observer"
          ? dbObserverImage
          : service === "loadgen"
            ? loadgenImage
            : observerImage;
  const runEnvironment = (service: string): string[] => {
    const lines = [...envLines];
    if (inputs.parameters && Object.keys(inputs.parameters).length)
      lines.push(
        `      PARKBENCH_PARAMETER_ADAPTER_VERSION: "${runtimeParameters.contractVersion}"`,
        `      PARKBENCH_EFFECTIVE_CONFIGURATION: "${escapeYaml(JSON.stringify(inputs.parameters))}"`,
        service === "database"
          ? `      PARKBENCH_DATABASE_PARAMETERS: "${escapeYaml(JSON.stringify(inputs.parameters))}"`
          : "",
        isPasReplica(service)
          ? `      PARKBENCH_PAS_PARAMETERS: "${escapeYaml(JSON.stringify(inputs.parameters))}"`
          : ""
      );
    if (["loadgen", "db-observer", "pas-observer", "file-sampler"].includes(service))
      lines.push(
        `      PARKBENCH_RUN_ID: "${escapeYaml(runId)}"`,
        `      PARKBENCH_EXPERIMENT_ID: "${escapeYaml(experimentId)}"`,
        inputs.variantId
          ? `      PARKBENCH_VARIANT_ID: "${escapeYaml(inputs.variantId)}"`
          : `      PARKBENCH_VARIANT_ID: "baseline"`,
        `      PARKBENCH_REPETITION: "${inputs.repetition ?? 1}"`
      );
    if (service === "database")
      lines.push(
        `      PARKBENCH_RUN_ID: "${escapeYaml(runId)}"`,
        ...Object.entries(runtimeParameters.databaseEnvironment).map(
          ([key, value]) => `      ${key}: "${escapeYaml(value)}"`
        )
      );
    if (isPasReplica(service))
      lines.push(
        ...Object.entries(runtimeParameters.pasEnvironment).map(
          ([key, value]) => `      ${key}: "${escapeYaml(value)}"`
        )
      );
    if (isPasReplica(service)) lines.push(`      PARKBENCH_PAS_PORT: "${pasPort}"`);
    if (service === "loadgen") {
      const runtimePath = inputs.runtimeDirectory ? "/run/parkbench/runtime" : "/run/parkbench";
      lines.push(
        runtimeParameters.workloadSeed === undefined
          ? ""
          : `      PARKBENCH_LOAD_SEED: "${runtimeParameters.workloadSeed}"`,
        inputs.phaseScale === undefined
          ? ""
          : `      PARKBENCH_PHASE_SCALE: "${inputs.phaseScale}"`,
        '      PARKBENCH_METRICS_PORT: "9100"',
        `      PARKBENCH_SUMMARY_PATH: ${runtimePath}/summary.json`,
        `      PARKBENCH_SHUTDOWN_FILE: ${runtimePath}/shutdown`,
        `      PARKBENCH_WORKLOAD_START_FILE: ${runtimePath}/workload-start`,
        inputs.phaseClockPath
          ? `      PARKBENCH_PHASE_CLOCK_PATH: ${runtimePath}/phase-clock.json`
          : "",
        `      PARKBENCH_TARGET_BASE_URL: "${pasProtocol}://${escapeYaml(scenario.target.pasService)}:${pasPort}${pasWebBasePath}"`,
        "      PARKBENCH_SCENARIO_PATH: /run/parkbench/scenario.json"
      );
    }
    if (service === "db-observer")
      lines.push(
        `      PARKBENCH_OPENEDGE_DB_METRICS_ENABLED: "${runtimeParameters.databaseMetricsEnabled}"`,
        `      PARKBENCH_OBSERVER_TARGET_URL: "http://database:8810"`,
        `      PARKBENCH_OBSERVER_KIND: "openedge_db_v1"`,
        `      DB_NAME: "${escapeYaml(runtimeParameters.databaseEnvironment.DB_NAME)}"`,
        observerExecutable
          ? `      PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE: "${escapeYaml(observerExecutable)}"`
          : "",
        `      PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE: ${escapeYaml(observerProcedure)}`,
        inputs.dbObserverArgs?.length
          ? `      PARKBENCH_OPENEDGE_DB_OBSERVER_ARGS: "${escapeYaml(JSON.stringify(inputs.dbObserverArgs))}"`
          : "",
        inputs.dbObserverRuntimePath
          ? "      PARKBENCH_OPENEDGE_DB_OBSERVER_RUNTIME_PATH: /opt/openedge"
          : ""
      );
    if (service === "pas-observer")
      lines.push(
        credentialKey
          ? `      ${credentialKey}: "${composeEnvironmentReference(credentialKey)}"`
          : "",
        `      PARKBENCH_OBSERVER_TARGET_URLS: "${Array.from(
          { length: scenario.target.pasReplicas },
          (_, index) => `${pasProtocol}://pas-${index + 1}:${pasPort}`
        ).join(",")}"`,
        `      PARKBENCH_OBSERVER_KIND: "openedge_pas_v1"`,
        `      PARKBENCH_PAS_HEALTH_PATH: "${escapeYaml(pasHealthPath)}"`,
        `      PARKBENCH_APPLICATION_HEALTH_PATH: "${escapeYaml(pasHealthPath)}"`,
        `      PARKBENCH_WORKLOAD_PATH: "${escapeYaml(`${pasWebBasePath}/work`)}"`,
        schemaReadinessProcedures.length
          ? `      PARKBENCH_SCHEMA_READINESS_PROCEDURES: "${escapeYaml(schemaReadinessProcedures.join(","))}"`
          : ""
      );
    if (service === "file-sampler")
      lines.push(
        `      PARKBENCH_OBSERVER_TARGET_URL: "http://database:8810"`,
        `      PARKBENCH_OBSERVER_KIND: "file_sampler_v1"`,
        `      PARKBENCH_FILE_SAMPLER_PATH: "${escapeYaml(fileSamplerPath)}"`,
        `      PARKBENCH_METRICS_PORT: "9100"`
      );
    if (
      isPasReplica(service) &&
      inputs.applicationArchive &&
      !inputs.applicationArchive.startsWith("input:")
    )
      lines.push("      PARKBENCH_APP_ARCHIVE_PATH: /deploy/artifacts/oepas1.zip");
    return lines.filter(Boolean);
  };
  // Database Latency (feature 016): one NET_ADMIN sidecar per PAS replica and one for the
  // database, each sharing its target's network namespace so tc delays only that target's
  // packets to its peers. Nothing is added when the latency is 0.
  const latencyTargets =
    runtimeParameters.databaseLatencyMs > 0 ? ["database", ...services.filter(isPasReplica)] : [];
  const latencySidecars = latencyTargets.map((target) => `latency-${target}`);
  const yaml = [
    `name: ${projectName}`,
    "services:",
    ...services.map((service) =>
      serviceYaml(
        service,
        projectName,
        runId,
        experimentId,
        serviceImage,
        runEnvironment,
        inputs,
        scenario.target.pasService,
        runtimeParameters,
        pasProtocol,
        pasPort
      )
    ),
    ...latencyTargets.map((target) =>
      latencySidecarYaml(target, runId, experimentId, observerImage)
    ),
    `networks:\n  run-private:\n    name: ${escapeYaml(`${projectName}_run-private`)}\n    labels:\n${volumeLabels("run-private")}\n  run-metrics:\n    external: true\n    name: ${escapeYaml(metricsNetworkName)}`,
    volumeLines.join("\n")
  ].join("\n");
  return {
    projectName,
    file: yaml,
    scenario,
    metricsNetworkName,
    brokerArgv,
    brokerDirectories,
    localPaths: [
      inputs.seed,
      inputs.applicationArchive,
      inputs.dbObserverProcedure,
      inputs.dbObserverRuntimePath,
      inputs.runtimeDirectory,
      inputs.phaseClockPath,
      inputs.workloadStartPath
    ]
      .map(toLocalPath)
      .filter((value): value is string => Boolean(value)),
    summaryPath: inputs.summaryPath,
    schemaReadinessProcedures,
    databaseRunControls: runtimeParameters.databaseRunControls,
    databaseName: runtimeParameters.databaseEnvironment.DB_NAME,
    expectedBiBuffers: Number.isSafeInteger(expectedBiBuffers) ? expectedBiBuffers : undefined,
    databaseConnectionDemand,
    shutdownPath: inputs.shutdownPath,
    workloadStartPath: inputs.workloadStartPath,
    resources: [
      ...[...services, ...latencySidecars].map((name) => ({
        type: "container",
        name,
        labels: { ...labels, "parkbench.component": name }
      })),
      { type: "network", name: `${projectName}_run-private`, labels },
      { type: "volume", name: `${projectName}_run-db-data`, labels },
      ...Array.from({ length: scenario.target.pasReplicas }, (_, index) => ({
        type: "volume",
        name: `${projectName}_run-service-data-pas-${index + 1}`,
        labels: { ...labels, "parkbench.component": `run-service-data-pas-${index + 1}` }
      })),
      { type: "compose_project", name: projectName, labels }
    ]
  };
}

function latencySidecarYaml(
  target: string,
  runId: string,
  experimentId: string,
  image: string
): string {
  const service = `latency-${target}`;
  return [
    `  ${service}:`,
    `    image: ${image}`,
    "    labels:",
    '      parkbench.managed: "true"',
    `      parkbench.run_id: "${runId}"`,
    `      parkbench.experiment_id: "${experimentId}"`,
    `      parkbench.component: "${service}"`,
    `    network_mode: "service:${target}"`,
    "    cap_add:",
    "      - NET_ADMIN",
    '    user: "0:0"',
    "    depends_on:",
    `      - ${target}`,
    '    command: ["sleep", "infinity"]'
  ].join("\n");
}

function serviceYaml(
  service: string,
  projectName: string,
  runId: string,
  experimentId: string,
  serviceImage: (service: string) => string,
  runEnvironment: (service: string) => string[],
  inputs: RunInputMounts,
  pasService: string,
  runtimeParameters: ParameterPlan,
  pasProtocol: "http" | "https",
  pasPort: number
): string {
  const hasEnvironment =
    ["database", "loadgen", "db-observer", "pas-observer", "file-sampler"].includes(service) ||
    isPasReplica(service);
  const environmentLines = hasEnvironment ? runEnvironment(service) : [];
  const environment = environmentLines.length
    ? `\n    environment:\n${environmentLines.join("\n")}`
    : "";
  const cpuLimit = isPasReplica(service)
    ? runtimeParameters.resourceLimits.pas
    : service === "database"
      ? runtimeParameters.resourceLimits.database
      : undefined;
  const resources =
    cpuLimit === undefined
      ? ""
      : `\n    deploy:\n      resources:\n        limits:\n          cpus: "${cpuLimit}"`;
  const cpuSet = cpuSetTools().cpuSetForService(service, process.env);
  const memoryLimit =
    service === "database" ? cpuSetTools().databaseMemoryLimit(process.env) : undefined;
  const memoryLines = memoryLimit
    ? `\n    mem_limit: "${memoryLimit}"\n    memswap_limit: "${memoryLimit}"`
    : "";
  const cpuSetLine = cpuSet ? `\n    cpuset: "${escapeYaml(cpuSet)}"` : "";
  const volumes =
    service === "database"
      ? `\n    volumes:\n      - run-db-data:/psc/wrk\n      - ./${composeProjectName(runId)}-broker.argv:/run/parkbench/broker.argv:ro\n      - ./${composeProjectName(runId)}-broker-directories:/run/parkbench/broker-directories:ro${localMount(inputs.seed, "/run/parkbench/seed/db")}`
      : isPasReplica(service)
        ? `\n    volumes:\n      - run-service-data-${service}:/psc/wrk${localMount(inputs.applicationArchive, "/deploy/artifacts/oepas1.zip")}`
        : service === "loadgen"
          ? `\n    expose:\n      - "9100"\n    volumes:\n      - ./${projectName}-scenario.json:/run/parkbench/scenario.json:ro${inputs.runtimeDirectory ? localMount(inputs.runtimeDirectory, "/run/parkbench/runtime", "rw") : `${localMount(inputs.summaryPath, "/run/parkbench/summary.json", "rw")}${localMount(inputs.shutdownPath, "/run/parkbench/shutdown", "rw")}${localMount(inputs.workloadStartPath, "/run/parkbench/workload-start")}${localMount(inputs.phaseClockPath, "/run/parkbench/phase-clock.json")}`}`
          : service === "file-sampler"
            ? '\n    expose:\n      - "9100"\n    volumes:\n      - run-db-data:/psc/wrk:ro'
            : service === "db-observer"
              ? `\n    expose:\n      - "9100"${volumeBlock(
                  localMount(
                    isPackagedObserverProcedure(
                      inputs.dbObserverProcedure ??
                        process.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE
                    )
                      ? undefined
                      : inputs.dbObserverProcedure,
                    "/run/parkbench/parkbench-db-observer.p"
                  ) + localMount(inputs.dbObserverRuntimePath, "/opt/openedge")
                )}`
              : service.includes("observer")
                ? '\n    expose:\n      - "9100"'
                : "";
  const metricsNetwork = ["loadgen", "db-observer", "pas-observer", "file-sampler"].includes(
    service
  )
    ? `\n      run-metrics:\n        aliases:\n          - ${projectName}-${service}`
    : "";
  const hostMetricsPort = ["loadgen", "db-observer", "pas-observer", "file-sampler"].includes(
    service
  )
    ? '\n    ports:\n      - "127.0.0.1::9100"'
    : "";
  const privateNetwork = isPasReplica(service)
    ? `\n      run-private:\n        aliases:\n          - ${escapeYaml(pasService)}`
    : "\n      run-private: {}";
  return `  ${service}:\n    image: ${serviceImage(service)}\n    labels:\n      parkbench.managed: "true"\n      parkbench.run_id: "${runId}"\n      parkbench.experiment_id: "${experimentId}"\n      parkbench.component: "${service}"\n    networks:${privateNetwork}${metricsNetwork}${hostMetricsPort}${environment}${resources}${cpuSetLine}${memoryLines}${volumes}`;
}

function escapeYaml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isPasReplica(service: string): boolean {
  return /^pas-\d+$/.test(service);
}

function volumeBlock(mounts: string): string {
  return mounts ? `\n    volumes:${mounts}` : "";
}

function localMount(reference: string | undefined, target: string, mode = "ro"): string {
  return reference && !reference.startsWith("input:")
    ? `\n      - "${escapeYaml(path.resolve(reference))}:${target}:${mode}"`
    : "";
}

/** The read-only database files of a seed directory. */
function toLocalPath(reference: string | undefined): string | undefined {
  return reference && !reference.startsWith("input:") ? path.resolve(reference) : reference;
}

function credentialEnvironmentKey(reference: string | undefined): string | undefined {
  if (!reference?.startsWith("credential:")) return undefined;
  const identifier = reference.slice("credential:".length);
  return `PARKBENCH_CREDENTIAL_${identifier.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function composeEnvironmentReference(key: string): string {
  return "${" + key + "}";
}

function mapRuntimePath(executable: string, runtimeRoot?: string): string {
  if (!runtimeRoot || executable.startsWith("input:")) return executable;
  const normalizedRoot = runtimeRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedExecutable = executable.replaceAll("\\", "/");
  if (normalizedExecutable === normalizedRoot) return "/opt/openedge";
  if (normalizedExecutable.startsWith(`${normalizedRoot}/`))
    return `/opt/openedge/${normalizedExecutable.slice(normalizedRoot.length + 1)}`;
  return executable;
}

function isPackagedObserverProcedure(procedure: string | undefined): boolean {
  return (
    procedure === "/app/openedge/observers/db/parkbench-db-observer.p" ||
    procedure === "/app/openedge/observers/db/parkbench-db-observer.r" ||
    procedure === "/app/openedge/observers/db/parkbench-db-observer-v2.p" ||
    procedure === "/app/openedge/observers/db/parkbench-db-observer-v2.r" ||
    procedure === "/app/openedge/observers/db/prepare-run-db-observer.p"
  );
}
