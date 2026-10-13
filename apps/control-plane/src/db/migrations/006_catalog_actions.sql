CREATE TABLE IF NOT EXISTS control_catalog_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_control_catalog_actions_kind_created
  ON control_catalog_actions(kind, created_at);
