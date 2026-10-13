import type { DatabaseParameterDefinition } from "./control-ui";

/** One-way delay added in each direction between every PAS replica and the database. */
export const DATABASE_LATENCY_PARAMETER = "network.databaseLatencyMs";

/**
 * Platform run parameters that are not database broker settings. They are offered next to the
 * broker parameters as fixed overrides and matrix dimensions, and land in the run's effective
 * configuration like any other parameter.
 */
export const PLATFORM_RUN_PARAMETER_DEFINITIONS: DatabaseParameterDefinition[] = [
  {
    id: "param_network_databaseLatencyMs",
    canonicalName: DATABASE_LATENCY_PARAMETER,
    type: "integer",
    minimum: 0,
    maximum: 1000,
    step: 1,
    unit: "ms",
    defaultValue: 0,
    description:
      "One-way network delay added in each direction between every PAS instance and the database (round trip grows by about twice this value).",
    source: "platform-run-parameters.v1",
    matrixAllowed: true,
    secret: false,
    definitionVersion: "1"
  }
];

/** The run's Database Latency in milliseconds; runs recorded before the parameter existed are 0. */
export function databaseLatencyOf(configuration: Record<string, unknown> | undefined): number {
  const value = configuration?.[DATABASE_LATENCY_PARAMETER];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}
