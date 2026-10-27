import { randomUUID } from "node:crypto";
import { DatabaseClient } from "../db/client";
import {
  ReportMetadata,
  ReportRequest,
  ReportArtifact,
  ReportDataset
} from "../../../../packages/contracts/src/database-analysis-report";
export class ReportRepository {
  constructor(readonly database: DatabaseClient) {}
  get db() {
    return this.database.db;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  replay(key: string, requestText: string): ReportMetadata | undefined {
    const row = this.db.prepare("SELECT * FROM report_submissions WHERE key=?").get(key) as any;
    if (!row) return;
    if (row.request_text !== requestText) throw new Error("report_idempotency_conflict");
    return this.get(row.report_id);
  }
  create(report: ReportMetadata, key: string, requestText: string) {
    return this.transaction(() => {
      const existing = this.replay(key, requestText);
      if (existing) return existing;
      const result = this.db
        .prepare("INSERT INTO database_reports(id,state,document) VALUES(?,?,?)")
        .run(report.id, report.state, JSON.stringify(report));
      report.queueSequence = Number(result.lastInsertRowid);
      this.save(report);
      for (const dataset of report.datasets) this.dataset(report.id, dataset);
      this.db
        .prepare("INSERT INTO report_submissions VALUES(?,?,?)")
        .run(key, requestText, report.id);
      return report;
    });
  }
  save(report: ReportMetadata) {
    if ((report.pendingTerminalState === "FAILED") !== Boolean(report.pendingFailure))
      throw new Error("report_pending_failure_invalid");
    this.db
      .prepare(
        "UPDATE database_reports SET state=?,document=?,pending_terminal_state=?,pending_failure=?,cleanup_retry_at=? WHERE id=?"
      )
      .run(
        report.state,
        JSON.stringify({ ...report, datasets: [], artifacts: [] }),
        report.pendingTerminalState,
        report.pendingFailure ? JSON.stringify(report.pendingFailure) : null,
        report.cleanupRetryAt,
        report.id
      );
  }
  get(id: string): ReportMetadata | undefined {
    const row = this.db.prepare("SELECT document FROM database_reports WHERE id=?").get(id) as any;
    if (!row) return;
    const value = JSON.parse(row.document);
    value.datasets = this.db
      .prepare("SELECT document FROM report_datasets WHERE report_id=? ORDER BY kind")
      .all(id)
      .map((r: any) => JSON.parse(r.document));
    value.artifacts = this.db
      .prepare("SELECT document FROM report_artifacts WHERE report_id=? ORDER BY id")
      .all(id)
      .map((r: any) => JSON.parse(r.document));
    return value;
  }
  list(state?: string): ReportMetadata[] {
    return (
      state
        ? this.db
            .prepare("SELECT id FROM database_reports WHERE state=? ORDER BY queue_sequence")
            .all(state)
        : this.db.prepare("SELECT id FROM database_reports ORDER BY queue_sequence DESC").all()
    ).map((r: any) => this.get(r.id)!);
  }
  oldest() {
    const row = this.db
      .prepare(
        "SELECT id FROM database_reports WHERE state='QUEUED' ORDER BY queue_sequence LIMIT 1"
      )
      .get() as any;
    return row ? this.get(row.id) : undefined;
  }
  dataset(reportId: string, d: ReportDataset) {
    this.db
      .prepare("INSERT OR REPLACE INTO report_datasets VALUES(?,?,?)")
      .run(reportId, d.kind, JSON.stringify(d));
  }
  artifact(a: ReportArtifact) {
    this.db
      .prepare("INSERT INTO report_artifacts VALUES(?,?,?)")
      .run(a.id, a.reportId, JSON.stringify(a));
  }
  resource(reportId: string, token: string, document: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO report_resources VALUES(?,?,?)")
      .run(reportId, token, JSON.stringify(document));
  }
  resources(reportId: string) {
    return this.db
      .prepare("SELECT token,document FROM report_resources WHERE report_id=?")
      .all(reportId)
      .map((v: any) => ({ token: v.token, ...JSON.parse(v.document) }));
  }
  claim(kind: "REPORT" | "EXPERIMENT", id: string, token = randomUUID()): string | undefined {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM execution_host_claim").get()) return;
      if (kind === "EXPERIMENT" && this.oldest()) return;
      this.db.prepare("INSERT INTO execution_host_claim VALUES(1,?,?,?)").run(kind, id, token);
      return token;
    });
  }
  currentClaim() {
    return this.db.prepare("SELECT kind,owner_id,token FROM execution_host_claim").get() as
      { kind: string; owner_id: string; token: string } | undefined;
  }
  release(token: string) {
    return this.db.prepare("DELETE FROM execution_host_claim WHERE token=?").run(token).changes > 0;
  }
}
export function canonicalRequest(v: ReportRequest) {
  return JSON.stringify({
    contractVersion: v.contractVersion,
    family: v.family,
    seedAssetId: v.seedAssetId,
    type: v.type
  });
}
