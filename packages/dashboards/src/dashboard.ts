import { emitPanels } from "./emit";
import {
  DISK_EXCLUDE,
  DISK_EXCLUDE_VAR,
  INTERFACE_EXCLUDE,
  INTERFACE_EXCLUDE_VAR
} from "./filters";
import { DEFAULT_WEB_URL, linkBar, WEB_URL_VAR } from "./links";
import { DASHBOARD_UIDS, DashboardDefinition, DATASOURCE_UIDS } from "./model";

type DashboardKey = keyof typeof DASHBOARD_UIDS;

function constant(name: string, value: string) {
  return {
    type: "constant",
    name,
    hide: 2,
    query: value,
    current: { text: value, value },
    options: [{ text: value, value, selected: true }],
    skipUrlSync: true
  };
}

function runVariable() {
  return {
    type: "query",
    name: "run_id",
    label: "Runs",
    datasource: { type: "prometheus", uid: DATASOURCE_UIDS.parkbench_runs },
    definition: "label_values(parkbench_run_window, run_id)",
    query: {
      query: "label_values(parkbench_run_window, run_id)",
      refId: "PrometheusVariableQueryEditor-VariableQuery"
    },
    multi: true,
    includeAll: false,
    refresh: 1,
    sort: 0,
    current: {},
    options: []
  };
}

function noticeVariable(name: string, kind: string) {
  const query = `query_result(parkbench_run_notice_text{run_id=~"$run_id",kind="${kind}",window_start="$__from",window_end="$__to"})`;
  return {
    type: "query",
    name,
    hide: 2,
    skipUrlSync: true,
    datasource: { type: "prometheus", uid: DATASOURCE_UIDS.parkbench_runs },
    definition: query,
    query: { query, refId: name },
    regex: String.raw`/message="((?:\\.|[^"\\])*)"/`,
    multi: false,
    includeAll: false,
    refresh: 2,
    sort: 0,
    current: {
      text: "Notice unavailable; refresh the dashboard.",
      value: "Notice unavailable; refresh the dashboard."
    },
    options: []
  };
}

function pickerVariable() {
  return {
    type: "textbox",
    name: "picker_run",
    label: "Run shown on the time range",
    hide: 2,
    query: "",
    current: { text: "", value: "" },
    options: []
  };
}

function phaseAnnotation(matcher: string) {
  return {
    name: "Run phases",
    datasource: { type: "prometheus", uid: DATASOURCE_UIDS.parkbench_runs },
    enable: true,
    iconColor: "orange",
    expr: `parkbench_run_phase_boundary{${matcher}}`,
    step: "",
    titleFormat: "{{run_id}}: {{phase}} {{edge}}",
    textFormat: "",
    tagKeys: "phase,edge",
    useValueForTime: false
  };
}

/** Assembles the complete Grafana dashboard JSON for one definition. */
export function buildDashboard(
  key: DashboardKey,
  definition: DashboardDefinition,
  options: { webUrl?: string } = {}
): Record<string, unknown> {
  const runScoped = definition.runSelection === "multi";
  const filters = (definition.filters ?? []).map((name) => ({
    type: "query",
    name,
    label: name[0].toUpperCase() + name.slice(1),
    datasource: { type: "prometheus", uid: DATASOURCE_UIDS.parkbench_runs },
    query: {
      query: `label_values(${name === "phase" ? "parkbench_run_phase_boundary" : name === "replica" ? "parkbench_openedge_pas_requests_total" : name === "index" ? "parkbench_openedge_db_index_operations_total" : "parkbench_openedge_db_table_operations_total"}{run_id=~"$run_id"}, ${name})`,
      refId: "filter"
    },
    multi: true,
    includeAll: true,
    allValue: ".*",
    current: { text: "All", value: "$__all" },
    options: [],
    refresh: 1
  }));
  const variables: unknown[] = [
    ...(runScoped ? [runVariable()] : [pickerVariable()]),
    ...filters,
    ...(runScoped
      ? [
          noticeVariable("notice_time_range", "time_range"),
          noticeVariable("notice_excluded_runs", "excluded_runs")
        ]
      : []),
    constant(WEB_URL_VAR, options.webUrl ?? DEFAULT_WEB_URL),
    constant(DISK_EXCLUDE_VAR, DISK_EXCLUDE),
    constant(INTERFACE_EXCLUDE_VAR, INTERFACE_EXCLUDE)
  ];
  return {
    uid: definition.uid,
    title: definition.title,
    tags: definition.tags,
    description: runScoped
      ? "One run: real clock time (UTC). Several runs: runs are aligned on elapsed time since measurement start, which reads 00:00:00 on the axis; times before it are warmup."
      : "Data for the selected time range. Pick a run in the Runs table to jump to its time range and phase markers; the data is not filtered by run.",
    editable: false,
    graphTooltip: 1,
    timezone: "utc",
    schemaVersion: 41,
    version: 1,
    refresh: "",
    time: { from: "now-30m", to: "now" },
    timepicker: {},
    fiscalYearStartMonth: 0,
    liveNow: false,
    templating: { list: variables },
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: "grafana", uid: "-- Grafana --" },
          enable: true,
          hide: true,
          iconColor: "rgba(0, 211, 255, 1)",
          name: "Annotations & Alerts",
          type: "dashboard"
        },
        phaseAnnotation(runScoped ? 'run_id=~"$run_id"' : 'run_id="$picker_run"')
      ]
    },
    links: linkBar(key, runScoped),
    panels: emitPanels(definition)
  };
}
