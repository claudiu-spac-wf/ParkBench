import { Scenario } from "../../../../packages/contracts/src/scenario";
import { validateScenario } from "../../../../packages/contracts/src/validator";
export class ScenarioCatalog {
  private readonly scenarios = new Map<string, Scenario>();
  register(input: unknown): Scenario {
    const scenario = validateScenario(input);
    const key = `${scenario.id}@${scenario.version}`;
    if (this.scenarios.has(key)) throw new Error("scenario_version_already_registered");
    this.scenarios.set(key, structuredClone(scenario));
    return scenario;
  }
  get(id: string, version: string): Scenario | undefined {
    const value = this.scenarios.get(`${id}@${version}`);
    return value ? structuredClone(value) : undefined;
  }
  list(filters: { id?: string; status?: string } = {}): Scenario[] {
    return [...this.scenarios.values()]
      .filter((scenario) => !filters.id || scenario.id === filters.id)
      .filter((scenario) => !filters.status || filters.status === "available")
      .map((scenario) => structuredClone(scenario));
  }
}
