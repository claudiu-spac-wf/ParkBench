CREATE TABLE IF NOT EXISTS run_comparison_summaries (
 run_id TEXT NOT NULL REFERENCES runs(id), semantic_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('READY','RECOMPUTING','LEGACY','UNAVAILABLE')),
 document TEXT CHECK(document IS NULL OR (json_valid(document) AND length(CAST(document AS BLOB))<=2097152)),
 artifact_id TEXT, artifact_path TEXT, source_contract_versions TEXT,
 attempt_token TEXT NOT NULL, published_attempt_token TEXT, lease_until INTEGER,
 requested_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
 reason_code TEXT, retryable INTEGER NOT NULL DEFAULT 0, diagnostics_ref TEXT,
 total_row_count INTEGER NOT NULL DEFAULT 0, table_row_count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id,semantic_version),
 CHECK(status <> 'READY' OR (document IS NOT NULL AND artifact_id IS NOT NULL AND artifact_path IS NOT NULL AND published_attempt_token IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS run_comparison_summary_rows (
 run_id TEXT NOT NULL, semantic_version TEXT NOT NULL, attempt_token TEXT NOT NULL,
 row_key TEXT NOT NULL, table_name TEXT, group_order INTEGER NOT NULL,
 catalog_order INTEGER NOT NULL, dimension_order TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=16384),
 PRIMARY KEY(run_id,semantic_version,attempt_token,row_key),
 FOREIGN KEY(run_id,semantic_version) REFERENCES run_comparison_summaries(run_id,semantic_version)
);
CREATE INDEX IF NOT EXISTS idx_summary_catalog_rows ON run_comparison_summary_rows(run_id,semantic_version,attempt_token,group_order,catalog_order,dimension_order,row_key);
CREATE INDEX IF NOT EXISTS idx_summary_table_rows ON run_comparison_summary_rows(run_id,semantic_version,attempt_token,table_name,catalog_order,dimension_order,row_key);
