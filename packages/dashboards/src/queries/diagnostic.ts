import catalog from "../../../contracts/src/openedge-db-metric-catalog.json";
import source from "../dashboards/diagnostic-source.json";
import { Panel, Target } from "../model";
/** Catalog descriptors keep publisher copies out of arithmetic. */
export function nativeDiagnosticExpression(
  metric: string,
  view: "gauge" | "rate" | "total" | "cumulative",
  filters: Record<string, string | { value: string; operator: "=" | "=~" }> = {},
  group?: "name_type"
) {
  const labels = [
    `run_id=~"$run_id"`,
    `metric=${JSON.stringify(metric)}`,
    `view=${JSON.stringify(view)}`,
    `phase="$phase"`,
    `window_start="$__from"`,
    `window_end="$__to"`,
    ...(group ? [`group=${JSON.stringify(group)}`] : []),
    ...(view === "rate" ? [`rate_window_ms="60000"`] : [])
  ];
  for (const [name, value] of Object.entries(filters))
    labels.push(
      `${name}${typeof value === "string" ? "=~" : value.operator}${JSON.stringify(typeof value === "string" ? value : value.value)}`
    );
  return `parkbench_db_diagnostic{${labels.join(",")}}`;
}
function canonicalExpression(expression: string): string {
  const name = /parkbench_openedge_db_([a-z_]+)/.exec(expression)?.[1];
  const definition = catalog.entries.find((e) => e.name === name);
  if (!definition) return expression;
  const filters: Record<string, string> = {};
  for (const dimension of definition.dimensions) {
    const matcher = new RegExp(`${dimension}(=~|=|!=)"([^"]*)"`).exec(expression);
    if (matcher) filters[dimension] = matcher[1] === "!=" && matcher[2] === "" ? ".+" : matcher[2];
  }
  if (name === "buffer_pool_free_buffers")
    return nativeDiagnosticExpression("free_capacity", "gauge", filters);
  if (name === "buffer_pool_cumulative_cache_hit_ratio")
    return nativeDiagnosticExpression("cumulative_hit_ratio", "cumulative", filters);
  return nativeDiagnosticExpression(
    name!,
    definition.type === "counter" ? (expression.includes("increase(") ? "total" : "rate") : "gauge",
    filters
  );
}
/** Explicit operator retirement: these high-cardinality availability timelines froze browsers. */
export const RETIRED_AVAILABILITY_PANELS = [
  { uid: "parkbench-benchmark-overview", panelId: 5 },
  { uid: "parkbench-database-activity", panelId: 6 },
  { uid: "parkbench-database-activity", panelId: 9 },
  { uid: "parkbench-database-recovery-concurrency", panelId: 54 }
] as const;
export function isRetiredAvailabilityPanel(uid: string, panelId: number): boolean {
  return RETIRED_AVAILABILITY_PANELS.some(
    (panel) => panel.uid === uid && panel.panelId === panelId
  );
}
export function diagnosticPanels(uid: string, ids?: number[]): Panel[] {
  return source
    .filter(
      (p) =>
        p.uid === uid &&
        (!ids || ids.includes(p.panelId)) &&
        !isRetiredAvailabilityPanel(p.uid, p.panelId)
    )
    .map((p) => {
      const targets: Target[] = p.targets.flatMap((target: any) => {
        // Signals with the same unit remain separate named targets rather than being added.
        const expressions = target.expr.split(" + ");
        return expressions.map((expr: string, index: number) => {
          expr = expr
            .replace(/experiment_id=~"\$experiment_id",?/g, "")
            .replace(
              /sum by\s*\(([^)]+)\)/g,
              (_: string, labels: string) =>
                `sum by (${labels.includes("run_id") ? labels : `run_id, ${labels}`})`
            );
          if (expr.includes("histogram_quantile"))
            expr = expr.replace("(le, operation)", "(le, run_id, operation)");
          let legend = target.legendFormat ?? "";
          if (!legend.includes("{{run_id}}")) legend = `{{run_id}} ${legend}`;
          if (expressions.length > 1) {
            const metric = /(?:rate\()?([a-z][a-z_]+)\{/.exec(expr)?.[1] ?? `signal ${index + 1}`;
            legend = `{{run_id}} ${metric.replace("parkbench_openedge_db_", "").replace("container_", "")} {{pool}} {{service}}`;
          }
          expr = canonicalExpression(expr);
          return { ...target, expr, legendFormat: legend };
        });
      });
      const availability = p.title.includes("availability") || p.title.includes("enabled");
      const visual =
        p.type === "text"
          ? "text"
          : p.type === "table"
            ? "table"
            : p.type === "stat"
              ? "stat"
              : availability
                ? "state_timeline"
                : "timeseries";
      return {
        id: `legacy.${p.uid.replace("parkbench-", "")}.${p.panelId}`,
        title: p.title,
        ...(targets.some((t) => t.expr.includes('metric="latch_'))
          ? {
              links: [
                {
                  title: "Named latch breakdown",
                  url: "/d/parkbench-database-concurrency?${__all_variables}&${__url_time_range}",
                  targetBlank: false
                }
              ]
            }
          : {}),
        description:
          p.description?.replace(
            "an unavailable measurement is visible in the availability panel.",
            "collection status remains available in the saved run summary."
          ) ??
          "Diagnostic readings over the visible range; rate windows may overlap phase boundaries.",
        category: p.unit === "s" ? "duration" : "count",
        split: "none",
        breakdown: "none",
        visual,
        unit: p.unit ?? "none",
        targets,
        transformations: p.transformations,
        fieldOverrides: p.overrides,
        options: p.options as Record<string, unknown>,
        content: (p.options as any).content,
        legacy: { uid: p.uid, panelId: p.panelId }
      };
    });
}
