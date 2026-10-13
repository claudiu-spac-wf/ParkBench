import { containerCpuPercent } from "./container-cpu";
import { diagnosticPanels } from "./diagnostic";
export function pasPanels() {
  const panels = diagnosticPanels("parkbench-pas-instances");
  const cpu = panels.find((p) => p.legacy?.panelId === 5)!;
  cpu.title = "PAS CPU usage (one-core %)";
  cpu.category = "cpu_pct";
  cpu.unit = "percent";
  const owned =
    'job="parkbench-run-owned-cadvisor",run_id=~"$run_id",phase=~"$phase",service=~"$replica"';
  cpu.targets = [
    { expr: containerCpuPercent(owned, "run_id, service"), legendFormat: "{{run_id}} {{service}}" }
  ];
  for (const p of panels.filter((p) => (p.legacy?.panelId ?? 0) >= 6))
    p.targets.forEach((t) => {
      t.expr = t.expr.replace(
        'run_id=~"$run_id"',
        'job="parkbench-run-owned-cadvisor",run_id=~"$run_id"'
      );
    });
  for (const [id, metrics, names] of [
    [7, ["container_fs_reads_bytes_total", "container_fs_writes_bytes_total"], ["Read", "Write"]],
    [
      8,
      ["container_network_receive_bytes_total", "container_network_transmit_bytes_total"],
      ["Receive", "Transmit"]
    ]
  ] as const) {
    const panel = panels.find((p) => p.legacy?.panelId === id)!;
    panel.targets = metrics.map((metric, index) => ({
      expr: `sum by (run_id,service) (rate(${metric}{${owned}}[$__rate_interval]))`,
      legendFormat: `{{run_id}} {{service}} ${names[index]}`
    }));
  }
  panels.push({
    id: "pas.abl_weighted_average",
    title: "Request-weighted PAS ABL average",
    description:
      "Native per-replica averages weighted by the request rate; no distribution or latency percentile is implied.",
    category: "duration",
    split: "none",
    breakdown: "none",
    visual: "timeseries",
    targets: [
      {
        expr: 'sum by (run_id) (parkbench_openedge_pas_avg_abl_processing_seconds{run_id=~"$run_id",phase=~"$phase",replica=~"$replica"} * on (run_id,replica) group_left() sum by (run_id,replica) (rate(parkbench_openedge_pas_requests_total{run_id=~"$run_id",phase=~"$phase",replica=~"$replica"}[$__rate_interval]))) / sum by (run_id) (rate(parkbench_openedge_pas_requests_total{run_id=~"$run_id",phase=~"$phase",replica=~"$replica"}[$__rate_interval]))',
        legendFormat: "{{run_id}} weighted average"
      }
    ]
  });
  return panels;
}
