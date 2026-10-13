import type { DatabaseParameterDefinition } from "./control-ui";

export type ScenarioSchemaVersion = "scenario.v1" | "scenario.v2";
export type ObserverKind = string;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ScenarioOperation {
  id: string;
  method: HttpMethod;
  path: string;
  weight: number;
  bodyTemplate?: unknown;
  /** Per-request random values substituted for `{{name}}` placeholders in bodyTemplate strings. */
  templateValues?: Record<string, ScenarioTemplateValue>;
  expectedStatus?: number[];
}
export interface ScenarioTemplateValue {
  kind: "uniformInt";
  min: number;
  max: number;
}
export interface ObserverDeclaration {
  id: string;
  kind: ObserverKind;
  required: boolean;
  samplingIntervalSeconds: number;
  /** Accepted only for scenario.v1 files; never filters observer output. */
  metrics?: string[];
  configuration?: Record<string, unknown>;
}
export interface ScenarioAssetRefs {
  workload?: string;
  databaseImage?: string;
  pasImage?: string;
  observers?: string[];
}
export type RequiredMeasurementSource = "observer" | "workload" | "database" | "pas";
export interface RequiredMeasurementDefinition {
  id: string;
  metricName: string;
  source: RequiredMeasurementSource;
  observerId?: string;
  phases?: Array<"warmup" | "measurement" | "cooldown">;
  description?: string;
}
export interface Scenario {
  schemaVersion: ScenarioSchemaVersion;
  id: string;
  version: string;
  name: string;
  description?: string;
  assetRefs?: ScenarioAssetRefs;
  target: {
    restPath: string;
    pasProtocol?: "http" | "https";
    pasPort?: number;
    databaseService: string;
    pasService: string;
    pasReplicas: number;
    healthPath?: string;
    timeoutMs?: number;
  };
  workload: {
    operations: ScenarioOperation[];
    load: {
      mode: "constant-concurrency";
      concurrency: number;
      maxInFlightPerWorker?: number;
      seed?: number;
    };
  };
  phases: { warmupSeconds: number; measurementSeconds: number; cooldownSeconds: number };
  observers: ObserverDeclaration[];
  requiredMeasurements?: RequiredMeasurementDefinition[];
  /** Optional scenario defaults and narrower bounds for database broker parameters. */
  parameterDefinitions?: DatabaseParameterDefinition[];
}
export interface ScenarioRef {
  id: string;
  version: string;
}

const TEMPLATE_PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]{0,31})\}\}/g;

/** Names of the `{{name}}` placeholders found in any string inside a body template. */
export function templatePlaceholders(bodyTemplate: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string")
      for (const match of value.matchAll(TEMPLATE_PLACEHOLDER)) names.add(match[1]);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(bodyTemplate);
  return names;
}

/** Placeholders and templateValues declarations must match one to one, with ordered bounds. */
export function validateOperationTemplateValues(
  operation: Pick<ScenarioOperation, "id" | "bodyTemplate" | "templateValues">
): void {
  const declared = operation.templateValues ?? {};
  for (const [name, value] of Object.entries(declared))
    if (!Number.isInteger(value?.min) || !Number.isInteger(value?.max) || value.min > value.max)
      throw new Error(`scenario_template_value_bounds:${operation.id}:${name}`);
  const used = templatePlaceholders(operation.bodyTemplate);
  for (const name of used)
    if (!Object.prototype.hasOwnProperty.call(declared, name))
      throw new Error(`scenario_template_value_undeclared:${operation.id}:${name}`);
  for (const name of Object.keys(declared))
    if (!used.has(name)) throw new Error(`scenario_template_value_unused:${operation.id}:${name}`);
}
