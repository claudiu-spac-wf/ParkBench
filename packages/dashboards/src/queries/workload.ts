import { diagnosticPanels } from "./diagnostic";
export function workloadPanels() {
  const panels = diagnosticPanels("parkbench-benchmark-overview");
  const disk = panels.find((p) => p.legacy?.panelId === 3)!;
  disk.targets[0].expr =
    'rate(node_disk_read_bytes_total{job="parkbench-runs",service="node-exporter",run_id=~"$run_id",phase=~"$phase",device!~"$disk_exclude"}[$__rate_interval])';
  disk.targets[0].legendFormat = "{{run_id}} host {{device}} Read";
  disk.targets[1].expr =
    'sum by (run_id) (rate(container_fs_reads_bytes_total{job="parkbench-run-owned-cadvisor",run_id=~"$run_id",phase=~"$phase",service="database"}[$__rate_interval]))';
  disk.targets[1].legendFormat = "{{run_id}} database Read";
  // Full operation detail remains distinct from default ranked overviews.
  const tables = panels.find((p) => p.legacy?.panelId === 4)!;
  tables.visual = "table";
  tables.targets.forEach((t) => {
    t.instant = true;
    t.format = "table";
  });
  return panels;
}
