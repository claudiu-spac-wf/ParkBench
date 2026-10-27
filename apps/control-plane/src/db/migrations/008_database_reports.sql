CREATE TABLE IF NOT EXISTS database_reports (
 queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')), document TEXT NOT NULL,
 pending_terminal_state TEXT, pending_failure TEXT, cleanup_retry_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_fifo ON database_reports(state,queue_sequence);
CREATE TABLE IF NOT EXISTS report_submissions (key TEXT PRIMARY KEY, request_text TEXT NOT NULL, report_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS report_datasets (report_id TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(report_id,kind));
CREATE TABLE IF NOT EXISTS report_artifacts (id TEXT PRIMARY KEY,report_id TEXT NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_report_artifacts_owner ON report_artifacts(report_id);
CREATE TABLE IF NOT EXISTS report_resources (report_id TEXT NOT NULL,token TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(report_id,token));
CREATE TABLE IF NOT EXISTS report_rows (report_id TEXT NOT NULL,kind TEXT NOT NULL,revision TEXT NOT NULL,ordinal INTEGER NOT NULL,object_key TEXT NOT NULL,label TEXT NOT NULL,area_id TEXT NOT NULL,concern TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(report_id,kind,revision,ordinal));
CREATE INDEX IF NOT EXISTS idx_report_rows_query ON report_rows(report_id,kind,revision,area_id,concern,ordinal);
CREATE TABLE IF NOT EXISTS report_cells (report_id TEXT NOT NULL,kind TEXT NOT NULL,revision TEXT NOT NULL,ordinal INTEGER NOT NULL,column_id INTEGER NOT NULL,availability INTEGER NOT NULL,numeric_class INTEGER NOT NULL,exponent INTEGER NOT NULL,digits TEXT NOT NULL,text_value TEXT NOT NULL,PRIMARY KEY(report_id,kind,revision,column_id,ordinal));
CREATE INDEX IF NOT EXISTS idx_report_cells_sort ON report_cells(report_id,kind,revision,column_id,availability,numeric_class,exponent,digits,ordinal);
CREATE TABLE IF NOT EXISTS report_findings (report_id TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,object_key TEXT NOT NULL,severity TEXT NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_report_findings ON report_findings(report_id,revision,kind,severity,ordinal);
CREATE TABLE IF NOT EXISTS report_summaries (report_id TEXT NOT NULL,revision TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(report_id,revision));
CREATE TABLE IF NOT EXISTS execution_host_claim (singleton INTEGER PRIMARY KEY CHECK(singleton=1),kind TEXT NOT NULL CHECK(kind IN ('REPORT','EXPERIMENT')),owner_id TEXT NOT NULL,token TEXT NOT NULL UNIQUE);
