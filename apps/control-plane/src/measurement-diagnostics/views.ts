import { dashboardDefinitions } from "../../../../packages/dashboards/src/dashboards/definitions";
import { emitPanels } from "../../../../packages/dashboards/src/emit";
import { scanSelectors } from "../grafana/promql-selectors";
import type { MetricDefinition } from "../../../../packages/contracts/src/metric-definitions";
import type { MeasurementConsumingView } from "../../../../packages/contracts/src/measurement-diagnostics";
export interface MeasurementPanelReference {
  dashboardUid: string;
  panelId: string;
  title: string;
  sourceMetricNames: string[];
  resourceGroups: string[];
  targetCount: number;
}
/** Uses the production generator's numeric IDs, including collapsed rows. */
export function measurementPanelInventory(): MeasurementPanelReference[] {
  const result: MeasurementPanelReference[] = [];
  for (const definition of Object.values(dashboardDefinitions())) {
    const visit = (panels: any[]) => {
      for (const panel of panels) {
        if (panel.type === "row") {
          visit(panel.panels ?? []);
          continue;
        }
        const sourceMetricNames = new Set<string>(),
          groups = new Set<string>();
        for (const target of panel.targets ?? []) {
          for (const selector of scanSelectors(target.expr ?? "")) {
            if (selector.metric) sourceMetricNames.add(selector.metric);
            const labels = new Map(selector.matchers.map((m) => [m.name, m.value]));
            if (selector.metric === "parkbench_db_diagnostic") {
              const metric = labels.get("metric");
              const source =
                metric === "free_capacity"
                  ? ["buffer_pool_configured_buffers", "buffer_pool_active_buffers"]
                  : metric === "cumulative_hit_ratio"
                    ? ["buffer_pool_logical_reads_total", "buffer_pool_os_reads_total"]
                    : metric
                      ? [metric]
                      : [];
              for (const name of source) sourceMetricNames.add(`parkbench_openedge_db_${name}`);
            }
            if (selector.metric === "parkbench_table_rank")
              sourceMetricNames.add("parkbench_openedge_db_table_operations_total");
            if (labels.get("container_label_com_docker_compose_project") === "parkbench-platform")
              groups.add("platform");
            if (labels.get("service") === "database") groups.add("database");
            if (
              labels.get("service")?.startsWith("pas-") ||
              selector.matchers.some(
                (m) => m.name === "service" && m.op === "!=" && m.value === "database"
              )
            )
              groups.add("pas");
          }
        }
        if (sourceMetricNames.size)
          result.push({
            dashboardUid: definition.uid,
            panelId: String(panel.id),
            title: panel.title,
            sourceMetricNames: [...sourceMetricNames].sort(),
            resourceGroups: [...groups].sort(),
            targetCount: panel.targets?.length ?? 0
          });
      }
    };
    visit(emitPanels(definition));
  }
  return result;
}
export function consumingViews(
  definition: MetricDefinition,
  panels: MeasurementPanelReference[]
): MeasurementConsumingView[] {
  return [
    ...(definition.supportedStatistics.length
      ? [
          {
            consumer: "SUMMARY" as const,
            definitionRef: `${definition.definitionId}:${definition.group}`
          },
          {
            consumer: "COMPARISON" as const,
            definitionRef: `${definition.definitionId}:${definition.group}`
          }
        ]
      : []),
    ...panels
      .filter(
        (panel) =>
          definition.sourceMetricNames.some((name) => panel.sourceMetricNames.includes(name)) &&
          (definition.coverageScope !== "resource" ||
            panel.resourceGroups.includes(definition.group))
      )
      .map((panel) => ({
        consumer: "GRAFANA" as const,
        dashboardUid: panel.dashboardUid,
        panelId: panel.panelId
      }))
  ];
}
