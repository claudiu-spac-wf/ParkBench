CREATE TABLE IF NOT EXISTS run_execution (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 revision TEXT NOT NULL
);
INSERT OR IGNORE INTO run_execution(run_id,revision)
 SELECT r.id,e.revision FROM runs r JOIN experiment_execution e ON e.experiment_id=r.experiment_id;
