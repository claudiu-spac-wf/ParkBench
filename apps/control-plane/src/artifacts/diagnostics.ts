import { ArtifactStorage } from "./storage";
import { Repositories } from "../db/repositories";
import { artifactRecord } from "./manifest";
import {
  redactSecrets,
  runtimeSecretValues
} from "../../../../packages/contracts/src/redaction";
export function saveDiagnostics(
  storage: ArtifactStorage,
  repositories: Repositories,
  runId: string,
  diagnostics: unknown,
  additionalSecrets: string[] = []
): void {
  const file = storage.write(
    `${runId}/diagnostics.json`,
    JSON.stringify(
      redactSecrets(diagnostics, [...runtimeSecretValues(), ...additionalSecrets]),
      null,
      2
    )
  );
  repositories.saveArtifact(artifactRecord(runId, "diagnostics", file, "json"));
}
