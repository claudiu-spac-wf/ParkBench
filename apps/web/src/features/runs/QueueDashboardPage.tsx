import { RunControlsSummary } from "../experiments/RunControlsFields";
import React, { useEffect, useRef, useState } from "react";
import { latencyOf } from "../../shared/latency";
import { cancelControlRun, getQueue, startQueue } from "../../shared/control-ui-client";
import { WorkflowState } from "../../shared/workflow-state";

export function QueueDashboardPage() {
  const [queue, setQueue] = useState({ items: [] } as any);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [startPending, setStartPending] = useState(false);
  const [cancelPending, setCancelPending] = useState([] as string[]);
  const [errorAction, setErrorAction] = useState("refresh" as "refresh" | "start" | "cancel");
  const [failedCancelId, setFailedCancelId] = useState("");
  const requestId = useRef(0);
  const pollPending = useRef(false);
  const startInFlight = useRef(false);
  const cancelInFlight = useRef(new Set<string>());
  const refresh = (silent = false) => {
    if (silent && pollPending.current) return;
    const currentRequest = ++requestId.current;
    if (silent) pollPending.current = true;
    if (!silent) {
      setLoading(true);
      setError("");
      setErrorAction("refresh");
    }
    void getQueue()
      .then((value) => {
        if (currentRequest === requestId.current) setQueue(value);
      })
      .catch((reason) => {
        if (currentRequest === requestId.current) setError((current) => current || reason.message);
      })
      .finally(() => {
        if (currentRequest === requestId.current) setLoading(false);
        if (silent) pollPending.current = false;
      });
  };
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(true), 2000);
    return () => window.clearInterval(timer);
  }, []);
  const start = () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setError("");
    setStartPending(true);
    void startQueue()
      .then(() => refresh())
      .catch((reason) => {
        setError(reason.message);
        setErrorAction("start");
      })
      .finally(() => {
        startInFlight.current = false;
        setStartPending(false);
      });
  };
  const cancel = (id: string) => {
    if (cancelInFlight.current.has(id) || !window.confirm(`Cancel run ${id}?`)) return;
    cancelInFlight.current.add(id);
    setCancelPending((current) => [...current, id]);
    void cancelControlRun(id)
      .then(() => refresh())
      .catch((reason) => {
        setError(reason.message);
        setErrorAction("cancel");
        setFailedCancelId(id);
      })
      .finally(() => {
        cancelInFlight.current.delete(id);
        setCancelPending((current) => current.filter((item) => item !== id));
      });
  };
  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERATE / QUEUE</p>
          <h1>Run queue</h1>
          <p>Queued, active, and blocked runs remain here until they finish.</p>
        </div>
        <div className="button-row">
          <button onClick={() => refresh()}>Refresh</button>
          <button onClick={start} disabled={startPending}>
            {startPending ? "Starting…" : "Start eligible work"}
          </button>
        </div>
      </header>
      {error && (
        <WorkflowState
          state="error"
          message={error}
          action={
            errorAction === "start"
              ? "Try again"
              : errorAction === "cancel"
                ? "Retry cancel"
                : "Retry"
          }
          onAction={
            errorAction === "start"
              ? start
              : errorAction === "cancel"
                ? () => cancel(failedCancelId)
                : refresh
          }
        />
      )}
      <section className="panel">
        {loading && <WorkflowState state="loading" message="Loading run queue…" />}
        {!loading && (
          <div className="queue-summary">
            <strong>
              {queue.activeExperiment
                ? `Active: ${queue.activeExperiment}`
                : "No active experiment"}
            </strong>
            <span>{queue.items?.length ?? 0} nonterminal runs</span>
          </div>
        )}
        <table aria-label="Nonterminal run activity">
          <thead>
            <tr>
              <th>Run</th>
              <th>Experiment</th>
              <th>Cell</th>
              <th>Database startup</th>
              <th>State</th>
              <th>Retry</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {(queue.items ?? []).map((run: any) => (
              <tr key={run.id}>
                <td className="mono">
                  <a href={`#runs/${run.id}`}>{run.name ?? run.id}</a>
                  {run.name && <small className="run-identity">{run.id}</small>}
                </td>
                <td className="mono">{run.experimentId}</td>
                <td>
                  {run.cellOrdinal} / r{run.repetition}
                </td>
                <td>
                  {(run.snapshot?.databaseStartup?.parameters ?? [])
                    .map((item: any) => `${item.name}=${item.displayValue} (${item.source})`)
                    .join(", ") || "Database defaults"}
                  <RunControlsSummary
                    controls={run.snapshot?.databaseRunControls}
                    evidence={run.databaseRunControlEvidence}
                  />
                  {latencyOf(run.snapshot?.parameters ?? run.effectiveConfiguration) > 0 && (
                    <span className="status">
                      Latency {latencyOf(run.snapshot?.parameters ?? run.effectiveConfiguration)} ms
                    </span>
                  )}
                </td>
                <td>
                  <span className={`status ${String(run.queueState).toLowerCase()}`}>
                    {run.queueState}
                  </span>
                  {run.blockedReason && <small>{run.blockedReason}</small>}
                </td>
                <td>
                  {run.nextRetryAt ?? "—"} ({run.retryCount ?? 0})
                </td>
                <td>
                  <a href={`#runs/${run.id}`}>Monitor</a>
                  {run.experimentId && (
                    <a href={`#comparison/${run.experimentId}`}>Compare experiment</a>
                  )}
                  {run.queueState !== "CANCELLED" && (
                    <button
                      className="button secondary"
                      onClick={() => cancel(run.id)}
                      disabled={cancelPending.includes(run.id)}
                    >
                      {cancelPending.includes(run.id) ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && !(queue.items ?? []).length && (
          <WorkflowState
            state="empty"
            message="The queue is empty. Preview a matrix to schedule work."
            action="Schedule a run"
            onAction={() => {
              window.location.hash = "experiments";
            }}
          />
        )}
      </section>
    </main>
  );
}
