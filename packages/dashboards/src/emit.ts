import { DashboardDefinition, DATASOURCE_UIDS, DatasourceKind, Panel } from "./model";
import { unitFor } from "./units";

const HALF = 12;
const FULL = 24;
const HEIGHT = 8;
/** Grafana "Connect null values" threshold, in milliseconds (1m). */
export const SPAN_NULLS_MS = false;

function datasourceRef(kind: DatasourceKind) {
  return { type: "prometheus", uid: DATASOURCE_UIDS[kind] };
}

function fieldDefaults(panel: Panel) {
  const convention = unitFor(panel.category);
  const defaults: Record<string, unknown> = {
    unit: panel.unit ?? convention.unit,
    noValue: "No data"
  };
  if (convention.min !== undefined) defaults.min = convention.min;
  if (convention.max !== undefined) defaults.max = convention.max;
  if (panel.visual === "timeseries")
    defaults.custom = {
      drawStyle: "line",
      lineWidth: 1,
      fillOpacity: 10,
      // Preserve missing observations as visible gaps.
      spanNulls: SPAN_NULLS_MS,
      insertNulls: false,
      showPoints: "never",
      axisLabel: convention.axisLabel ?? ""
    };
  return defaults;
}

function describe(panel: Panel): string | undefined {
  const parts = [panel.description, panel.note].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Converts one builder panel to Grafana panel JSON. */
export function emitPanel(
  panel: Panel,
  datasource: DatasourceKind,
  gridPos: { x: number; y: number; w: number; h: number },
  numericId: number
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: numericId,
    title: panel.title,
    description: describe(panel),
    ...(panel.links ? { links: panel.links } : {}),
    datasource: datasourceRef(datasource),
    gridPos,
    parkbench: {
      panelId: panel.id,
      category: panel.category,
      split: panel.split,
      breakdown: panel.breakdown,
      ...(panel.topN ? { topN: panel.topN } : {}),
      ...(panel.legacy ? { legacy: panel.legacy } : {})
    }
  };
  const targets = panel.targets.map((target, index) => ({
    refId: String.fromCharCode(65 + index),
    datasource: datasourceRef(target.datasource ?? datasource),
    expr: target.expr,
    legendFormat: target.legendFormat,
    range: !target.instant,
    instant: Boolean(target.instant),
    ...(target.instant ? { format: target.format ?? "time_series" } : {})
  }));
  switch (panel.visual) {
    case "text":
      return { ...base, type: "text", options: { mode: "markdown", content: panel.content ?? "" } };
    case "table":
      return {
        ...base,
        type: "table",
        fieldConfig: { defaults: fieldDefaults(panel), overrides: panel.fieldOverrides ?? [] },
        options: panel.options ?? { showHeader: true },
        transformations: panel.transformations ?? [],
        targets: targets.map((t) => ({ ...t, format: "table", instant: true, range: false }))
      };
    case "stat":
      return {
        ...base,
        type: "stat",
        fieldConfig: { defaults: fieldDefaults(panel), overrides: panel.fieldOverrides ?? [] },
        options: panel.options ?? {
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          textMode: "value_and_name"
        },
        targets
      };
    case "state_timeline":
      return {
        ...base,
        type: "state-timeline",
        fieldConfig: {
          defaults: {
            ...fieldDefaults(panel),
            mappings: [
              {
                type: "value",
                options: { "0": { text: "Unavailable" }, "1": { text: "Available" } }
              }
            ]
          },
          overrides: panel.fieldOverrides ?? []
        },
        options: { mergeValues: true, showValue: "auto", spanNulls: false },
        targets
      };

    case "timeseries":
      return {
        ...base,
        type: "timeseries",
        fieldConfig: { defaults: fieldDefaults(panel), overrides: panel.overrides ?? [] },
        options: {
          legend: {
            displayMode: "table",
            placement: "right",
            calcs: ["mean", "max"],
            sortBy: "Mean",
            sortDesc: true
          },
          tooltip: { mode: "multi", sort: "desc" }
        },
        targets
      };
    case "bar_totals":
      return {
        ...base,
        type: "bargauge",
        fieldConfig: { defaults: fieldDefaults(panel), overrides: [] },
        options: {
          orientation: "horizontal",
          displayMode: "basic",
          showUnfilled: true,
          valueMode: "text",
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }
        },
        targets
      };
    case "notice":
      return {
        ...base,
        type: "stat",
        fieldConfig: {
          defaults: {
            unit: "none",
            noValue: "No notices",
            mappings: [{ type: "value", options: { "1": { text: panel.note ?? "notice" } } }],
            color: { mode: "fixed", fixedColor: "orange" }
          },
          overrides: []
        },
        options: {
          textMode: "value_and_name",
          colorMode: "background",
          graphMode: "none",
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }
        },
        targets: targets.map((target) => ({ ...target, range: false, instant: true }))
      };
    case "run_picker":
      return {
        ...base,
        datasource: datasourceRef("parkbench_runs"),
        type: "table",
        fieldConfig: {
          defaults: { unit: "none", noValue: "No runs in range" },
          overrides: [
            {
              matcher: { id: "byName", options: "Started" },
              properties: [{ id: "unit", value: "dateTimeAsIso" }]
            },
            {
              matcher: { id: "byName", options: "run_id" },
              properties: [
                {
                  id: "links",
                  value: [
                    {
                      title: "Show this run's time range",
                      url: "/d/${__dashboard.uid}?var-picker_run=${__data.fields.run_id}&from=${__data.fields.start_ms}&to=${__data.fields.end_ms}"
                    }
                  ]
                }
              ]
            },
            {
              matcher: { id: "byRegexp", options: "^(start_ms|end_ms)$" },
              properties: [{ id: "custom.hidden", value: true }]
            }
          ]
        },
        options: { showHeader: true, cellHeight: "sm" },
        targets: targets.map((target) => ({
          ...target,
          range: false,
          instant: true,
          format: "table"
        })),
        transformations: [
          { id: "merge", options: {} },
          {
            id: "convertFieldType",
            options: {
              conversions: [
                { targetField: "Value", destinationType: "number" },
                { targetField: "start_ms", destinationType: "number" },
                { targetField: "end_ms", destinationType: "number" }
              ]
            }
          },
          {
            id: "organize",
            options: {
              excludeByName: { Time: true, __name__: true },
              renameByName: { Value: "Started" }
            }
          },
          { id: "sortBy", options: { sort: [{ field: "Started", desc: true }] } }
        ]
      };
  }
}

/** Lays out rows and panels into the Grafana dashboard panel list. */
export function emitPanels(definition: DashboardDefinition): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  let y = 0;
  let id = 1;
  for (const row of definition.rows) {
    const rowPanel: Record<string, unknown> = {
      id: id++,
      type: "row",
      title: row.name,
      collapsed: row.collapsed,
      gridPos: { x: 0, y, w: FULL, h: 1 },
      panels: [] as unknown[]
    };
    y += 1;
    const children: Record<string, unknown>[] = [];
    const height = row.panels.every((panel) => panel.id.startsWith("notice.")) ? 2 : HEIGHT;
    let x = 0;
    for (const panel of row.panels) {
      const width = panel.fullWidth ? FULL : HALF;
      if (x + width > FULL) {
        x = 0;
        y += height;
      }
      children.push(emitPanel(panel, definition.datasource, { x, y, w: width, h: height }, id++));
      x += width;
      if (x >= FULL) {
        x = 0;
        y += height;
      }
    }
    if (x > 0) y += height;
    if (row.collapsed) {
      rowPanel.panels = children;
      output.push(rowPanel);
    } else {
      output.push(rowPanel, ...children);
    }
  }
  return output;
}
