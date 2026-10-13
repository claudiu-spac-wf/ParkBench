import { Scenario, validateOperationTemplateValues } from "./scenario";
import { ValidationError } from "./errors";
import Ajv from "ajv/dist/2020";
import { loadScenarioSchema } from "./schema-loader";
export function validateScenario(input: unknown): Scenario {
  const value = structuredClone(input) as any;
  const version = value?.schemaVersion;
  if (version !== "scenario.v1" && version !== "scenario.v2")
    throw new ValidationError([{ path: "/schemaVersion", code: "unsupported" }]);
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  const valid = ajv.validate(loadScenarioSchema(version), value);
  if (!valid)
    throw new ValidationError(formatAjvErrors(ajv.errors ?? []), "The scenario cannot be used.");
  const operations = (value as any).workload.operations as Scenario["workload"]["operations"];
  const ids = new Set<string>();
  operations.forEach((operation, index) => {
    if (ids.has(operation.id))
      throw new ValidationError(
        [
          {
            path: `/workload/operations/${index}/id`,
            code: "uniqueItems",
            message: "must be unique"
          }
        ],
        "The scenario cannot be used."
      );
    ids.add(operation.id);
    try {
      validateOperationTemplateValues(operation);
    } catch (error) {
      const code = (error as Error).message;
      throw new ValidationError(
        [{ path: `/workload/operations/${index}/templateValues`, code }],
        code
      );
    }
  });
  const measurements = (value as Scenario).requiredMeasurements ?? [];
  const measurementIds = new Set<string>();
  const observerIds = new Set<string>();
  (value as Scenario).observers.forEach((observer, index) => {
    if (observerIds.has(observer.id))
      throw new ValidationError(
        [{ path: `/observers/${index}/id`, code: "uniqueItems" }],
        "The scenario cannot use the same observer ID twice."
      );
    observerIds.add(observer.id);
  });
  const observers = new Map(
    (value as Scenario).observers.map((observer) => [observer.id, observer])
  );
  measurements.forEach((measurement, index) => {
    if (measurementIds.has(measurement.id))
      throw new ValidationError(
        [
          {
            path: `/requiredMeasurements/${index}/id`,
            code: "uniqueItems",
            message: "must be unique"
          }
        ],
        "The scenario cannot be used."
      );
    measurementIds.add(measurement.id);
    if (measurement.source === "observer") {
      if (!measurement.observerId)
        throw new ValidationError(
          [{ path: `/requiredMeasurements/${index}/observerId`, code: "required" }],
          "Observer measurements require an observer reference."
        );
      const observer = observers.get(measurement.observerId);
      if (!observer)
        throw new ValidationError(
          [{ path: `/requiredMeasurements/${index}/observerId`, code: "reference_not_found" }],
          "The required measurement references an unknown observer."
        );
    } else if (measurement.observerId) {
      throw new ValidationError(
        [{ path: `/requiredMeasurements/${index}/observerId`, code: "observer_not_allowed" }],
        "Only observer measurements may reference an observer."
      );
    }
  });
  return value as Scenario;
}
export function formatAjvErrors(
  errors: Array<{
    instancePath?: string;
    keyword: string;
    message?: string;
    params?: Record<string, unknown>;
  }>
): Array<{ path: string; code: string; message?: string }> {
  return errors.map((error) => ({
    path: errorPath(error),
    code: error.keyword,
    message: error.message
  }));
}

function errorPath(error: {
  instancePath?: string;
  keyword: string;
  params?: Record<string, unknown>;
}): string {
  const base = error.instancePath || "/";
  const property = error.params?.missingProperty ?? error.params?.additionalProperty;
  return typeof property === "string" ? `${base === "/" ? "" : base}/${property}` : base;
}
export function assertScenarioCompatible(scenario: Scenario): void {
  if (scenario.schemaVersion !== "scenario.v1" && scenario.schemaVersion !== "scenario.v2")
    throw new ValidationError([{ path: "/schemaVersion", code: "unsupported" }]);
}
