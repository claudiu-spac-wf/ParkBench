import { Variant, validateVariant } from "../../contracts/src";
import { validateBrokerParameter } from "./startup-file";
import {
  databaseParameterTokens,
  DATABASE_PARAMETER_REGISTRY_VERSION,
  validateDatabaseParameterConfiguration,
  validateDatabaseParameterPaths
} from "../../contracts/src/database-parameter-options";
import {
  legacyDatabaseParameterDefinition,
  validateLegacyDatabaseParameterValue
} from "../../contracts/src/database-parameter-options-v1";
import { DATABASE_NAME_PATTERN } from "../../contracts/src/seed";
import {
  DatabaseRunControls,
  resolveDatabaseRunControls,
  legacyDatabaseRunControls,
  validateDatabaseRunControls
} from "../../contracts/src/database-run-controls";
export const PARAMETER_ADAPTER_VERSION = "parameters.v2" as const;
export interface ParameterPlan {
  contractVersion: typeof PARAMETER_ADAPTER_VERSION;
  databaseStartupArgs: string[];
  databaseParameterRegistryVersion?: string;
  databaseEnvironment: Record<string, string>;
  pasEnvironment: Record<string, string>;
  resourceLimits: { database?: number; pas?: number };
  databaseMetricsEnabled: boolean;
  workloadSeed?: number;
  /** One-way delay in ms added in each direction between PAS replicas and the database. */
  databaseLatencyMs: number;
  databaseRunControls: DatabaseRunControls;
}

export function applyParameters(
  base: Record<string, unknown>,
  variant: Variant
): Record<string, unknown> {
  validateVariant(variant);
  return { ...base, ...variant.parameters };
}

/** Translate validated factors into the runtime contract consumed by images. */
export function parameterPlan(
  parameters: Record<string, unknown>,
  options: {
    rejectNetworkBrokerReadOnly?: boolean;
    /** The selected seed's database name; non-OpenEdge scenarios use the default. */
    databaseName?: string;
    databaseRunControls?: DatabaseRunControls;
    legacyDatabaseParameters?: boolean;
  } = {}
): ParameterPlan {
  const databaseName = options.databaseName ?? "parkbench";
  if (!DATABASE_NAME_PATTERN.test(databaseName)) throw new Error("database_name_invalid");
  const workloadSeed = parameters["workload.seed"];
  if (
    workloadSeed !== undefined &&
    (typeof workloadSeed !== "number" ||
      !Number.isInteger(workloadSeed) ||
      workloadSeed < 0 ||
      workloadSeed > 4294967295)
  )
    throw new Error("invalid_parameter:workload.seed");
  const plan: ParameterPlan = {
    contractVersion: PARAMETER_ADAPTER_VERSION,
    databaseStartupArgs: [],
    databaseParameterRegistryVersion: options.legacyDatabaseParameters
      ? undefined
      : DATABASE_PARAMETER_REGISTRY_VERSION,
    databaseEnvironment: {
      DB_NAME: databaseName,
      DB_BROKER_PORT: "20931",
      DB_MINPORT: "20932",
      DB_MAXPORT: "20941",
      PARKBENCH_DATABASE_READ_ONLY: "false"
    },
    pasEnvironment: {
      PAS_INSTANCE_NAME: "oepas1",
      PASOE_HTTP_PORT: "8810",
      PARKBENCH_PAS_PROTOCOL: "http",
      PARKBENCH_PAS_DB_CONNECTION: `-db ${databaseName} -H database -S 20931`,
      PARKBENCH_PAS_COLLECT_METRICS: "3"
    },
    resourceLimits: {},
    databaseMetricsEnabled: true,
    databaseLatencyMs: 0,
    databaseRunControls: options.databaseRunControls
      ? validateDatabaseRunControls(options.databaseRunControls)
      : resolveDatabaseRunControls({}, parameters)
  };
  const controls = plan.databaseRunControls;
  for (const [key, expected] of Object.entries({
    "database.apwCount": controls.apwCount,
    "database.biwEnabled": controls.biwEnabled,
    "database.biClusterSizeMiB":
      controls.biCluster.mode === "override" ? controls.biCluster.requestedMiB : undefined
  }))
    if (parameters[key] !== undefined && parameters[key] !== expected)
      throw new Error(`database_run_control_invalid:${key}:snapshot_parameter_conflict`);
  plan.databaseEnvironment = controlsEnvironment(plan.databaseEnvironment, controls);
  if (parameters["database.readOnly"] === true && options.rejectNetworkBrokerReadOnly !== false)
    throw new Error("network_broker_read_only_not_supported");
  const numeric = (key: string): number | undefined =>
    typeof parameters[key] === "number" ? Number(parameters[key]) : undefined;
  if (!options.legacyDatabaseParameters) {
    validateDatabaseParameterConfiguration(parameters);
    validateDatabaseParameterPaths(parameters, databaseName);
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (key.startsWith("-")) {
      if (options.legacyDatabaseParameters) {
        validateLegacyDatabaseParameterValue(key, value);
        const p = legacyDatabaseParameterDefinition(key)!;
        if (p.kind === "flag") {
          if (value === true) plan.databaseStartupArgs.push(key);
        } else plan.databaseStartupArgs.push(key, String(value));
      } else {
        try {
          validateBrokerParameter(key, String(value));
          plan.databaseStartupArgs.push(...databaseParameterTokens(key, value));
        } catch (e) {
          throw new Error(`database_parameter_invalid:${key}:${(e as Error).message}`);
        }
      }
      continue;
    }
    switch (key) {
      case "pas.maxThreads":
        plan.pasEnvironment.PARKBENCH_PAS_MAX_THREADS = String(value);
        break;
      case "database.readOnly":
        plan.databaseEnvironment.PARKBENCH_DATABASE_READ_ONLY = String(value);
        break;
      case "database.metricsEnabled":
        plan.databaseMetricsEnabled = value as boolean;
        break;
      case "workload.seed":
        plan.workloadSeed = value as number;
        break;
      case "database.cpuLimit":
        plan.resourceLimits.database = numeric(key);
        break;
      case "pas.cpuLimit":
        plan.resourceLimits.pas = numeric(key);
        break;
      case "network.databaseLatencyMs":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000)
          throw new Error("invalid_parameter:network.databaseLatencyMs");
        plan.databaseLatencyMs = value;
        break;
      default:
        // Effective snapshots also carry scenario metadata; only allowlisted
        // runtime factors are translated into service configuration.
        break;
    }
  }
  if (plan.databaseStartupArgs.length)
    plan.databaseEnvironment.PARKBENCH_OPENEDGE_DB_STARTUP_ARGS = JSON.stringify(
      plan.databaseStartupArgs
    );
  return plan;
}

export function readParameterPlan(
  input:
    | ParameterPlan
    | (Omit<ParameterPlan, "contractVersion" | "databaseRunControls"> & {
        contractVersion: "parameters.v1";
      })
): ParameterPlan {
  if (input.contractVersion === "parameters.v2") {
    if (
      input.databaseParameterRegistryVersion &&
      input.databaseParameterRegistryVersion !== DATABASE_PARAMETER_REGISTRY_VERSION
    )
      throw new Error("database_parameter_registry_unsupported");
    const result = structuredClone(input);
    validateDatabaseRunControls(result.databaseRunControls);
    result.databaseEnvironment = controlsEnvironment(
      result.databaseEnvironment,
      result.databaseRunControls
    );
    return result;
  }
  if (input.contractVersion !== "parameters.v1")
    throw new Error("parameter_adapter_version_unsupported");
  const databaseRunControls = legacyDatabaseRunControls();
  return {
    ...structuredClone(input),
    contractVersion: PARAMETER_ADAPTER_VERSION,
    databaseRunControls,
    databaseEnvironment: controlsEnvironment(input.databaseEnvironment, databaseRunControls)
  };
}

function controlsEnvironment(
  original: Record<string, string>,
  controls: DatabaseRunControls
): Record<string, string> {
  const result = {
    ...original,
    PARKBENCH_APW_COUNT: String(controls.apwCount),
    PARKBENCH_BIW_ENABLED: String(controls.biwEnabled),
    PARKBENCH_BI_CLUSTER_MODE: controls.biCluster.mode,
    PARKBENCH_DATABASE_RUN_CONTROLS: JSON.stringify(controls)
  };
  delete (result as Record<string, string>).PARKBENCH_BI_CLUSTER_KIB;
  if (controls.biCluster.mode === "override")
    (result as Record<string, string>).PARKBENCH_BI_CLUSTER_KIB = String(
      controls.biCluster.nativeKiB
    );
  return result;
}
