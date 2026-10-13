import { ALLOWED_PARAMETERS } from "./allowed-parameters";
import { isDatabaseRunControl, validateDatabaseRunControl } from "./database-run-controls";
import {
  databaseParameterDefinition,
  databaseParameterOptions,
  validateDatabaseParameterValue,
  databaseParameterInput,
  validateDatabaseParameterConfiguration,
  DATABASE_PARAMETER_REGISTRY_VERSION
} from "./database-parameter-options";
import type { DatabaseStartupParameters, DatabaseParameterSource } from "./database-startup";
import {
  DatabaseParameterDefinition,
  MatrixCell,
  MatrixDimension,
  MatrixPreviewRequest,
  ParameterDependencyOperator,
  ParameterDependencyRule,
  stableJson
} from "./control-ui";

const DEPENDENCY_OPERATORS = new Set<ParameterDependencyOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
  "gt",
  "gte",
  "lt",
  "lte"
]);

const BROKER_NAMES = databaseParameterOptions().parameters.map((item) => item.name);
export function canonicalParameterValues(
  values: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [raw, value] of Object.entries(values)) {
    const name = databaseParameterDefinition(raw)?.name ?? raw;
    if (Object.hasOwn(result, name)) throw new Error(`database_parameter_duplicate:${name}`);
    result[name] = value;
  }
  return result;
}

export function resolveDatabaseStartup(
  source: {
    startupFile: DatabaseStartupParameters["startupFile"];
    entries: Array<{ name: string; value: string; line: number; sourceFile?: string }>;
    /** The selected seed's database name. */
    databaseName?: string;
    expandedParameterFiles?: string[];
  },
  scenarioValues: Record<string, string | number | boolean>,
  queuedValues: Record<string, string | number | boolean>,
  secondQueuedAssignment: Record<string, string | number | boolean> = {}
): DatabaseStartupParameters {
  scenarioValues = canonicalParameterValues(scenarioValues);
  queuedValues = canonicalParameterValues(queuedValues);
  secondQueuedAssignment = canonicalParameterValues(secondQueuedAssignment);
  const file = new Map<string, { value: string; line: number; sourceFile?: string }>();
  for (const entry of source.entries) file.set(entry.name, entry);
  const queued = { ...secondQueuedAssignment, ...queuedValues };
  for (const [name, value] of Object.entries(secondQueuedAssignment))
    if (queuedValues[name] !== undefined && queuedValues[name] !== value)
      throw new Error(`database_parameter_invalid:${name}:duplicate_queued_assignment`);
  const parameters: DatabaseStartupParameters["parameters"] = [];
  for (const name of BROKER_NAMES) {
    const candidates: Array<{
      source: DatabaseParameterSource;
      value: unknown;
      reference: string;
    }> = [];
    if (queued[name] !== undefined)
      candidates.push({ source: "queued", value: queued[name], reference: "matrix_cell" });
    if (scenarioValues[name] !== undefined)
      candidates.push({
        source: "scenario",
        value: scenarioValues[name],
        reference: "scenario_default"
      });
    const fileEntry = file.get(name);
    const fileName =
      source.startupFile.status === "present" ? source.startupFile.relativePath : "startup.pf";
    if (fileEntry)
      candidates.push({
        source: "startup_file",
        value: fileEntry.value,
        reference: `${fileEntry.sourceFile ?? fileName}:${fileEntry.line}`
      });
    if (!candidates.length) continue;
    const winner = candidates[0];
    const displayValue = String(winner.value);
    try {
      validateDatabaseParameterValue(name, databaseParameterInput(name, displayValue));
    } catch {
      throw new Error(`database_parameter_invalid:${name}`);
    }
    parameters.push({
      name,
      displayValue,
      source: winner.source,
      overrides: candidates.slice(1).map((candidate) => candidate.source),
      sourceReference: winner.reference,
      applicability: "database_broker",
      verification: "pending"
    });
  }
  for (const key of [...Object.keys(scenarioValues), ...Object.keys(queued)])
    if (key.startsWith("-") && !BROKER_NAMES.includes(key))
      throw new Error(`database_parameter_invalid:${key}`);
  validateDatabaseParameterConfiguration(
    Object.fromEntries(
      parameters.map((p) => [p.name, databaseParameterInput(p.name, p.displayValue)])
    )
  );
  return {
    contractVersion: "db-startup-parameters.v1",
    registryVersion: DATABASE_PARAMETER_REGISTRY_VERSION,
    databaseName: source.databaseName ?? "parkbench",
    startupFile: source.startupFile,
    parameters,
    ...(source.expandedParameterFiles
      ? { expandedParameterFiles: source.expandedParameterFiles }
      : {})
  };
}

export function normalizeMatrixParameterNames(request: MatrixPreviewRequest): MatrixPreviewRequest {
  return {
    ...request,
    fixedOverrides: canonicalParameterValues(request.fixedOverrides ?? {}),
    dimensions: request.dimensions.map((d) => ({
      ...d,
      name: databaseParameterDefinition(d.name)?.name ?? d.name
    }))
  };
}

export function canonicalMatrixRequest(request: MatrixPreviewRequest): string {
  return stableJson({
    runName: normalizeRunName(request.runName),
    scenario: request.scenario,
    dimensions: request.dimensions,
    repetitions: request.repetitions,
    fixedOverrides: request.fixedOverrides ?? {},
    inputs: request.inputs ?? {}
  });
}

export function validateMatrixRequest(
  request: MatrixPreviewRequest,
  definitions: DatabaseParameterDefinition[]
): void {
  request = normalizeMatrixParameterNames(request);
  normalizeRunName(request.runName);
  if (!Number.isInteger(request.repetitions) || request.repetitions < 1)
    throw new Error("repetitions_must_be_positive");
  validateDependencyRules(definitions);
  const known = new Map(definitions.map((definition) => [definition.canonicalName, definition]));
  const used = new Set<string>();
  for (const dimension of request.dimensions) {
    const definition = known.get(dimension.name);
    if (!definition || !definition.matrixAllowed)
      throw new Error(`matrix_parameter_not_allowed:${dimension.name}`);
    if (used.has(dimension.name)) throw new Error(`duplicate_matrix_dimension:${dimension.name}`);
    used.add(dimension.name);
    if (!dimension.values.length) throw new Error(`matrix_values_required:${dimension.name}`);
    const serialized = new Set(dimension.values.map((value) => stableJson(value)));
    if (serialized.size !== dimension.values.length)
      throw new Error(`duplicate_matrix_value:${dimension.name}`);
    for (const value of dimension.values) validateParameterValue(definition, value);
    if (Object.prototype.hasOwnProperty.call(request.fixedOverrides ?? {}, dimension.name))
      throw new Error(`matrix_override_conflict:${dimension.name}`);
  }
  for (const [name, value] of Object.entries(request.fixedOverrides ?? {})) {
    const definition = known.get(name);
    if (!definition) throw new Error(`unknown_parameter:${name}`);
    if (used.has(name)) throw new Error(`matrix_override_conflict:${name}`);
    validateParameterValue(definition, value);
  }
}

export function normalizeRunName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("run_name_required");
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (normalized.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized))
    throw new Error("run_name_invalid");
  return normalized;
}

export function expandMatrix(
  request: MatrixPreviewRequest,
  definitions: DatabaseParameterDefinition[]
): MatrixCell[] {
  request = normalizeMatrixParameterNames(request);
  validateMatrixRequest(request, definitions);
  const definitionsByName = new Map(
    definitions.map((definition) => [definition.canonicalName, definition])
  );
  const combinations: Array<Record<string, string | number | boolean>> = [{}];
  for (const dimension of request.dimensions) {
    const next: Array<Record<string, string | number | boolean>> = [];
    for (const combination of combinations)
      for (const value of dimension.values) next.push({ ...combination, [dimension.name]: value });
    combinations.splice(0, combinations.length, ...next);
  }
  return combinations.flatMap((values, ordinal) => {
    const effectiveConfiguration = {
      ...Object.fromEntries(
        definitions
          .map((definition) => [definition.canonicalName, definition.defaultValue])
          .filter(([, value]) => value !== undefined)
      ),
      ...(request.fixedOverrides ?? {}),
      ...values
    } as Record<string, string | number | boolean>;
    for (const [name, value] of Object.entries(effectiveConfiguration)) {
      const definition = definitionsByName.get(name);
      if (definition) validateParameterValue(definition, value);
    }
    validateParameterConfiguration(definitions, effectiveConfiguration);
    return Array.from({ length: request.repetitions }, (_, index) => ({
      ordinal,
      values,
      repetition: index + 1,
      effectiveConfiguration
    }));
  });
}

export function validateDependencyRules(definitions: DatabaseParameterDefinition[]): void {
  const known = new Map(definitions.map((definition) => [definition.canonicalName, definition]));
  for (const definition of definitions) {
    const seen = new Set<string>();
    for (const dependency of definition.dependencies ?? []) {
      if (!dependency || typeof dependency !== "object" || Array.isArray(dependency))
        throw new Error(`dependency_rule_invalid:${definition.canonicalName}`);
      const keys = Object.keys(dependency as unknown as Record<string, unknown>).sort();
      if (keys.join(",") !== "operator,parameter,value")
        throw new Error(`dependency_rule_shape_invalid:${definition.canonicalName}`);
      const rule = dependency as ParameterDependencyRule;
      if (!rule.parameter || rule.parameter === definition.canonicalName)
        throw new Error(`dependency_parameter_invalid:${definition.canonicalName}`);
      const referenced = known.get(rule.parameter);
      if (!referenced) throw new Error(`dependency_parameter_unknown:${definition.canonicalName}`);
      if (!DEPENDENCY_OPERATORS.has(rule.operator))
        throw new Error(`dependency_operator_invalid:${definition.canonicalName}`);
      const signature = stableJson(rule);
      if (seen.has(signature))
        throw new Error(`dependency_rule_duplicate:${definition.canonicalName}`);
      seen.add(signature);
      const values = Array.isArray(rule.value) ? rule.value : [rule.value];
      if (!values.length || (Array.isArray(rule.value) && !["in", "notIn"].includes(rule.operator)))
        throw new Error(`dependency_value_invalid:${definition.canonicalName}`);
      if (!["in", "notIn"].includes(rule.operator) && values.length !== 1)
        throw new Error(`dependency_value_invalid:${definition.canonicalName}`);
      if (["gt", "gte", "lt", "lte"].includes(rule.operator)) {
        if (!(
          ["integer", "number"].includes(referenced.type) &&
          values.every((value) => typeof value === "number" && Number.isFinite(value))
        ))
          throw new Error(`dependency_value_type_invalid:${definition.canonicalName}`);
      } else {
        for (const value of values) {
          try {
            validateParameterValue(referenced, value);
          } catch {
            throw new Error(`dependency_value_type_invalid:${definition.canonicalName}`);
          }
        }
      }
    }
  }
}

export function validateParameterConfiguration(
  definitions: DatabaseParameterDefinition[],
  values: Record<string, string | number | boolean>
): void {
  validateDependencyRules(definitions);
  const known = new Map(definitions.map((definition) => [definition.canonicalName, definition]));
  for (const definition of definitions) {
    if (values[definition.canonicalName] === undefined) continue;
    for (const dependency of definition.dependencies ?? []) {
      const actual = values[dependency.parameter];
      if (actual === undefined || !dependencySatisfied(dependency, actual))
        throw new Error(
          `dependency_not_satisfied:${definition.canonicalName}:${dependency.parameter}`
        );
    }
  }
  for (const [name, value] of Object.entries(values)) {
    const definition = known.get(name);
    if (!definition) throw new Error(`unknown_parameter:${name}`);
    validateParameterValue(definition, value);
  }
}

function dependencySatisfied(
  rule: ParameterDependencyRule,
  actual: string | number | boolean
): boolean {
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  switch (rule.operator) {
    case "eq":
      return stableJson(actual) === stableJson(values[0]);
    case "neq":
      return stableJson(actual) !== stableJson(values[0]);
    case "in":
      return values.some((value) => stableJson(actual) === stableJson(value));
    case "notIn":
      return values.every((value) => stableJson(actual) !== stableJson(value));
    case "gt":
      return typeof actual === "number" && actual > (values[0] as number);
    case "gte":
      return typeof actual === "number" && actual >= (values[0] as number);
    case "lt":
      return typeof actual === "number" && actual < (values[0] as number);
    case "lte":
      return typeof actual === "number" && actual <= (values[0] as number);
  }
}

export function validateParameterValue(
  definition: DatabaseParameterDefinition,
  value: unknown
): asserts value is string | number | boolean {
  if (isDatabaseRunControl(definition.canonicalName))
    validateDatabaseRunControl(definition.canonicalName, value);
  const typeMatches =
    (definition.type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (definition.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    ((definition.type === "string" || definition.type === "enum") && typeof value === "string") ||
    (definition.type === "boolean" && typeof value === "boolean");
  if (!typeMatches) throw new Error(`invalid_parameter_type:${definition.canonicalName}`);
  if (typeof value === "number") {
    if (definition.minimum !== undefined && value < definition.minimum)
      throw new Error(`parameter_below_minimum:${definition.canonicalName}`);
    if (definition.maximum !== undefined && value > definition.maximum)
      throw new Error(`parameter_above_maximum:${definition.canonicalName}`);
    if (definition.step !== undefined) {
      const units = (value - (definition.minimum ?? 0)) / definition.step;
      if (Math.abs(units - Math.round(units)) > Number.EPSILON * Math.max(1, Math.abs(units)) * 8)
        throw new Error(`parameter_step_invalid:${definition.canonicalName}`);
    }
  }
  if (
    definition.allowedValues &&
    !definition.allowedValues.some(
      (allowed) =>
        stableJson(allowed) === stableJson(value) ||
        (definition.source === "database-parameter-options.v2" &&
          databaseParameterDefinition(definition.canonicalName)?.enumCase === "insensitive" &&
          typeof allowed === "string" &&
          typeof value === "string" &&
          allowed.toLowerCase() === value.toLowerCase())
    )
  )
    throw new Error(`parameter_value_not_allowed:${definition.canonicalName}`);
}
