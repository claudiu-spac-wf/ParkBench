import { diagnosticPanels } from "./diagnostic";
export function parametersPanels() {
  const panels = diagnosticPanels("parkbench-database-parameters");
  for (const panel of panels) {
    if (panel.legacy?.panelId === 4) {
      panel.content =
        "Startup snapshots preserve plaintext values, unknown statuses and their actual UTC capture time. Empty is distinct from default settings. These tables use the retained primary snapshot independently of the visible measurement range or phase. Run context and parameter artifacts remain available from Run History.";
      continue;
    }
    const kind =
      panel.legacy?.panelId === 1 ? "info" : panel.legacy?.panelId === 2 ? "status" : "numeric";
    panel.targets = [
      {
        expr: `parkbench_parameter_snapshot_${kind}{run_id=~"$run_id"}`,
        legendFormat: "{{run_id}} {{parameter}} {{state}}",
        instant: true,
        format: "table"
      }
    ];
    if (kind === "info")
      panel.fieldOverrides = [
        {
          matcher: { id: "byName", options: "Captured at (UTC)" },
          properties: [{ id: "unit", value: "dateTimeAsIso" }]
        }
      ];
    panel.transformations = [
      { id: "labelsToFields", options: { mode: "columns" } },
      {
        id: "organize",
        options: {
          excludeByName: { Time: true, __name__: true },
          renameByName: {
            Value:
              kind === "info"
                ? "Captured at (UTC)"
                : kind === "numeric"
                  ? "Numeric value"
                  : "Status",
            display_value: "Value",
            value_status: "Value status",
            parameter: "Parameter",
            run_id: "Run",
            database_name: "Database"
          }
        }
      }
    ];
  }
  return panels;
}
