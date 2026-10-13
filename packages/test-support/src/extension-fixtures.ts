import { Scenario } from "../../contracts/src/scenario";
export function extensionFixture(scenario: Scenario) {
  return {
    scenario,
    observerKind: "core",
    runAssociation: { component: "observer", service: "example", phase: "measurement" }
  };
}
