import fs from "node:fs";
import { ArtifactStorage } from "./storage";
import { Run } from "../../../../packages/contracts/src/run";
export function retentionPolicy(days = 7) {
  return { days, purgeTemporaryVolumesAfterExport: true, keepRawPrometheusArtifact: true };
}

/** Only producers created by this workflow are transient after successful consolidation. */
export function purgeConsolidatedProducers(storage: ArtifactStorage, run: Run): void {
  if ((run.environmentSnapshot as any)?.contextContractVersion !== "run-context.v1") return;
  for (const filename of ["phase-clock.json", "loadgen-summary.json"])
    fs.rmSync(storage.safePath(`${run.id}/${filename}`), { force: true });
  for (const filename of ["phase-clock.json", "summary.json", "shutdown", "workload-start"])
    fs.rmSync(storage.safePath(`${run.id}/runtime/${filename}`), { force: true });
  const runtimeDirectory = storage.safePath(`${run.id}/runtime`);
  if (fs.existsSync(runtimeDirectory) && !fs.readdirSync(runtimeDirectory).length)
    fs.rmdirSync(runtimeDirectory);
}
