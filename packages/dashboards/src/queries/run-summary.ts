import { nativeDiagnosticExpression } from "./diagnostic";
import { containerCpuPercent } from "./container-cpu";
import { Panel, TopN } from "../model";
import { legend } from "../naming";
import { HOST_CORES, RUN_CONTAINER_JOB } from "../scopes";
import { directionalTargets } from "../split";
import { ranking, totals, withOther } from "../topn";

const RATE = "[$__rate_interval]";
const RANGE = "[$__range] @ end()";

const RUN = 'run_id=~"$run_id"';
const DB = `job="${RUN_CONTAINER_JOB}",${RUN},service="database"`;
const PAS = `job="${RUN_CONTAINER_JOB}",${RUN},service=~"pas-[0-9]+"`;

export const P95_UNAVAILABLE_NOTE = "p95 unavailable: the PAS metric has no distribution";
export const tableTopN: TopN = {
  n: 10,
  partitionBy: "run_id",
  key: "table",
  otherLabel: "Other",
  tieBreak: "value_then_name",
  excludeZero: true
};
export function tableRankExpression(operation: string, view: "rate" | "total"): string {
  return `parkbench_table_rank{run_id=~"$run_id",phase=~"$phase",operation="${operation}",view="${view}",window_start="$__from",window_end="$__to"}`;
}
function runTotalTarget(expression: string) {
  return {
    expr: expression.replace(/}$/, ',aggregate="run"}'),
    legendFormat: "{{run_id}} Total",
    instant: true
  };
}
function tablePanels(kind: "reads" | "writes"): Panel[] {
  return (["rate", "total"] as const).map((view) => ({
    id: `rs.table_${kind}_${view}`,
    title: `DB table ${kind} (${view === "rate" ? "records/s" : "total"})`,
    description:
      "Diagnostic range activity: ten fixed named tables per metric/run, plus the complementary display Other. " +
      (view === "total"
        ? "The additional Total sums every table and Other exactly once per run; unavailable contributions make the Total unavailable. "
        : "") +
      "Totals include observed startup/drain activity and require coverage throughout selected workload phases; unobserved provisioning/cleanup is excluded. Full table detail is available in Database Activity.",
    category: view === "rate" ? "table_rate" : "table_total",
    split: "none",
    breakdown: "table",
    topN: tableTopN,
    visual: view === "rate" ? "timeseries" : "bar_totals",
    targets: [
      {
        expr: tableRankExpression(kind === "reads" ? "read" : "write", view),
        legendFormat: "{{run_id}} {{table}}",
        instant: view === "total"
      },
      ...(view === "total"
        ? [runTotalTarget(tableRankExpression(kind === "reads" ? "read" : "write", view))]
        : [])
    ]
  }));
}

function indexPanels(kind: "reads" | "writes"): Panel[] {
  return (["rate", "total"] as const).map((view) => ({
    id: `rs.index_${kind}_${view}`,
    title: `DB index ${kind} (${view === "rate" ? "blocks/s" : "total"})`,
    description:
      "Database-wide index block activity over the selected phase and time range. Separate runs and database epochs retain their identity; unavailable observations remain gaps. " +
      (view === "total"
        ? "The additional Total sums all database series per run; unavailable contributions make the Total unavailable. "
        : "") +
      "Totals include observed startup/drain activity and require coverage throughout selected workload phases; unobserved provisioning/cleanup is excluded.",
    category: view === "rate" ? "event_rate" : "count",
    unit: view === "rate" ? "suffix:blocks/s" : "suffix:blocks",
    split: "none",
    breakdown: "none",
    visual: view === "rate" ? "timeseries" : "bar_totals",
    targets: [
      {
        expr: nativeDiagnosticExpression(
          `index_blocks_${kind === "reads" ? "read" : "written"}_total`,
          view
        ),
        legendFormat: "{{run_id}} {{database}}",
        instant: view === "total"
      },
      ...(view === "total"
        ? [
            runTotalTarget(
              nativeDiagnosticExpression(
                `index_blocks_${kind === "reads" ? "read" : "written"}_total`,
                view
              )
            )
          ]
        : [])
    ]
  }));
}

const cpuPct = (matchers: string, by: string) => containerCpuPercent(matchers, by);

const fsRate = (direction: string, unit: "bytes" | "ops") =>
  `sum by (run_id) (rate(container_fs_${direction === "Read" ? "reads" : "writes"}${unit === "bytes" ? "_bytes" : ""}_total{${DB}}${RATE}))`;

const pasCounter = (metric: string) => `sum by (run_id, replica) (rate(${metric}{${RUN}}${RATE}))`;

const ablAverage =
  `sum by (run_id) (parkbench_openedge_pas_avg_abl_processing_seconds{${RUN}} * on (run_id, replica) group_left () ${pasCounter("parkbench_openedge_pas_requests_total")})` +
  ` / sum by (run_id) (${pasCounter("parkbench_openedge_pas_requests_total")})`;

export function runSummaryRows() {
  const resources: Panel[] = [
    {
      id: "rs.db_cpu",
      title: "DB CPU usage",
      description:
        "Database container CPU, as one-core percentage; values above 100% represent multiple cores.",
      category: "cpu_pct",
      split: "none",
      breakdown: "none",
      visual: "timeseries",
      targets: [
        { expr: cpuPct(DB, "run_id"), legendFormat: legend({ runPrefix: true, entity: "DB" }) }
      ]
    },
    {
      id: "rs.db_memory",
      title: "DB memory usage",
      description: "Database container working set.",
      category: "memory",
      split: "none",
      breakdown: "none",
      visual: "timeseries",
      targets: [
        {
          expr: `sum by (run_id) (container_memory_working_set_bytes{${DB}})`,
          legendFormat: legend({ runPrefix: true, entity: "DB" })
        }
      ]
    },
    {
      id: "rs.pas_cpu",
      title: "PAS CPU usage",
      description:
        "CPU per PAS instance, as one-core percentage; values above 100% represent multiple cores.",
      category: "cpu_pct",
      split: "none",
      breakdown: "replica",
      visual: "timeseries",
      targets: [
        {
          expr: cpuPct(PAS, "run_id, service"),
          legendFormat: legend({ runPrefix: true, entity: "{{service}}" })
        }
      ]
    },
    {
      id: "rs.pas_memory",
      title: "PAS memory usage",
      description: "Working set per PAS instance.",
      category: "memory",
      split: "none",
      breakdown: "replica",
      visual: "timeseries",
      targets: [
        {
          expr: `sum by (run_id, service) (container_memory_working_set_bytes{${PAS}})`,
          legendFormat: legend({ runPrefix: true, entity: "{{service}}" })
        }
      ]
    }
  ];
  const disk: Panel[] = [
    {
      id: "rs.db_disk",
      title: "DB disk throughput",
      category: "disk_throughput",
      split: "read_write",
      breakdown: "none",
      visual: "timeseries",
      targets: directionalTargets({
        kind: "disk",
        expr: (d) => fsRate(d, "bytes"),
        runPrefix: true,
        entity: "DB"
      })
    },
    {
      id: "rs.db_disk_iops",
      title: "DB disk IOPS",
      category: "disk_iops",
      split: "read_write",
      breakdown: "none",
      visual: "timeseries",
      targets: directionalTargets({
        kind: "disk",
        expr: (d) => fsRate(d, "ops"),
        runPrefix: true,
        entity: "DB"
      })
    }
  ];
  const pas: Panel[] = [
    {
      id: "rs.pas_requests",
      title: "PAS requests per second",
      category: "requests",
      split: "none",
      breakdown: "replica",
      visual: "timeseries",
      targets: [
        {
          expr: pasCounter("parkbench_openedge_pas_requests_total"),
          legendFormat: legend({ runPrefix: true, entity: "{{replica}}" })
        }
      ]
    },
    {
      id: "rs.pas_failures",
      title: "PAS failed requests per second",
      category: "requests",
      split: "none",
      breakdown: "replica",
      visual: "timeseries",
      targets: [
        {
          expr: pasCounter("parkbench_openedge_pas_failed_requests_total"),
          legendFormat: legend({ runPrefix: true, entity: "{{replica}}" })
        }
      ]
    },
    {
      id: "rs.abl_time",
      title: "PAS ABL processing time",
      description:
        "Average ABL processing time across all PAS instances, weighted by each instance's request rate; one line per run.",
      note: P95_UNAVAILABLE_NOTE,
      category: "duration",
      split: "none",
      breakdown: "none",
      visual: "timeseries",
      targets: [{ expr: ablAverage, legendFormat: legend({ runPrefix: true, entity: "Average" }) }]
    }
  ];
  return {
    resources,
    disk,
    tables: [
      ...tablePanels("reads"),
      ...tablePanels("writes"),
      ...indexPanels("reads"),
      ...indexPanels("writes")
    ],
    pas
  };
}
