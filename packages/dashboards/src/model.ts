/** Builder input model for the generated ParkBench dashboards (grafana-dashboards-v2). */

export type Scope = "host" | "platform" | "db" | "run";

export type DatasourceKind = "prometheus" | "parkbench_runs";

export type RunSelection = "picker_time_only" | "multi";

export type PanelCategory =
  | "cpu_pct"
  | "cpu_host_pct"
  | "cpu_seconds"
  | "memory"
  | "disk_throughput"
  | "disk_iops"
  | "net_throughput"
  | "net_packets"
  | "table_rate"
  | "table_total"
  | "requests"
  | "duration"
  | "count"
  | "ratio"
  | "event_rate"
  | "duration_rate"
  | "state";

export type Split = "read_write" | "in_out" | "none";

export type Breakdown = "none" | "core" | "disk" | "interface" | "container" | "table" | "replica";

export type Visual =
  | "timeseries"
  | "bar_totals"
  | "notice"
  | "run_picker"
  | "table"
  | "text"
  | "stat"
  | "state_timeline";

export type RowName = "Summary" | "CPU" | "Memory" | "Disk" | "Network";

export const RESOURCE_ROWS: readonly RowName[] = ["Summary", "CPU", "Memory", "Disk", "Network"];

export interface TopN {
  n: number;
  /** Label the ranking partitions by; always the run label. */
  partitionBy: "run_id";
  /** Label that identifies a ranked entry (for example `table` or `service`). */
  key: string;
  otherLabel: "Other";
  tieBreak: "allowlist_ordinal" | "value_then_name";
  excludeZero: true;
}

export interface Target {
  expr: string;
  legendFormat: string;
  instant?: boolean;
  format?: "table" | "time_series";
  datasource?: DatasourceKind;
}

export interface Panel {
  id: string;
  title: string;
  description?: string;
  links?: Array<{ title: string; url: string; targetBlank?: boolean }>;
  category: PanelCategory;
  split: Split;
  breakdown: Breakdown;
  topN?: TopN;
  visual: Visual;
  targets: Target[];
  fullWidth?: boolean;
  /** Extra Grafana field overrides (for example a dashed limit line). */
  overrides?: unknown[];
  /** Fixed note shown in the panel description, for example the p95 fallback. */
  note?: string;
  unit?: string;
  transformations?: unknown[];
  options?: Record<string, unknown>;
  fieldOverrides?: unknown[];
  content?: string;
  /** Original reviewed semantic identity, used by the coverage ledger. */
  legacy?: { uid: string; panelId: number };
}

export interface Row {
  name: string;
  collapsed: boolean;
  panels: Panel[];
}

export interface DashboardDefinition {
  uid: string;
  title: string;
  kind: "resource" | "run_summary" | "diagnostic" | "snapshot";
  scope?: Scope;
  datasource: DatasourceKind;
  runSelection: RunSelection;
  rows: Row[];
  retires: string[];
  tags: string[];
  filters?: Array<"phase" | "table" | "index" | "replica">;
}

export const DATASOURCE_UIDS: Record<DatasourceKind, string> = {
  prometheus: "prometheus",
  parkbench_runs: "parkbench-runs"
};

export const DASHBOARD_UIDS = {
  host: "parkbench-host-resources",
  platform: "parkbench-platform-resources",
  run: "parkbench-run-resources",
  summary: "parkbench-run-summary",
  db: "parkbench-db-resources",
  activity: "parkbench-database-activity",
  recovery: "parkbench-database-recovery-concurrency",
  concurrency: "parkbench-database-concurrency",
  parameters: "parkbench-database-parameters",
  pas: "parkbench-pas-instances"
} as const;
export type DashboardKey = keyof typeof DASHBOARD_UIDS;
export type DashboardFolder = "Resources" | "Database" | "PAS";
export interface DashboardCatalogEntry {
  key: DashboardKey;
  uid: string;
  title: string;
  folder: DashboardFolder;
  file: string;
  runSelection: RunSelection;
}
export const DASHBOARD_CATALOG: readonly DashboardCatalogEntry[] = [
  {
    key: "host",
    uid: DASHBOARD_UIDS.host,
    title: "Host Resources",
    folder: "Resources",
    file: "host-resources.json",
    runSelection: "picker_time_only"
  },
  {
    key: "platform",
    uid: DASHBOARD_UIDS.platform,
    title: "Platform Resources",
    folder: "Resources",
    file: "platform-resources.json",
    runSelection: "picker_time_only"
  },
  {
    key: "run",
    uid: DASHBOARD_UIDS.run,
    title: "Run Resources",
    folder: "Resources",
    file: "run-resources.json",
    runSelection: "multi"
  },
  {
    key: "summary",
    uid: DASHBOARD_UIDS.summary,
    title: "Run Summary",
    folder: "Resources",
    file: "run-summary.json",
    runSelection: "multi"
  },
  {
    key: "db",
    uid: DASHBOARD_UIDS.db,
    title: "DB Resources",
    folder: "Database",
    file: "db-resources.json",
    runSelection: "multi"
  },
  {
    key: "activity",
    uid: DASHBOARD_UIDS.activity,
    title: "Database Activity",
    folder: "Database",
    file: "database-activity.json",
    runSelection: "multi"
  },
  {
    key: "recovery",
    uid: DASHBOARD_UIDS.recovery,
    title: "Database BI & APW data",
    folder: "Database",
    file: "database-recovery.json",
    runSelection: "multi"
  },
  {
    key: "concurrency",
    uid: DASHBOARD_UIDS.concurrency,
    title: "Database transactions, locks, and latches",
    folder: "Database",
    file: "database-concurrency.json",
    runSelection: "multi"
  },
  {
    key: "parameters",
    uid: DASHBOARD_UIDS.parameters,
    title: "Database Parameters",
    folder: "Database",
    file: "database-parameters.json",
    runSelection: "multi"
  },
  {
    key: "pas",
    uid: DASHBOARD_UIDS.pas,
    title: "PAS Instances",
    folder: "PAS",
    file: "pas-instances.json",
    runSelection: "multi"
  }
];
export const DASHBOARD_TITLES = Object.fromEntries(
  DASHBOARD_CATALOG.map((e) => [e.key, e.title])
) as Record<DashboardKey, string>;
export const RETIRED_DASHBOARD_UIDS: Record<string, string> = {
  "parkbench-database-resources": DASHBOARD_UIDS.db,
  "parkbench-benchmark-overview": DASHBOARD_UIDS.summary,
  "parkbench-overview": DASHBOARD_UIDS.summary
};
export function resolveDashboardUid(uid: string): string {
  return RETIRED_DASHBOARD_UIDS[uid] ?? uid;
}
export function validateDashboardCatalog(): void {
  if (DASHBOARD_CATALOG.length !== 10 || new Set(DASHBOARD_CATALOG.map((e) => e.uid)).size !== 10)
    throw new Error("dashboard_catalog_invalid");
  for (const folder of ["Resources", "Database", "PAS"] as const)
    if (
      DASHBOARD_CATALOG.filter((e) => e.folder === folder).length !==
      { Resources: 4, Database: 5, PAS: 1 }[folder]
    )
      throw new Error("dashboard_folder_invalid");
  if (DASHBOARD_CATALOG.some((e) => /^ParkBench[ :]/i.test(e.title)))
    throw new Error("dashboard_title_invalid");
}

/** Fixed anchor used as "measurement start = 0" on the aligned elapsed-time axis. */
export const ALIGNED_ANCHOR_MS = Date.UTC(2000, 0, 1);
