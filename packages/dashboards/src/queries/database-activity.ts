import { tableRankExpression, tableTopN } from "./run-summary";
import { nativeDiagnosticExpression, diagnosticPanels } from "./diagnostic";
export function databaseActivityPanels() {
  const panels = diagnosticPanels(
    "parkbench-database-activity",
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 17, 18, 19, 20, 21]
  );
  const tables = panels.find((p) => p.legacy?.panelId === 7)!;
  tables.visual = "table";
  tables.title = "Full table CRUD operation detail";
  tables.targets[0].expr = nativeDiagnosticExpression("table_operations_total","rate",{table:"$table",operation:"read|create|update|delete"});
  tables.targets[0].instant = true;
  tables.targets[0].format = "table";
  tables.targets.push({
    expr: nativeDiagnosticExpression("table_operations_total","rate",{table:"$table",operation:"os_read"}),
    legendFormat: "{{run_id}} {{table}} {{operation}}",
    instant: true,
    format: "table"
  });
  for (const operation of ["read", "write", "create", "update", "delete", "os_read"])
    panels.unshift({
      id: `activity.table_${operation}`,
      title: `Table ${operation} activity`,
      description:
        "Diagnostic activity over the displayed range. Ten fixed names and complementary display Other; the full detail table contains every name.",
      category: "table_rate",
      split: "none",
      breakdown: "table",
      visual: "timeseries",
      topN: tableTopN,
      targets: [
        { expr: tableRankExpression(operation, "rate"), legendFormat: "{{run_id}} {{table}}" }
      ]
    });
  return panels;
}
