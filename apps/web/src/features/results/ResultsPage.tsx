import React, { useEffect, useState } from "react";
import { getArtifacts, getComparison, getRuns } from "./resultsApi";
import { ComparisonView } from "./ComparisonView";
export function ResultsPage({ experimentId, runId }: { experimentId?: string; runId?: string }) {
  const [comparison, setComparison] = useState();
  const [artifacts, setArtifacts] = useState([]);
  const [runArtifacts, setRunArtifacts] = useState([]);
  useEffect(() => {
    setComparison(undefined);
    setArtifacts([]);
    setRunArtifacts([]);
    if (experimentId) {
      void getComparison(experimentId)
        .then(setComparison)
        .catch(() => undefined);
      void getRuns(experimentId)
        .then(async (result) => {
          const runs = runId
            ? (result.runs ?? []).filter((run: any) => run.id === runId)
            : (result.runs ?? []);
          const collected = await Promise.all(
            runs.map(async (run: any) => ({
              runId: run.id,
              artifacts: (await getArtifacts(run.id)).artifacts ?? []
            }))
          );
          setRunArtifacts(
            collected.flatMap((item) =>
              item.artifacts.map((artifact: any) => ({ ...artifact, runId: item.runId }))
            )
          );
        })
        .catch(() => undefined);
    } else if (runId) {
      void getArtifacts(runId)
        .then((result) => setArtifacts(result.artifacts ?? []))
        .catch(() => undefined);
    }
  }, [experimentId, runId]);
  return (
    <main className="results">
      <h1>Results</h1>
      {comparison && experimentId ? (
        <ComparisonView experimentId={experimentId} />
      ) : (
        <p>Select an experiment to compare.</p>
      )}
      <a href="#history">Run history</a>
      {(artifacts.length > 0 || runArtifacts.length > 0) && (
        <ul>
          {[...artifacts, ...runArtifacts].map((artifact) => (
            <li key={artifact.id}>
              {artifact.runId && <span>{artifact.runId}: </span>}
              <a href={artifact.downloadUrl} download>
                {artifact.kind}
              </a>{" "}
              ({artifact.sizeBytes} bytes)
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
