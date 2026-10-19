import { RunControlsSummary } from "../experiments/RunControlsFields";
import React, { useEffect, useRef, useState } from "react";
import { latencyOf, latencySummary } from "../../shared/latency";
import { getHistory, getHistoryDetail } from "../../shared/control-ui-client";
import { FieldHelp } from "../../shared/FieldHelp";
import { WorkflowState } from "../../shared/workflow-state";

type HistoryFilters = Record<
  "status" | "scenario" | "workload" | "image" | "parameter" | "repetition" | "from" | "to",
  string
>;
const emptyFilters = (): HistoryFilters => ({
  status: "",
  scenario: "",
  workload: "",
  image: "",
  parameter: "",
  repetition: "",
  from: "",
  to: ""
});

export function HistoryPage() {
  const [items, setItems] = useState([] as any[]);
  const [status, setStatus] = useState("");
  const [scenario, setScenario] = useState("");
  const [workload, setWorkload] = useState("");
  const [image, setImage] = useState("");
  const [parameter, setParameter] = useState("");
  const [repetition, setRepetition] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters() as HistoryFilters);
  const [nextPageToken, setNextPageToken] = useState(undefined as string | undefined);
  const [selected, setSelected] = useState(undefined as any);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const requestEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const hasFilters = Object.values(appliedFilters).some(Boolean);

  const refresh = (pageToken?: string, append = false, filters = appliedFilters) => {
    const requestId = ++requestEpoch.current;
    setError("");
    if (!append) setLoading(true);
    const query = new URLSearchParams(
      Object.entries({ ...filters, pageToken }).filter(([, value]) => Boolean(value)) as string[][]
    ).toString();
    void getHistory(query)
      .then((value) => {
        if (requestId !== requestEpoch.current) return;
        setItems((current) =>
          append ? [...current, ...(value.items ?? [])] : (value.items ?? [])
        );
        setNextPageToken(value.nextPageToken);
      })
      .catch((reason) => {
        if (requestId === requestEpoch.current) setError(reason.message);
      })
      .finally(() => {
        if (requestId === requestEpoch.current) setLoading(false);
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  const applyFilters = () => {
    const next = { status, scenario, workload, image, parameter, repetition, from, to };
    setAppliedFilters(next);
    setNextPageToken(undefined);
    refresh(undefined, false, next);
  };

  const open = (item: any) => {
    const requestId = ++detailEpoch.current;
    setSelectedId(item.id);
    setDetailError("");
    setDetailLoading(true);
    void getHistoryDetail(item.id)
      .then((value) => {
        if (requestId === detailEpoch.current) setSelected(value);
      })
      .catch((reason) => {
        if (requestId === detailEpoch.current) setDetailError(reason.message);
      })
      .finally(() => {
        if (requestId === detailEpoch.current) setDetailLoading(false);
      });
  };
  const clearFilters = () => {
    setStatus("");
    setScenario("");
    setWorkload("");
    setImage("");
    setParameter("");
    setRepetition("");
    setFrom("");
    setTo("");
    const next = emptyFilters();
    setAppliedFilters(next);
    setNextPageToken(undefined);
    refresh(undefined, false, next);
  };
  const selectedInputs = selected?.experiment?.inputs ?? {};
  const hasRunEvidence = (selected?.artifacts ?? []).some(
    (artifact: any) => artifact.kind === "run_evidence"
  );
  const input = (
    label: string,
    value: string,
    setValue: (value: string) => void,
    placeholder: string
  ) => (
    <label>
      <span>
        {label}{" "}
        <FieldHelp label={label}>Use this filter to narrow the retained run history.</FieldHelp>
      </span>
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );

  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">REVIEW / HISTORY</p>
          <h1>Run history</h1>
          <p>Every terminal result remains searchable with its evidence classification.</p>
        </div>
      </header>
      <section className="panel history-filters" aria-label="History filters">
        <div className="filter-bar">
          <label>
            <span>
              Outcome{" "}
              <FieldHelp label="Outcome">
                Filter terminal runs by their recorded lifecycle outcome.
              </FieldHelp>
            </span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All terminal outcomes</option>
              <option>SUCCEEDED</option>
              <option>THRESHOLD_FAILED</option>
              <option>FAILED</option>
              <option>CANCELLED</option>
              <option>INCOMPLETE</option>
              <option>INTERRUPTED</option>
            </select>
          </label>
          {input("Scenario filter", scenario, setScenario, "Scenario@version")}
          {input("Workload filter", workload, setWorkload, "Workload path or id")}
          {input("Image filter", image, setImage, "Image reference")}
          {input(
            "Parameter filter",
            parameter,
            setParameter,
            "-B=500 or network.databaseLatencyMs=20"
          )}
          {input("Repetition filter", repetition, setRepetition, "Repetition")}
          <label>
            <span>
              From{" "}
              <FieldHelp label="From">
                Only include runs updated on or after this timestamp.
              </FieldHelp>
            </span>
            <input
              type="datetime-local"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            <span>
              To{" "}
              <FieldHelp label="To">
                Only include runs updated on or before this timestamp.
              </FieldHelp>
            </span>
            <input
              type="datetime-local"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <button type="button" onClick={applyFilters}>
            Apply filters
          </button>
          <button type="button" className="button secondary" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </section>
      {loading && <WorkflowState state="loading" message="Loading run history…" />}
      {error && (
        <WorkflowState state="error" message={error} action="Retry" onAction={() => refresh()} />
      )}
      <section className="card-grid">
        <section className="panel">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Scenario</th>
                <th>Workload</th>
                <th>Outcome</th>
                <th>Evidence</th>
                <th>Dashboard</th>
                <th>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} onClick={() => open(item)}>
                  <td className="mono">
                    {item.name ?? item.id}
                    {item.name && <small className="run-identity">{item.id}</small>}
                  </td>
                  <td>
                    {item.scenario?.id}@{item.scenario?.version}
                  </td>
                  <td>{item.workload?.operations?.[0]?.path ?? "—"}</td>
                  <td>
                    <span className={`status ${String(item.status).toLowerCase()}`}>
                      {item.status}
                    </span>
                  </td>
                  <td>{item.evidence?.cleanupStatus ?? "—"}</td>
                  <td>
                    {item.dashboardContextId && (
                      <a
                        href={`#dashboards/${item.dashboardContextId}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        Open dashboard
                      </a>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label={`Inspect ${item.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        open(item);
                      }}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !error && !items.length && (
            <WorkflowState
              state={hasFilters ? "no-match" : "empty"}
              message={hasFilters ? "No runs match these filters." : "No run history yet."}
              action={hasFilters ? "Clear filters" : "Refresh history"}
              onAction={hasFilters ? clearFilters : () => refresh()}
            />
          )}
          {nextPageToken && (
            <button onClick={() => refresh(nextPageToken, true)}>Load more history</button>
          )}
        </section>
        <aside className="panel">
          <h2>Evidence detail</h2>
          {detailLoading && <WorkflowState state="loading" message="Loading run evidence…" />}
          {detailError && (
            <WorkflowState
              state="error"
              message={detailError}
              action="Retry"
              onAction={() => selectedId && open({ id: selectedId })}
            />
          )}
          {selected ? (
            <>
              <p className="mono">{selected.run?.name ?? selected.run?.id}</p>
              {selected.run?.name && <small className="run-identity">{selected.run.id}</small>}
              <p>State: {selected.run?.state}</p>
              <p>Measurement: {selected.run?.measurementValidity}</p>
              <p>Cleanup: {selected.run?.cleanupStatus}</p>
              <p>
                Measurement completeness:{" "}
                {selected.run?.completeness?.complete ? "complete" : "incomplete"}
                {selected.run?.completeness?.requiredGaps?.length
                  ? ` — ${selected.run.completeness.requiredGaps.length} required gaps`
                  : ""}
              </p>
              {selected.run?.summary?.requests?.completed !== undefined && (
                <p>{selected.run.summary.requests.completed} completed requests</p>
              )}
              <p>Lifecycle events: {selected.events?.length ?? 0}</p>
              <section aria-label="Selected run inputs">
                <h3>Selected inputs</h3>
                <p>Database image: {selectedInputs.databaseImage ?? "not recorded"}</p>
                <p>PAS image: {selectedInputs.pasImage ?? "not recorded"}</p>
                {selectedInputs.seed && <p>Seed: selected local input</p>}
                {selectedInputs.applicationArchive && (
                  <p>Application archive: selected local input</p>
                )}
              </section>
              {selected.run?.effectiveConfiguration && (
                <section aria-label="Effective configuration">
                  <h3>Effective configuration</h3>
                  <dl className="details">
                    {Object.entries(selected.run.effectiveConfiguration).map(([key, value]) => (
                      <React.Fragment key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </section>
              )}
              {selected.run && (
                <section aria-label="Database latency">
                  <h3>Database latency</h3>
                  <p>
                    {latencySummary(
                      latencyOf(
                        selected.run.effectiveConfiguration ??
                          selected.run.environmentSnapshot?.effectiveConfiguration
                      ),
                      selected.run.environmentSnapshot?.databaseLatency
                    )}
                  </p>
                  {selected.run.environmentSnapshot?.databaseLatency?.probe && (
                    <p>
                      Probe round trip:{" "}
                      {selected.run.environmentSnapshot.databaseLatency.probe.baselineRttMs.toFixed(
                        2
                      )}{" "}
                      ms
                      {" → "}
                      {selected.run.environmentSnapshot.databaseLatency.probe.measuredRttMs.toFixed(
                        2
                      )}{" "}
                      ms
                    </p>
                  )}
                  {selected.run.environmentSnapshot?.databaseLatency?.failureCode && (
                    <p role="alert">
                      {selected.run.environmentSnapshot.databaseLatency.failureCode}
                    </p>
                  )}
                </section>
              )}
              {selected.run?.environmentSnapshot?.databaseStartup && (
                <section aria-label="Database startup settings">
                  <h3>Database startup settings</h3>
                  <p>
                    startup.pf:{" "}
                    {selected.run.environmentSnapshot.databaseStartup.startupFile?.status}
                  </p>
                  <p>
                    Catalog:{" "}
                    {selected.run.environmentSnapshot.databaseStartup.registryVersion ??
                      "Retained v1 metadata"}
                    . Unverified values retain their requested configuration and native startup
                    logs.
                  </p>
                  <dl className="details">
                    {(selected.run.environmentSnapshot.databaseStartup.parameters ?? []).map(
                      (item: any) => (
                        <React.Fragment key={item.name}>
                          <dt>{item.name}</dt>
                          <dd>
                            {item.displayValue} ({item.source};{" "}
                            {item.verification === "unverifiable"
                              ? "unverified"
                              : item.verification}
                            ){item.observedValue != null ? `; observed ${item.observedValue}` : ""}
                            {item.reason ? `; ${item.reason}` : ""}
                            {item.sourceReference ? `; ${item.sourceReference}` : ""}
                          </dd>
                        </React.Fragment>
                      )
                    )}
                  </dl>
                </section>
              )}
              {selected.run?.environmentSnapshot?.databaseRunControls && (
                <section aria-label="Database run controls">
                  <h3>Database run controls</h3>
                  <RunControlsSummary
                    controls={selected.run.environmentSnapshot.databaseRunControls}
                    evidence={selected.run.environmentSnapshot.databaseRunControlEvidence}
                  />
                  {selected.run.environmentSnapshot.databaseRunControlEvidence && (
                    <dl className="details">
                      <dt>Verification</dt>
                      <dd>
                        {selected.run.environmentSnapshot.databaseRunControlEvidence.verification}
                      </dd>
                      <dt>Writer health</dt>
                      <dd>
                        {selected.run.environmentSnapshot.databaseRunControlEvidence.writerHealth}
                      </dd>
                      <dt>Observed BI cluster</dt>
                      <dd>
                        {selected.run.environmentSnapshot.databaseRunControlEvidence.observed
                          ? `${selected.run.environmentSnapshot.databaseRunControlEvidence.observed.nativeClusterKiB / 1024} MiB`
                          : "Unavailable"}
                      </dd>
                      <dt>Captured</dt>
                      <dd>
                        {selected.run.environmentSnapshot.databaseRunControlEvidence.capturedAt}
                      </dd>
                      <dt>Preparation</dt>
                      <dd>
                        {selected.run.environmentSnapshot.databaseRunControlEvidence.preparation
                          ?.status ?? "unavailable"}
                      </dd>
                      <dt>Reason</dt>
                      <dd>
                        {selected.run.environmentSnapshot.databaseRunControlEvidence.reason ||
                          "Matched requested configuration"}
                      </dd>
                    </dl>
                  )}
                </section>
              )}
              {selected.run?.phaseBoundaries && (
                <section aria-label="Run phases">
                  <h3>Run phases</h3>
                  <dl className="details">
                    {Object.entries(selected.run.phaseBoundaries).map(
                      ([phase, boundary]: [string, any]) => (
                        <React.Fragment key={phase}>
                          <dt>{phase}</dt>
                          <dd>
                            {boundary.startedAt ?? "start unavailable"} →{" "}
                            {boundary.endedAt ?? "in progress"}
                          </dd>
                        </React.Fragment>
                      )
                    )}
                  </dl>
                </section>
              )}
              <h3>Artifacts</h3>
              <ul>
                {(selected.artifacts ?? []).map((artifact: any) => (
                  <li key={artifact.id}>
                    <a href={artifact.downloadUrl}>{artifact.kind} artifact</a>
                  </li>
                ))}
              </ul>
              <a href={`#runs/${selected.run?.id}`}>Open live/detail view</a>
              <h3>Dashboards</h3>
              {(selected.dashboardContexts ?? []).length ? (
                <ul>
                  {selected.dashboardContexts.map((context: any) => (
                    <li key={context.id}>
                      <a href={`#dashboards/${context.id}`}>Open dashboard {context.id}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No dashboard contexts were saved for this run.</p>
              )}
            </>
          ) : (
            <p className="muted">Select a historical run.</p>
          )}
        </aside>
      </section>
    </main>
  );
}
