import { Variant } from "./experiment";
import { ALLOWED_PARAMETERS } from "./allowed-parameters";
import { databaseParameterDefinition, validateDatabaseParameterValue } from "./database-parameter-options";
import { isDatabaseRunControl, validateDatabaseRunControl } from "./database-run-controls";
export { ALLOWED_PARAMETERS } from "./allowed-parameters";
export function validateVariant(variant: Variant): void {
  for (const [key, value] of Object.entries(variant.parameters)) {
    if (isDatabaseRunControl(key)) {
      validateDatabaseRunControl(key, value);
      continue;
    }
    if (databaseParameterDefinition(key)) {
      validateDatabaseParameterValue(key, value);
      continue;
    }
    const definition = ALLOWED_PARAMETERS[key];
    if (!definition) throw new Error(`unknown_parameter:${key}`);
    if (
      typeof value !== definition.type ||
      (typeof value === "number" &&
        ((definition.min !== undefined && value < definition.min) ||
          (definition.max !== undefined && value > definition.max)))
    )
      throw new Error(`invalid_parameter:${key}`);
  }
}
