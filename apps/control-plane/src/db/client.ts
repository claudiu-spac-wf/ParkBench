import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export class DatabaseClient {
  readonly db: DatabaseSync;
  constructor(file = ":memory:") {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys=ON");
  }
  migrate(sql: string): void {
    this.db.exec(sql);
    for (const column of ["summary", "observer_health", "phase_boundaries", "failure_code"]) {
      try {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
      } catch {
        // Existing installations already have the additive column.
      }
    }
    try {
      this.db.exec("ALTER TABLE control_dashboard_contexts ADD COLUMN grafana_url TEXT");
    } catch {
      // Existing control-UI installations already have the additive column.
    }
    for (const statement of [
      "ALTER TABLE control_comparisons ADD COLUMN selection_revision INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE control_image_operations ADD COLUMN logs TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE control_previews ADD COLUMN reviewed_ranges TEXT NOT NULL DEFAULT '[]'"
    ]) {
      try {
        this.db.exec(statement);
      } catch {
        // Existing control-UI installations already have the additive column.
      }
    }
    this.db.exec("DROP INDEX IF EXISTS idx_control_previews_hash");
    for (const [table, column] of [
      ["artifacts", "sha256"],
      ["control_assets", "digest"],
      ["control_scenarios", "document_sha256"],
      ["control_image_operations", "input_checksums"],
      ["control_image_operations", "output_digest"],
      ["control_previews", "request_sha256"],
      ["control_experiments", "request_sha256"],
      ["control_run_metadata", "variant_fingerprint"]
    ]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      if (columns.some((item) => item.name === column))
        this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    for (const statement of [
      "CREATE INDEX IF NOT EXISTS idx_control_run_repetition ON control_run_metadata(repetition, updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_runs_history_state_finished ON runs(state, finished_at, experiment_id)",
      "CREATE INDEX IF NOT EXISTS idx_runs_history_experiment_finished ON runs(experiment_id, finished_at)"
    ]) {
      try {
        this.db.exec(statement);
      } catch {
        // Existing installations may not have the foundation run table yet.
      }
    }
    // Remove legacy catalog copies after applying the historical schema. No run or
    // dashboard table has a foreign key to these four asset tables.
    for (const table of [
      "control_asset_discovery",
      "control_assets",
      "control_scenarios",
      "scenarios"
    ])
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  close(): void {
    this.db.close();
  }
}
