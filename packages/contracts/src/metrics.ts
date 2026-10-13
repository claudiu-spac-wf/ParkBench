import openEdgeDbMetricCatalog from "./openedge-db-metric-catalog.json";

export type MetricType = "counter" | "gauge" | "histogram" | "info";
export type MetricPhase = "warmup" | "measurement" | "cooldown" | "idle";
export interface MetricLabels {
  experiment_id: string;
  run_id: string;
  variant_id: string;
  repetition: string;
  component: string;
  service: string;
  phase: MetricPhase;
  operation?: string;
  [key: string]: string | undefined;
}
export interface MetricSample {
  metricName: string;
  type?: MetricType;
  labels: MetricLabels;
  timestamp: number;
  value: number;
  source: string;
}

export interface MetricSourceMetadata {
  source: string;
  job?: string;
  target?: string;
  metricName: string;
}
export interface MetricSummary {
  runId: string;
  metricName: string;
  type?: MetricType;
  labels: MetricLabels;
  phase: MetricPhase | "all";
  count: number;
  min?: number;
  max?: number;
  mean?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  sum?: number;
  expectedSamples: number;
  observedSamples: number;
  completeness: number;
  prometheusQuery: string;
}
const PLATFORM_CORE_METRICS = [
  "parkbench_workload_requests_total",
  "parkbench_workload_errors_total",
  "parkbench_workload_request_duration_seconds",
  "parkbench_workload_in_flight",
  "parkbench_workload_throughput_per_second",
  "parkbench_workload_worker_health",
  "parkbench_observer_scrapes_total",
  "parkbench_observer_scrape_failures_total",
  "parkbench_observer_health",
  "parkbench_observer_last_success_timestamp_seconds",
  "parkbench_observer_longest_gap_seconds",
  "parkbench_observer_expected_samples_total",
  "parkbench_observer_observed_samples_total",
  "parkbench_observer_incomplete",
  "parkbench_container_cpu_usage_seconds_total",
  "parkbench_container_memory_working_set_bytes",
  "parkbench_container_network_receive_bytes_total",
  "parkbench_container_network_transmit_bytes_total",
  "parkbench_container_disk_read_bytes_total",
  "parkbench_container_disk_write_bytes_total",
  "parkbench_container_disk_read_operations_total",
  "parkbench_container_disk_write_operations_total",
  "parkbench_container_disk_io_time_seconds_total",
  "parkbench_container_health",
  "parkbench_host_cpu_utilization_ratio",
  "parkbench_host_memory_available_bytes",
  "parkbench_host_filesystem_available_bytes",
  "parkbench_host_disk_read_bytes_total",
  "parkbench_host_disk_write_bytes_total",
  "parkbench_host_disk_read_operations_total",
  "parkbench_host_disk_write_operations_total",
  "parkbench_host_disk_io_time_seconds_total",
  "parkbench_file_size_bytes",
  "parkbench_file_disk_usage_bytes",
  "parkbench_openedge_pas_requests_total",
  "parkbench_openedge_pas_post_requests_total",
  "parkbench_openedge_pas_get_requests_total",
  "parkbench_openedge_pas_failed_requests_total",
  "parkbench_openedge_pas_post_errors_total",
  "parkbench_openedge_pas_get_errors_total",
  "parkbench_openedge_pas_successful_requests_total",
  "parkbench_openedge_pas_avg_abl_processing_seconds",
  "parkbench_openedge_pas_min_abl_processing_seconds",
  "parkbench_openedge_pas_max_abl_processing_seconds"
] as const;

export const CORE_METRICS = [
  ...PLATFORM_CORE_METRICS,
  ...openEdgeDbMetricCatalog.metricNames.map((name) => `parkbench_openedge_db_${name}`),
  "parkbench_openedge_db_metric_available",
  "parkbench_openedge_db_parameter_snapshot_info",
  "parkbench_openedge_db_parameter_snapshot_numeric",
  "parkbench_openedge_db_parameter_snapshot_timestamp_seconds",
  "parkbench_openedge_db_parameter_snapshot_rows",
  "parkbench_openedge_db_parameter_snapshot_status"
];
