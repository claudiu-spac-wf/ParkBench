import React, { useEffect, useRef, useState } from "react";
import { cancelRun, getEvents, getMetrics, getRun } from "./monitoringApi";
import { DashboardPanel } from "../dashboards/DashboardPanel";
import { WorkflowState } from "../../shared/workflow-state";

type SourceState = { stale: boolean; error?: string; asOf?: number };

export function ActiveRunPage({ runId }: { runId: string }) {
  const [run, setRun] = useState(undefined as any);
  const [metrics, setMetrics] = useState({ samples: [], summaries: [], stale: false } as any);
  const [events, setEvents] = useState([] as any[]);
  const [sources, setSources] = useState({
    status: { stale: true },
    metrics: { stale: true },
    events: { stale: true }
  } as Record<string, SourceState>);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const latestEvent = useRef(0 as number);

  useEffect(() => {
    latestEvent.current = 0;
    setEvents([]);
    setRun(undefined);
  }, [runId]);

  useEffect(() => {
    let disposed = false;
    let eventPollPending = false;
    let statusPollPending = false;
    let metricsPollPending = false;
    let terminalSeen = false;
    let timer = 0;
    let clockTimer = 0;
    const mark = (source: string, state: SourceState) => {
      if (!disposed) setSources((current) => ({ ...current, [source]: state }));
    };
    const pollStatus = () => {
      if (statusPollPending || terminalSeen) return;
      statusPollPending = true;
      void getRun(runId)
        .then((nextRun) => {
          if (disposed) return;
          setRun(nextRun);
          mark("status", { stale: false, asOf: Date.now() });
          if (
            [
              "SUCCEEDED",
              "INCOMPLETE",
              "THRESHOLD_FAILED",
              "FAILED",
              "CANCELLED",
              "INTERRUPTED"
            ].includes(nextRun.state) &&
            ["COMPLETE", "PARTIAL", "FAILED"].includes(nextRun.cleanupStatus)
          ) {
            terminalSeen = true;
            window.clearInterval(timer);
            window.clearInterval(clockTimer);
          }
        })
        .catch((error) => mark("status", { stale: true, error: error.message }))
        .finally(() => {
          statusPollPending = false;
        });
    };
    const pollMetrics = () => {
      if (metricsPollPending || terminalSeen) return;
      metricsPollPending = true;
      void getMetrics(runId)
        .then((nextMetrics) => {
          if (disposed) return;
          setMetrics((current: any) => ({
            ...current,
            ...nextMetrics,
            stale: Boolean(nextMetrics.stale)
          }));
          mark("metrics", { stale: Boolean(nextMetrics.stale), asOf: Date.now() });
        })
        .catch((error) => mark("metrics", { stale: true, error: error.message }))
        .finally(() => {
          metricsPollPending = false;
        });
    };
    const pollEvents = () => {
      if (eventPollPending || terminalSeen) return;
      eventPollPending = true;
      void getEvents(runId, latestEvent.current)
        .then((nextEvents) => {
          if (disposed) return;
          setEvents((current) => {
            const seen = new Set(
              current
                .map((event: any) => event.id ?? event.eventId)
                .filter((id: any) => id !== undefined)
            );
            const added = (nextEvents.events ?? []).filter((event: any) => {
              const id = event.id ?? event.eventId;
              if (id === undefined) return true;
              if (seen.has(id)) return false;
              seen.add(id);
              return true;
            });
            return [...current, ...added];
          });
          latestEvent.current = Math.max(latestEvent.current, nextEvents.latestEventId ?? 0);
          mark("events", { stale: false, asOf: Date.now() });
        })
        .catch((error) => mark("events", { stale: true, error: error.message }))
        .finally(() => {
          eventPollPending = false;
        });
    };
    const poll = () => {
      pollStatus();
      pollMetrics();
      pollEvents();
    };
    poll();
    timer = window.setInterval(poll, 2000);
    clockTimer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearInterval(clockTimer);
    };
  }, [runId, refreshEpoch]);

  const elapsed = run?.startedAt
    ? Math.max(0, Math.floor((clock - Date.parse(run.startedAt)) / 1000))
    : 0;
  const health = metrics.health ?? run?.health;
  const completeness = run?.completeness ?? health?.completeness;
  const terminal = [
    "SUCCEEDED",
    "INCOMPLETE",
    "THRESHOLD_FAILED",
    "FAILED",
    "CANCELLED",
    "INTERRUPTED"
  ].includes(run?.state);
  const displayedPhase =
    terminal && run?.cleanupStatus === "COMPLETE"
      ? run.state.toLowerCase()
      : (run?.phase ?? "unknown");
  const cancel = () => {
    if (cancelling) return;
    setCancelError("");
    setCancelling(true);
    void cancelRun(runId)
      .catch((error) => setCancelError(error.message))
      .finally(() => setCancelling(false));
  };
  const evidence = run?.evidence ?? {};

  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERATE / RUN</p>
          <h1>Run {run?.name ?? runId}</h1>
          {run?.name && <small className="run-identity">{runId}</small>}
          <p>
            Independent status, metric, and event reads preserve last-known values when a source is
            stale.
          </p>
        </div>
      </header>
      <section className="panel">
        {!run && !sources.status.error && (
          <WorkflowState state="loading" message="Loading run status…" />
        )}
        {!run && sources.status.error && (
          <WorkflowState
            state="unavailable"
            message={`Run status unavailable: ${sources.status.error}`}
            action="Retry live data"
            onAction={() => setRefreshEpoch((current) => current + 1)}
          />
        )}
        <h2>Run status</h2>
        <p>State: {run?.state ?? (sources.status.error ? "unavailable" : "loading")}</p>
        {run?.failureReason && <p className="notice error">Failure: {run.failureReason}</p>}
        <p>Measurement validity: {run?.measurementValidity ?? "pending"}</p>
        <p>
          Measurement completeness:{" "}
          {completeness?.complete ? "complete" : completeness ? "incomplete" : "pending"}
          {completeness?.requiredGaps?.length
            ? ` — ${completeness.requiredGaps.length} required gaps`
            : ""}
        </p>
        <p>
          Phase: {displayedPhase}
          {run?.progress?.percent !== undefined ? ` — ${run.progress.percent}%` : ""}
        </p>
        {typeof run?.progress?.percent === "number" && (
          <progress aria-label="Run progress" max="100" value={run.progress.percent} />
        )}
        <p>Elapsed: {elapsed}s</p>
        <p>Cleanup: {run?.cleanupStatus ?? (terminal ? "unknown" : "pending")}</p>
        <p>
          Live measurements: {metrics.samples?.length ?? 0} samples · {events.length} events
        </p>
        <div className="source-status" aria-label="Live source status">
          {(Object.entries(sources) as Array<[string, SourceState]>).map(([source, state]) => (
            <span key={source} className={state.stale ? "status stale" : "status healthy"}>
              {source}: {state.stale ? `stale${state.error ? ` (${state.error})` : ""}` : "fresh"}
            </span>
          ))}
        </div>
        {(run || !sources.status.error) &&
          Object.values(sources as Record<string, SourceState>).some((source) => source.stale) && (
            <WorkflowState
              state="stale"
              message="Some live sources are stale. Last-known run, metric, and event data remain visible."
              action="Retry live data"
              onAction={() => setRefreshEpoch((current) => current + 1)}
            />
          )}
      </section>
      <section aria-label="Live service health" className="panel">
        <h2>Live service health: {health?.status ?? "unknown"}</h2>
        {Object.entries(health?.services ?? {}).map(([service, value]: [string, any]) => (
          <article className="health-card" key={service}>
            <strong>{service}</strong>: {value.status}
            {value.asOf && <small> ({value.asOf})</small>}
          </article>
        ))}
        <p>
          Latest event: {health?.latestEventAt ?? "unknown"} (#{health?.latestEventId ?? 0})
        </p>
        {health?.completeness && (
          <p>
            Measurement completeness:{" "}
            {health.completeness.complete
              ? "complete"
              : `incomplete — ${health.completeness.requiredGaps?.length ?? 0} required gaps`}
          </p>
        )}
      </section>
      {run?.observerHealth && (
        <details className="panel">
          <summary>Observer diagnostics</summary>
          <pre>{JSON.stringify(run.observerHealth, null, 2)}</pre>
        </details>
      )}
      <section className="panel">
        <h2>Measurements</h2>
        {(metrics.samples ?? []).slice(0, 12).map((sample: any, index: number) => (
          <div key={`${sample.metricName}-${index}`}>
            {sample.metricName}: {sample.value}
          </div>
        ))}
        {!metrics.samples?.length && (
          <p className="muted">
            No live measurements available; missing values are not shown as zero.
          </p>
        )}
      </section>
      {run && !terminal && (
        <button type="button" onClick={cancel} disabled={cancelling}>
          {cancelling ? "Cancelling…" : "Cancel run"}
        </button>
      )}
      {cancelError && (
        <WorkflowState
          state="error"
          message={cancelError}
          action="Retry cancel"
          onAction={cancel}
        />
      )}
      {terminal && (
        <section className="panel">
          <h2>Terminal evidence</h2>
          <p>Measurement quality: {run.measurementValidity}</p>
          <ul>
            {(evidence.links ?? []).map((link: any) => (
              <li key={link.url}>
                <a href={link.url}>{link.label}</a>
              </li>
            ))}
          </ul>
          {run.experimentId && <a href={`#comparison/${run.experimentId}`}>Open comparison</a>}
          <a href="#history">View run history</a>
        </section>
      )}
      {run?.dashboardContext?.id && <DashboardPanel contextId={run.dashboardContext.id} />}
    </main>
  );
}
