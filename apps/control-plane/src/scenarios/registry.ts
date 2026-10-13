import { ScenarioCatalog } from "./catalog";
export class ScenarioRegistry {
  constructor(private readonly catalog: ScenarioCatalog) {}
  discover(): string[] {
    return this.catalog.list().map((scenario) => `${scenario.id}@${scenario.version}`);
  }
  register(document: unknown) {
    return this.catalog.register(document);
  }
}
