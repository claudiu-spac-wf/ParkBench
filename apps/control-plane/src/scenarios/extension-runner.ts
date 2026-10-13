import { Scenario } from "../../../../packages/contracts/src/scenario";
import {
  assertScenarioCompatible,
  validateScenario
} from "../../../../packages/contracts/src/validator";
export function runExtensionScenario(scenario: Scenario) {
  const validated = validateScenario(scenario);
  assertScenarioCompatible(validated);
  return {
    scenarioId: validated.id,
    version: validated.version,
    lifecycle: "unchanged",
    lifecycleStages: ["preflight", "provision", "ready", "observe", "finalize", "cleanup"],
    accepted: true
  };
}
