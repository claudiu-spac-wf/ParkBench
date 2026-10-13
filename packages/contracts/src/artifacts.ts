export type ArtifactKind =
  | "scenario_snapshot"
  | "effective_configuration"
  | "input_manifest"
  | "environment_snapshot"
  | "compose_bundle"
  | "log"
  | "diagnostics"
  | "load_summary"
  | "raw_prometheus_timeseries"
  | "comparison_export"
  | "observer_report"
  | "openedge_image_manifest"
  | "run_evidence"
  | "db_parameter_snapshot"
  | "database_latency"
  | "run_comparison_summary"
  | "run_context";
export interface Artifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  path: string;
  sizeBytes: number;
  format: string;
  sourceMetadata?: Record<string, unknown>;
  createdAt: string;
  retained: boolean;
}
