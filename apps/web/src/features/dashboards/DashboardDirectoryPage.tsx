import React, { useEffect, useRef, useState } from "react";
import { getControlExperiments, getControlRun } from "../../shared/control-ui-client";
import { DashboardPanel } from "./DashboardPanel";
import { WorkflowState } from "../../shared/workflow-state";
import { experimentDisplayName } from "../../shared/experiment-label";

type DashboardEntry = {
  contextId: string;
  experimentId: string;
  experimentLabel: string;
  runIds: string[];
  runLabels: string[];
};

export function DashboardDirectoryPage({ contextId }: { contextId?: string }) {
  const [entries, setEntries] = useState([] as DashboardEntry[]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!contextId);
  const requestId = useRef(0);
  const loadEntries = () => {
    if (contextId) return;
    const currentRequest = ++requestId.current;
    setError("");
    setLoading(true);
    void getControlExperiments()
      .then(async (response) => {
        const experiments = response.items?.length ? response.items : response.experiments ?? [];
        const requested = experiments.flatMap((experiment: any) =>
          (experiment.runs ?? []).map((run: any) => ({ experimentId: experiment.id, experimentLabel: experimentDisplayName(experiment), runId: run.id, runLabel: run.name ?? run.id }))
        );
        const results = await Promise.allSettled(requested.map(async ({ experimentId, experimentLabel, runId, runLabel }: any) => ({
          experimentId, experimentLabel, runLabel,
          detail: await getControlRun(runId)
        })));
        const byContext = new Map<string, DashboardEntry>();
        if (currentRequest !== requestId.current) return;
        const missing = results.flatMap((result, index) => result.status === "rejected" ? [requested[index].runId] : []);
        if (missing.length) setError(`Run details unavailable for ${missing.join(", ")}. Retry to check missing dashboard contexts.`);
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { experimentId, experimentLabel, runLabel, detail } = result.value;
          const id = detail.dashboardContext?.id;
          if (!id) continue;
          const entry = byContext.get(id) ?? { contextId: id, experimentId, experimentLabel, runIds: [], runLabels: [] };
          entry.runIds.push(detail.id);
          entry.runLabels.push(runLabel);
          byContext.set(id, entry);
        }
        setEntries([...byContext.values()]);
      })
      .catch((reason) => {
        if (currentRequest === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (currentRequest === requestId.current) setLoading(false);
      });
  };

  useEffect(() => {
    loadEntries();
    return () => { requestId.current += 1; };
  }, [contextId]);

  if (contextId) {
    return (
      <main className="control-page">
        <header className="page-heading">
          <div>
            <p className="eyebrow">ANALYZE / DASHBOARDS</p>
            <h1>Dashboard {contextId}</h1>
            <p>Run metrics and summaries scoped to this saved dashboard context.</p>
          </div>
          <a className="button secondary" href="#history">Open run history</a>
        </header>
        <DashboardPanel contextId={contextId} />
      </main>
    );
  }

  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ANALYZE / DASHBOARDS</p>
          <h1>Run dashboards</h1>
          <p>Open saved metric views for experiments and their runs.</p>
        </div>
      </header>
      {error && (
        <WorkflowState
          state="error"
          message={error}
          action="Retry"
          onAction={loadEntries}
        />
      )}
      {loading ? (
        <WorkflowState state="loading" message="Loading dashboard contexts…" />
      ) : entries.length ? (
        <section className="panel">
          <h2>Available dashboards</h2>
          <table>
            <thead><tr><th>Experiment</th><th>Runs</th><th>Dashboard</th></tr></thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.contextId}>
                  <td><a href={`#comparison/${entry.experimentId}`}>{entry.experimentLabel}</a>{entry.experimentLabel !== entry.experimentId && <small className="run-identity">{entry.experimentId}</small>}</td>
                  <td>{entry.runLabels.join(", ")}</td>
                  <td><a href={`#dashboards/${entry.contextId}`}>Open dashboard {entry.contextId}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <WorkflowState
          state="empty"
          message="No dashboard contexts are available yet. Complete runs and create a comparison to save one."
          action="Open comparisons"
          onAction={() => { window.location.hash = "comparison"; }}
        />
      )}
    </main>
  );
}
