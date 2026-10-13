import { Repositories } from "../db/repositories";
import { ArtifactStorage } from "./storage";
import { artifactRecord } from "./manifest";
import { Artifact, ArtifactKind } from "../../../../packages/contracts/src/artifacts";
export class ArtifactService {
  constructor(public readonly storage: ArtifactStorage, private readonly repositories: Repositories) {}
  write(
    runId: string,
    kind: ArtifactKind,
    name: string,
    contents: string | Buffer,
    format = "json",
    sourceMetadata?: Record<string, unknown>
  ): Artifact {
    const file = this.storage.write(`${runId}/${name}`, contents);
    const artifact = artifactRecord(runId, kind, file, format, sourceMetadata);
    this.repositories.saveArtifact(artifact);
    return artifact;
  }
  list(runId: string) { return this.repositories.listArtifacts(runId); }
}
