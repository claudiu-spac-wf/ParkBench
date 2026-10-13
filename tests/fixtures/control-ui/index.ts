import scenario from "../../../examples/scenarios/crud-rest.json";
export { createControlUiFixture } from "./server";

/** A fresh copy of the standard scenario fixture for tests that customize it. */
export function createScenarioFixture(): typeof scenario {
  return structuredClone(scenario);
}
