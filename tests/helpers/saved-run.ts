import fs from "node:fs";
import path from "node:path";
import type { Repositories } from "../../apps/control-plane/src/db/repositories";
/** Read the registered immutable result, avoiding historical report paths. */
export function savedRun(root: string, repositories: Repositories, runId: string) {
  const artifact = repositories
    .listArtifacts(runId)
    .find((a) => a.kind === "run_comparison_summary");
  if (!artifact) throw new Error("registered_run_summary_missing");
  const summary = JSON.parse(fs.readFileSync(path.join(root, artifact.path), "utf8"));
  const contextArtifact = repositories.listArtifacts(runId).find((a) => a.kind === "run_context");
  if (!contextArtifact) throw new Error("registered_run_context_missing");
  const context = JSON.parse(fs.readFileSync(path.join(root, contextArtifact.path), "utf8"));
  return { summary, context };
}
