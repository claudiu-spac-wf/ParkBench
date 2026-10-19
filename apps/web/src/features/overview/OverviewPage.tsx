import React, { useEffect, useRef, useState } from "react";
import { getOverview, getCatalogAction, startCatalogAction } from "../../shared/control-ui-client";
import { WorkflowState } from "../../shared/workflow-state";

export function OverviewPage() {
  const [overview, setOverview] = useState(undefined as any);
  const [error, setError] = useState("");
  const [archiveName, setArchiveName] = useState("");
  const [action, setAction] = useState(undefined as any);
  const [actionPending, setActionPending] = useState(false);
  const requestId = useRef(0);
  const pollPending = useRef(false);
  const refresh = (silent = false) => {
    if (silent && pollPending.current) return;
    const currentRequest = ++requestId.current;
    if (silent) pollPending.current = true;
    else setError("");
    void getOverview()
      .then((value) => {
        if (currentRequest === requestId.current) setOverview(value);
      })
      .catch((reason) => {
        if (currentRequest === requestId.current) setError((current) => current || reason.message);
      })
      .finally(() => {
        if (silent) pollPending.current = false;
      });
  };
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!action?.id || !["PENDING", "RUNNING"].includes(action.state)) return;
    const timer = window.setInterval(
      () =>
        void getCatalogAction(action.id)
          .then((next) => {
            setAction(next);
            if (!["PENDING", "RUNNING"].includes(next.state)) refresh();
          })
          .catch((reason) => setError(reason.message)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [action?.id, action?.state]);
  const runAction = (kind: "VERIFY_SCENARIOS" | "COMPILE_WORKLOADS" | "REBUILD_ARCHIVE") => {
    setActionPending(true);
    setError("");
    void startCatalogAction(kind, kind === "REBUILD_ARCHIVE" ? archiveName : undefined)
      .then(setAction)
      .catch((reason) => setError(reason.message))
      .finally(() => setActionPending(false));
  };
  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERATE / OVERVIEW</p>
          <h1>ParkBench control center</h1>
          <p>
            Check dependencies, discover inputs, and move from a scheduled matrix to evidence-backed
            results.
          </p>
        </div>
        <button type="button" onClick={() => refresh()}>
          Refresh
        </button>
      </header>
      {error && (
        <WorkflowState state="error" message={error} action="Retry" onAction={() => refresh()} />
      )}
      {!overview && !error && <WorkflowState state="loading" message="Loading control center…" />}
      {overview && (
        <>
          <section className="panel overview-actions" aria-label="Primary actions">
            <h2>Go to a workflow</h2>
            <div className="quick-action-grid">
              <a className="button secondary" href="#catalog">
                Browse assets
              </a>
              <a className="button secondary" href="#experiments">
                Schedule an experiment
              </a>
              <a className="button secondary" href="#queue">
                Manage queue
              </a>
              <a className="button secondary" href="#comparison">
                Review comparisons
              </a>
              <a className="button secondary" href="#history">
                View history
              </a>
            </div>
          </section>
          <section className="panel" aria-label="Bulk catalog actions">
            <h2>Prepare managed inputs</h2>
            <div className="button-row">
              <button
                type="button"
                disabled={actionPending || ["PENDING", "RUNNING"].includes(action?.state)}
                onClick={() => runAction("VERIFY_SCENARIOS")}
              >
                Verify all scenarios
              </button>
              <button
                type="button"
                disabled={actionPending || ["PENDING", "RUNNING"].includes(action?.state)}
                onClick={() => runAction("COMPILE_WORKLOADS")}
              >
                Compile all workloads
              </button>
            </div>
            <label>
              <span>Archive name</span>
              <input
                aria-label="Archive name"
                value={archiveName}
                onChange={(event) => setArchiveName(event.target.value)}
                placeholder="my-benchmark"
              />
            </label>
            <button
              type="button"
              disabled={
                actionPending ||
                !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(archiveName) ||
                ["PENDING", "RUNNING"].includes(action?.state)
              }
              onClick={() => runAction("REBUILD_ARCHIVE")}
            >
              Rebuild archive
            </button>
            {action && (
              <div className="operation" role="status">
                <p>
                  {action.kind}: {action.state} · {action.results?.length ?? 0} files checked
                </p>
                {action.outputArchive && <p>Published: {action.outputArchive}</p>}
                {action.state === "PARTIAL" && (
                  <p className="notice warning">The archive contains successful workloads only.</p>
                )}
                {action.error && <p className="error">{action.error.message}</p>}
                {(action.results ?? []).map((item: any) => (
                  <p key={item.path}>
                    {item.path}: {item.state}
                    {item.message ? ` — ${item.message}` : ""}
                  </p>
                ))}
              </div>
            )}
          </section>
          <section className="overview-grid">
            {Object.entries(overview.health ?? {})
              .filter(([key]) => key !== "checkedAt")
              .map(([key, value]) => (
                <article className="panel health-card" key={key}>
                  <small>{key}</small>
                  <strong className={`status ${String(value)}`}>{String(value)}</strong>
                </article>
              ))}
            <article className="panel health-card">
              <small>Last health check</small>
              <strong>{overview.health?.checkedAt ?? "—"}</strong>
            </article>
          </section>
          <section className="card-grid overview-sections">
            <section className="panel">
              <div className="panel-heading">
                <h2>Catalog discovery</h2>
                <a href="#catalog">Open catalog</a>
              </div>
              <div className="overview-category-grid">
                {(overview.discovery?.categories ?? [])
                  .filter((category: any) => category.key !== "observers")
                  .map((category: any) => (
                    <div key={category.key} className="overview-category">
                      <strong>{category.label}</strong>
                      <span>
                        {category.readyCount}/{category.count} ready
                      </span>
                      <small>{category.sourceState.toLowerCase()}</small>
                    </div>
                  ))}
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Queue</h2>
                <a href="#queue">Manage queue</a>
              </div>
              <p>
                Active experiment:{" "}
                <span className="mono">{overview.queue?.activeExperiment ?? "none"}</span>
              </p>
              <p>
                {overview.queue?.running ?? 0} running · {overview.queue?.queued ?? 0} queued ·{" "}
                {overview.queue?.blocked ?? 0} blocked
              </p>
              <p>Next retry: {overview.queue?.nextRetryAt ?? "none"}</p>
            </section>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Recent runs</h2>
              <a href="#history">View history</a>
            </div>
            {(overview.recentRuns ?? []).length ? (
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Experiment</th>
                    <th>State</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentRuns.map((run: any) => (
                    <tr key={run.id}>
                      <td className="mono">
                        <a href={`#runs/${run.id}`}>{run.name ?? run.id}</a>
                      </td>
                      <td className="mono">{run.experimentId}</td>
                      <td>
                        <span className={`status ${String(run.state).toLowerCase()}`}>
                          {run.state}
                        </span>
                      </td>
                      <td>{run.updatedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <WorkflowState
                state="empty"
                message="No terminal runs yet. Schedule a matrix to begin."
                action="Schedule a run"
                onAction={() => {
                  window.location.hash = "experiments";
                }}
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
