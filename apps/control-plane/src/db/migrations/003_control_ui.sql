CREATE TABLE IF NOT EXISTS control_image_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  stage TEXT,
  input_asset_ids TEXT NOT NULL,
  expected_contracts TEXT NOT NULL,
  output_profile TEXT,
  command_id TEXT NOT NULL,
  state TEXT NOT NULL,
  progress TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  logs TEXT NOT NULL DEFAULT '[]',
  output_asset_ids TEXT NOT NULL,
  failure_code TEXT,
  failure_reason TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS control_previews (
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  cells_json TEXT NOT NULL,
  cell_count INTEGER NOT NULL,
  run_count INTEGER NOT NULL,
  warning TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL,
  reviewed_ranges TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS control_experiments (
  experiment_id TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  scenario_snapshot TEXT NOT NULL,
  matrix_spec TEXT NOT NULL,
  execution_policy TEXT NOT NULL,
  queue_ordinal INTEGER NOT NULL,
  baseline_run_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_run_metadata (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  cell_ordinal INTEGER NOT NULL,
  repetition INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  effective_configuration TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  queue_state TEXT NOT NULL,
  blocked_reason TEXT,
  next_retry_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_run_experiment ON control_run_metadata(experiment_id, cell_ordinal, repetition);
CREATE INDEX IF NOT EXISTS idx_control_run_queue_state ON control_run_metadata(queue_state, next_retry_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_control_run_updated_at ON control_run_metadata(updated_at);
CREATE INDEX IF NOT EXISTS idx_control_run_repetition ON control_run_metadata(repetition, updated_at);
CREATE INDEX IF NOT EXISTS idx_control_experiment_status ON control_experiments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_history_state_finished ON runs(state, finished_at, experiment_id);
CREATE INDEX IF NOT EXISTS idx_runs_history_experiment_finished ON runs(experiment_id, finished_at);
CREATE TABLE IF NOT EXISTS control_comparisons (
  id TEXT PRIMARY KEY,
  experiment_id TEXT,
  baseline_run_id TEXT,
  variant_run_ids TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  eligibility_reasons TEXT NOT NULL,
  shared_context TEXT NOT NULL,
  dashboard_context_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_dashboard_contexts (
  id TEXT PRIMARY KEY,
  experiment_id TEXT,
  run_ids TEXT NOT NULL,
  baseline_run_id TEXT,
  phase TEXT,
  metric_scope TEXT NOT NULL,
  dashboard_refs TEXT NOT NULL,
  variables TEXT NOT NULL,
  availability TEXT NOT NULL,
  grafana_url TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_command_results (
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation, idempotency_key)
);
