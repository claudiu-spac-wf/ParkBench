import fs from "node:fs";
import path from "node:path";
import { Run } from "../../../../packages/contracts/src/run";
import {
  DatabaseSetupManifest,
  DatabaseSetupEvidence,
  pendingSetupEvidence
} from "../../../../packages/contracts/src/database-setup";
import { readDatabaseSetupEvidence } from "../../../../packages/compose-runner/src/database-setup-evidence";
import { RunResource } from "../../../../packages/compose-runner/src/resources";
import { ArtifactStorage } from "../artifacts/storage";
import { Repositories } from "../db/repositories";
import { artifactRecord } from "../artifacts/manifest";

export type ResourceIntent = {
  type: string;
  name: string;
  labels: Record<string, string>;
  registeredAt: string;
};
/** Intent objects deliberately carry no createdAt. Creation is observed separately. */
export function reconcileSetupResources(run: Run, actual: RunResource[]): RunResource[] {
  const result = [...actual];
  for (const intent of (run.environmentSnapshot?.databaseSetupResourceIntents ??
    []) as ResourceIntent[]) {
    if (!result.some((r) => r.resourceType === intent.type && r.resourceId === intent.name))
      result.push({
        resourceType: intent.type as RunResource["resourceType"],
        resourceId: intent.name,
        labels: intent.labels
      } as RunResource);
  }
  return result;
}
export function currentSetupEvidence(run: Run): DatabaseSetupEvidence {
  const snapshot = run.environmentSnapshot as any;
  if (snapshot?.databaseSetupEvidence) return snapshot.databaseSetupEvidence;
  return pendingSetupEvidence(
    run.id,
    snapshot?.databaseSetupManifest?.attemptId ?? "legacy",
    snapshot?.databaseSetup
  );
}
export function persistSetupEvidence(
  run: Run,
  manifest: DatabaseSetupManifest,
  storage: ArtifactStorage,
  repositories: Repositories,
  override?: Partial<DatabaseSetupEvidence>
) {
  let observed: DatabaseSetupEvidence;
  try {
    observed = readDatabaseSetupEvidence(manifest);
  } catch (error) {
    observed = {
      ...pendingSetupEvidence(run.id, manifest.attemptId, manifest.sequence),
      state: "FAILED",
      finishedAt: new Date().toISOString(),
      cleanup: "UNCERTAIN",
      failure: { code: "database_setup_evidence_invalid", message: String(error) }
    };
  }
  const prior = run.environmentSnapshot?.databaseSetupEvidence as DatabaseSetupEvidence | undefined;
  if (
    prior &&
    ["FAILED", "CANCELLED", "INTERRUPTED"].includes(prior.state) &&
    ["PENDING", "RUNNING"].includes(observed.state)
  )
    observed = { ...observed, ...prior };
  const evidence = { ...observed, ...override };
  const durable = repositories.getRun(run.id);
  if (durable?.failureKind === "cancellation") {
    run.failureKind = "cancellation";
    run.failureReason = durable.failureReason;
  }
  const relative = `${run.id}/database-setup/${manifest.attemptId}`;
  const destination = storage.safePath(relative);
  fs.mkdirSync(destination, { recursive: true });
  // Stream-copy only owned protocol/log files; never hydrate arbitrary native log size.
  const copy = (source: string, part: string) => {
    if (!fs.existsSync(source)) return;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const next = path.join(part, entry.name),
        file = path.join(source, entry.name);
      if (entry.isDirectory()) copy(file, next);
      else if (
        entry.isFile() &&
        /^[0-9A-Za-z_.-]+$/.test(entry.name) &&
        !entry.name.endsWith(".tmp")
      ) {
        const target = storage.safePath(`${relative}/${next}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
        const artifactPath = `${relative}/${next}`;
        if (!repositories.listArtifacts(run.id).some((a) => a.path === artifactPath))
          repositories.saveArtifact(
            artifactRecord(
              run.id,
              "diagnostics",
              { path: artifactPath, sizeBytes: fs.statSync(target).size },
              entry.name.endsWith(".json") ? "json" : "text",
              { databaseSetup: true, attemptId: manifest.attemptId }
            )
          );
      }
    }
  };
  copy(manifest.paths.output, "output");
  const file = storage.writeAtomic(
    `${relative}/evidence.json`,
    JSON.stringify({ ...evidence, configuration: manifest.sequence, manifest }, null, 2) + "\n"
  );
  if (!repositories.listArtifacts(run.id).some((a) => a.path === file.path))
    repositories.saveArtifact(
      artifactRecord(run.id, "diagnostics", file, "json", {
        databaseSetup: true,
        attemptId: manifest.attemptId
      })
    );
  run.environmentSnapshot = { ...run.environmentSnapshot, databaseSetupEvidence: evidence };
  repositories.saveRun(run);
  return evidence;
}
