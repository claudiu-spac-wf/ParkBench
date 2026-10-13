import { DatabaseParameterDefinition } from "../../../../packages/contracts/src";
import { validateScenarioConfiguration } from "./scenario-validation";

export function resolveEffectiveConfiguration(
  definitions: DatabaseParameterDefinition[],
  overrides: Record<string, string | number | boolean> = {}
): { values: Record<string, string | number | boolean> } {
  const values = {
    ...Object.fromEntries(
      definitions
        .map((definition) => [definition.canonicalName, definition.defaultValue])
        .filter(([, value]) => value !== undefined)
    ),
    ...overrides
  } as Record<string, string | number | boolean>;
  validateScenarioConfiguration({ parameterDefinitions: definitions } as any, values);
  return {
    values
  };
}
