import type { ScenarioOperation } from "../../../packages/contracts/src/scenario";
import { DataFactory } from "./data-factory";

/**
 * Replaces `{{name}}` placeholders in every string of a body template with one seeded whole
 * number per declared name, drawn from the worker's factory in ascending name order. Templates
 * without declarations are returned unchanged and consume no draws.
 */
export function renderTemplateValues(
  template: unknown,
  declarations: ScenarioOperation["templateValues"],
  factory: DataFactory
): unknown {
  const names = Object.keys(declarations ?? {}).sort();
  if (!names.length) return template;
  const values = new Map<string, string>();
  for (const name of names) {
    const { min, max } = declarations![name];
    values.set(name, String(min + Math.floor(factory.next() * (max - min + 1))));
  }
  const render = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(
        /\{\{([A-Za-z][A-Za-z0-9]{0,31})\}\}/g,
        (placeholder, name) => values.get(name) ?? placeholder
      );
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
    return value;
  };
  return render(template);
}
