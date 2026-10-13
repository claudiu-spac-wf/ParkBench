export type Direction = "Read" | "Write" | "In" | "Out";

/**
 * Legend format `[{run} · ]{entity} · {direction}`. The run prefix is always part of the
 * format on run-scoped dashboards; with one selected run it is the same for every series,
 * which keeps the naming rule a pure function of the dashboard.
 */
export function legend(options: {
  runPrefix: boolean;
  entity?: string;
  direction?: Direction;
}): string {
  const parts: string[] = [];
  if (options.runPrefix) parts.push("{{run_id}}");
  if (options.entity) parts.push(options.entity);
  if (options.direction) parts.push(options.direction);
  return parts.join(" · ") || "{{__name__}}";
}
