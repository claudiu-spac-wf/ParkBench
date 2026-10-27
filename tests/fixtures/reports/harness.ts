import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseClient } from "../../../apps/control-plane/src/db/client";
import { ReportRepository } from "../../../apps/control-plane/src/reports/repository";
import { ReportArtifacts } from "../../../apps/control-plane/src/reports/artifacts";
import { ReportService } from "../../../apps/control-plane/src/reports/service";
import { HostDispatcher } from "../../../apps/control-plane/src/execution/host-dispatcher";
import { FakeAnalysisRunner } from "./fake-analysis-runner";
export function reportHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-reports-")),
    seed = path.join(root, "seeds", "fixture");
  fs.mkdirSync(seed, { recursive: true });
  for (const [name, data] of [
    ["db.db", "fixture"],
    ["db.b1", ""],
    ["db.d1", ""],
    ["db.st", "b .\nd .\n"]
  ])
    fs.writeFileSync(path.join(seed, name), data);
  const database = new DatabaseClient(path.join(root, "state.db"));
  database.db.exec(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../apps/control-plane/src/db/migrations/008_database_reports.sql"
      ),
      "utf8"
    )
  );
  const repo = new ReportRepository(database),
    artifacts = new ReportArtifacts(path.join(root, "artifacts"), repo),
    runner = new FakeAnalysisRunner(),
    gate = new HostDispatcher(repo);
  const service = new ReportService(repo, artifacts, runner, gate, {
    image: "db:12.8.11",
    cleanupRetryMs: 20,
    resolveSeed: (id) => ({
      assetId: id,
      name: "fixture",
      path: seed,
      databaseName: "db",
      managedRoot: path.dirname(seed)
    })
  });
  return {
    root,
    repo,
    artifacts,
    runner,
    gate,
    service,
    close() {
      service.close();
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
export const request = {
  contractVersion: "database-analysis-report.v1",
  family: "database-analysis",
  seedAssetId: "fixture",
  type: "DBANALYS"
} as const;
export async function eventually<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeout = 10000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() - start > timeout) throw new Error("condition_not_met:" + JSON.stringify(value));
    await new Promise((r) => setTimeout(r, 5));
  }
}
