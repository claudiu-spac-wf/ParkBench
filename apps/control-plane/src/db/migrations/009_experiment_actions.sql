CREATE TABLE IF NOT EXISTS experiment_execution (
 experiment_id TEXT PRIMARY KEY, revision TEXT NOT NULL, schedule_json TEXT
);
CREATE TABLE IF NOT EXISTS experiment_actions (
 id TEXT PRIMARY KEY, experiment_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('RERUN','REMOVE')),
 status TEXT NOT NULL CHECK(status IN ('PENDING','FAILED','SUCCEEDED')), stage TEXT NOT NULL,
 holds_fence INTEGER NOT NULL DEFAULT 1 CHECK(holds_fence IN (0,1)),
 key_hash TEXT NOT NULL UNIQUE, request_binding TEXT NOT NULL, document TEXT NOT NULL,
 updated_at TEXT NOT NULL, expires_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_action_fence ON experiment_actions(experiment_id) WHERE holds_fence=1;
CREATE TABLE IF NOT EXISTS comparison_unavailability (id TEXT PRIMARY KEY, reason TEXT NOT NULL, invalidated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_unavailability (id TEXT PRIMARY KEY, reason TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS comparison_removed_members (id TEXT PRIMARY KEY, member_count INTEGER NOT NULL, baseline_removed INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS experiment_action_pages (action_id TEXT NOT NULL REFERENCES experiment_actions(id) ON DELETE CASCADE, section TEXT NOT NULL, ordinal INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(action_id,section,ordinal));
CREATE TABLE IF NOT EXISTS retired_command_keys (key_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
