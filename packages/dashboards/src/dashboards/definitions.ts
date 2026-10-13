import { activityDashboard } from "./database-activity";
import { recoveryDashboard } from "./database-recovery";
import { concurrencyDashboard } from "./database-concurrency";
import { parametersDashboard } from "./database-parameters";
import { pasDashboard } from "./pas-instances";
import { workloadPanels } from "../queries/workload";
import {
  DASHBOARD_TITLES,
  DASHBOARD_UIDS,
  DashboardDefinition,
  Panel,
  RESOURCE_ROWS,
  Row,
  Scope
} from "../model";
import { containerPanels } from "../queries/container";
import { hostPanels } from "../queries/host";
import { runSummaryRows } from "../queries/run-summary";

export const MODE_MISMATCH_NOTE =
  "The time range doesn't match the selected runs. Use Reset range to selected runs.";
export const EXCLUDED_RUN_NOTE = "Excluded from aligned charts: no measurement phase";

export function noticePanels(): Panel[] {
  return [
    {
      id: "notice.mode_mismatch",
      title: "Time range notice",
      category: "requests",
      split: "none",
      breakdown: "none",
      visual: "text",
      targets: [],
      content: "${notice_time_range:text}"
    },
    {
      id: "notice.excluded_runs",
      title: "Excluded runs",
      category: "requests",
      split: "none",
      breakdown: "none",
      visual: "text",
      targets: [],
      content: "${notice_excluded_runs:text}"
    }
  ];
}

function runPickerPanel(): Panel {
  return {
    id: "picker.runs",
    title: "Runs",
    description:
      "Runs that overlap the selected time range. Click a run to set the time range to its span and show its phase markers. The data is not filtered by run.",
    category: "requests",
    split: "none",
    breakdown: "none",
    visual: "run_picker",
    fullWidth: true,
    targets: [
      {
        expr: 'parkbench_run_window{window_start="$__from",window_end="$__to"}',
        legendFormat: "{{run_id}}",
        instant: true,
        datasource: "parkbench_runs"
      }
    ]
  };
}

export function resourceRows(scope: Scope): Row[] {
  const panels = scope === "host" ? hostPanels() : containerPanels(scope);
  const byRow: Record<string, Panel[]> = {
    Summary: panels.summary,
    CPU: panels.cpu,
    Memory: panels.memory,
    Disk: panels.disk,
    Network: panels.network
  };
  return RESOURCE_ROWS.map((name) => ({
    name,
    collapsed: name !== "Summary",
    panels: byRow[name]
  }));
}

type Key = keyof typeof DASHBOARD_UIDS;

function resource(
  key: "host" | "platform" | "db" | "run",
  scope: Scope,
  retires: string[] = []
): DashboardDefinition {
  const runScoped = scope === "db" || scope === "run";
  const rows = resourceRows(scope);
  if (runScoped) rows.unshift({ name: "Notices", collapsed: false, panels: noticePanels() });
  else rows.unshift({ name: "Runs", collapsed: false, panels: [runPickerPanel()] });
  return {
    uid: DASHBOARD_UIDS[key],
    title: DASHBOARD_TITLES[key],
    kind: "resource",
    scope,
    datasource: runScoped ? "parkbench_runs" : "prometheus",
    runSelection: runScoped ? "multi" : "picker_time_only",
    rows,
    retires,
    tags: ["parkbench", "resources", scope]
  };
}

function runSummary(): DashboardDefinition {
  const rows = runSummaryRows();
  return {
    uid: DASHBOARD_UIDS.summary,
    title: DASHBOARD_TITLES.summary,
    kind: "run_summary",
    datasource: "parkbench_runs",
    runSelection: "multi",
    rows: [
      { name: "Notices", collapsed: false, panels: noticePanels() },
      { name: "DB and PAS resources", collapsed: false, panels: rows.resources },
      {
        name: "DB disk",
        collapsed: false,
        panels: rows.disk.map((panel) => ({ ...panel, fullWidth: true }))
      },
      { name: "DB tables and indexes", collapsed: false, panels: rows.tables },
      { name: "PAS", collapsed: false, panels: rows.pas },
      { name: "Workload and diagnostics", collapsed: true, panels: workloadPanels() }
    ],
    retires: [],
    filters: ["phase"],
    tags: ["parkbench", "run-summary"]
  };
}

/** All five dashboards, keyed as in DASHBOARD_UIDS. */
export function dashboardDefinitions(): Record<Key, DashboardDefinition> {
  return {
    host: resource("host", "host"),
    platform: resource("platform", "platform"),
    db: resource("db", "db", ["parkbench-database-resources"]),
    run: resource("run", "run"),
    summary: runSummary(),
    activity: activityDashboard(),
    recovery: recoveryDashboard(),
    concurrency: concurrencyDashboard(),
    parameters: parametersDashboard(),
    pas: pasDashboard()
  };
}

/** Rows that carry the Summary/CPU/Memory/Disk/Network layout (excludes Notices/Runs). */
export function layoutRows(definition: DashboardDefinition): Row[] {
  return definition.rows.filter((row) => (RESOURCE_ROWS as readonly string[]).includes(row.name));
}
