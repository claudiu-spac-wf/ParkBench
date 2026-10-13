import type { Panel } from "../model";
import { nativeDiagnosticExpression, diagnosticPanels } from "./diagnostic";
export function databaseConcurrencyPanels() {
  const panels = diagnosticPanels(
    "parkbench-database-recovery-concurrency",
    [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54]
  );
  panels.push(...diagnosticPanels("parkbench-database-activity", [11, 12]));
  panels
    .filter((p) => p.title.includes("time per second"))
    .forEach((p) => {
      p.category = "duration_rate";
      p.unit = "suffix:s/s";
    });
  return panels;
}

/** Exact native instance/epoch reductions keep names readable without summing aggregate families. */
export function namedLatchPanels(): Panel[] {
  return (
    [
      [
        "wait_rate",
        "Named latch waits (naps/s)",
        "latch_named_waits_total",
        "rate",
        "suffix:naps/s"
      ],
      [
        "wait_total",
        "Named latch waits (total naps)",
        "latch_named_waits_total",
        "total",
        "suffix:naps"
      ],
      [
        "duration_rate",
        "Named latch wait-or-spin duration (s/s)",
        "latch_named_wait_or_spin_duration_seconds_total",
        "rate",
        "suffix:s/s"
      ],
      [
        "duration_total",
        "Named latch wait-or-spin duration (seconds)",
        "latch_named_wait_or_spin_duration_seconds_total",
        "total",
        "s"
      ]
    ] as const
  ).map(([id, title, metric, view, unit]) => ({
    id: `latch.named.${id}`,
    title,
    description:
      "Native _Latch-Wait counts naps; _Latch-WaitT is wait-or-spin time. Each native instance and database epoch is reduced separately over the selected run phases. Unsupported duration is unavailable. Aggregate families are separate and are never added to these values.",
    category:
      view === "rate"
        ? id.startsWith("duration")
          ? "duration_rate"
          : "event_rate"
        : id.startsWith("duration")
          ? "duration"
          : "count",
    split: "none",
    breakdown: "none",
    visual: view === "total" ? "bar_totals" : "timeseries",
    unit,
    targets: [
      {
        expr: nativeDiagnosticExpression(
          metric,
          view,
          {},
          view === "total" ? "name_type" : undefined
        ),
        legendFormat:
          view === "total"
            ? "{{run_id}} {{latch_name}} ({{latch_type}})"
            : "{{run_id}} {{latch_name}} ({{latch_type}}, {{latch_id}})",
        instant: view === "total"
      }
    ]
  }));
}
