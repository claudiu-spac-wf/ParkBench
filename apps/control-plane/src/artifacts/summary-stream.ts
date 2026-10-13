import type { RunSummaryHeader } from "../../../../packages/contracts/src/run-summary";
import { Repositories } from "../db/repositories";
import { ArtifactStorage } from "./storage";
/** Private current-attempt iteration is the only source for a full summary writer. */
export function writeStagedSummary(
  storage: ArtifactStorage,
  repositories: Repositories,
  header: RunSummaryHeader,
  token: string,
  signal?: AbortSignal
) {
  repositories.assertSummaryAttempt(header.run.id, header.metricDefinitionsVersion, token);
  return storage.writeSummaryAttempt(
    header,
    repositories.iterateStagedSummaryRows(header.run.id, header.metricDefinitionsVersion, token),
    token,
    signal
  );
}
