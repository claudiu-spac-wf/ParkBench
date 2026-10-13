import { MetricSample } from "../../contracts/src/metrics";
export function fakeSamples(
  runId: string,
  experimentId = "exp",
  variantId = "baseline",
  phase = "measurement"
): MetricSample[] {
  const labels: any = {
    experiment_id: experimentId,
    run_id: runId,
    variant_id: variantId,
    repetition: "1",
    component: "container",
    service: "database",
    phase
  };
  return [
    {
      metricName: "parkbench_container_disk_read_bytes_total",
      labels,
      timestamp: Date.now() / 1000,
      value: 100,
      source: "cadvisor"
    },
    {
      metricName: "parkbench_host_disk_read_bytes_total",
      labels: { ...labels, component: "host", service: "node-exporter" },
      timestamp: Date.now() / 1000,
      value: 200,
      source: "node-exporter:block-device"
    }
  ];
}
