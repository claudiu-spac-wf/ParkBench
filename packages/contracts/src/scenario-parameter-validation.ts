import { DatabaseParameterDefinition } from "./control-ui";
import {
  validateDependencyRules,
  validateParameterConfiguration,
  validateParameterValue
} from "./matrix-expansion";
import { ValidationError } from "./errors";
import {
  databaseParameterOptions,
  validateScheduledDatabaseParameter
} from "./database-parameter-options";
import {
  DATABASE_RUN_CONTROL_DEFINITIONS,
  isDatabaseRunControl,
  validateDatabaseRunControl
} from "./database-run-controls";
export function validateParameterDefinitions(definitions: DatabaseParameterDefinition[]): void {
  const names = new Set<string>();
  for (const [index, definition] of definitions.entries()) {
    if (names.has(definition.canonicalName))
      throw new ValidationError(
        [
          {
            path: `/parameterDefinitions/${index}/canonicalName`,
            code: "duplicate_parameter",
            message: definition.canonicalName
          }
        ],
        `duplicate_parameter:${definition.canonicalName}`
      );
    names.add(definition.canonicalName);
    if (!["integer", "number", "string", "boolean", "enum"].includes(definition.type))
      throw new ValidationError(
        [{ path: `/parameterDefinitions/${index}/type`, code: "parameter_type_invalid" }],
        `parameter_type_invalid:${definition.canonicalName}`
      );
    if (definition.secret !== false)
      throw new ValidationError(
        [
          {
            path: `/parameterDefinitions/${index}/secret`,
            code: "secret_parameter_not_ui_editable"
          }
        ],
        `secret_parameter_not_ui_editable:${definition.canonicalName}`
      );
    if (!definition.description || !definition.source || !definition.definitionVersion)
      throw new ValidationError(
        [{ path: `/parameterDefinitions/${index}`, code: "parameter_definition_incomplete" }],
        `parameter_definition_incomplete:${definition.canonicalName}`
      );
    if (
      definition.minimum !== undefined &&
      definition.maximum !== undefined &&
      definition.minimum > definition.maximum
    )
      throw new ValidationError(
        [{ path: `/parameterDefinitions/${index}`, code: "parameter_range_invalid" }],
        `parameter_range_invalid:${definition.canonicalName}`
      );
    if (
      definition.step !== undefined &&
      (!Number.isFinite(definition.step) || definition.step <= 0)
    )
      throw new ValidationError(
        [{ path: `/parameterDefinitions/${index}/step`, code: "parameter_step_invalid" }],
        `parameter_step_invalid:${definition.canonicalName}`
      );
    if (definition.allowedValues) {
      const serialized = new Set(definition.allowedValues.map((value) => JSON.stringify(value)));
      if (serialized.size !== definition.allowedValues.length)
        throw new ValidationError(
          [
            {
              path: `/parameterDefinitions/${index}/allowedValues`,
              code: "allowed_values_duplicate"
            }
          ],
          `allowed_values_duplicate:${definition.canonicalName}`
        );
    }
    if (definition.defaultValue !== undefined) {
      try {
        validateParameterValue(definition, definition.defaultValue);
      } catch (error) {
        throw new ValidationError(
          [
            {
              path: `/parameterDefinitions/${index}/defaultValue`,
              code: String(error).replace(/^Error: /, ""),
              message: "The default value does not satisfy the parameter definition."
            }
          ],
          String(error).replace(/^Error: /, "")
        );
      }
    }
  }
  try {
    validateDependencyRules(definitions);
  } catch (error) {
    const message = String(error).replace(/^Error: /, "");
    const canonicalName = message.split(":").pop() ?? "";
    const index = definitions.findIndex((definition) => definition.canonicalName === canonicalName);
    throw new ValidationError(
      [
        {
          path: `/parameterDefinitions/${Math.max(index, 0)}/dependencies`,
          code: "dependency_rules_invalid",
          message
        }
      ],
      message
    );
  }
}

export function validateScenarioDatabaseParameterDefinitions(
  definitions: DatabaseParameterDefinition[],
  config: { version?: string; features?: readonly string[] }
): void {
  validateParameterDefinitions(definitions);
  const capabilities = databaseParameterOptions(config);
  const choices = new Map(capabilities.parameters.map((option) => [option.name, option]));
  for (const definition of definitions) {
    if (isDatabaseRunControl(definition.canonicalName)) {
      const native = DATABASE_RUN_CONTROL_DEFINITIONS.find(
        (d) => d.canonicalName === definition.canonicalName
      )!;
      if (
        definition.type !== native.type ||
        (definition.minimum !== undefined && definition.minimum < (native.minimum ?? -Infinity)) ||
        (definition.maximum !== undefined && definition.maximum > (native.maximum ?? Infinity)) ||
        (definition.step !== undefined &&
          native.step !== undefined &&
          (!Number.isInteger(definition.step / native.step) || definition.step < native.step))
      )
        throw new Error(`database_parameter_definition_widened:${definition.canonicalName}`);
      if (definition.defaultValue !== undefined)
        validateDatabaseRunControl(definition.canonicalName, definition.defaultValue);
      for (const value of definition.allowedValues ?? [])
        validateDatabaseRunControl(definition.canonicalName, value);
      continue;
    }
    const option = choices.get(definition.canonicalName);
    if (!option) throw new Error(`database_parameter_not_allowed:${definition.canonicalName}`);
    if (!option.available)
      throw new Error(
        `database_parameter_unavailable:${definition.canonicalName}:${option.reason}`
      );
    const expectedType =
      option.kind === "flag" ? "boolean" : option.kind === "decimal" ? "number" : option.kind;
    if (
      definition.type !== expectedType ||
      (definition.minimum !== undefined &&
        definition.minimum <
          (option.allowedValues?.includes(0) ? 0 : (option.minimum ?? -Infinity))) ||
      (definition.maximum !== undefined && definition.maximum > (option.maximum ?? Infinity)) ||
      (definition.step !== undefined &&
        option.increment !== undefined &&
        (!Number.isInteger(definition.step / option.increment) ||
          definition.step < option.increment)) ||
      (definition.allowedValues &&
        definition.allowedValues.some((value) => {
          try {
            validateScheduledDatabaseParameter(definition.canonicalName, value, capabilities);
            return false;
          } catch {
            return true;
          }
        }))
    )
      throw new Error(`database_parameter_definition_widened:${definition.canonicalName}`);
    if (definition.defaultValue !== undefined)
      validateScheduledDatabaseParameter(
        definition.canonicalName,
        definition.defaultValue,
        capabilities
      );
  }
}

export function validateScenarioParameterValues(
  definitions: DatabaseParameterDefinition[],
  values: Record<string, string | number | boolean>,
  config: { version?: string; features?: readonly string[] }
): void {
  validateScenarioDatabaseParameterDefinitions(definitions, config);
  const names = new Set(definitions.map((d) => d.canonicalName));
  validateParameterConfiguration(
    definitions,
    Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name)))
  );
}
