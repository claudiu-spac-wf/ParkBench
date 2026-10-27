import React, { useEffect, useState } from "react";
import {
  ReportMetadata,
  terminalReport
} from "../../../../../packages/contracts/src/database-analysis-report";
import { reportsApi } from "./reportsApi";
const ReportDatasetTable = React.lazy(() =>
  import("./ReportDatasetTable").then((m) => ({ default: m.ReportDatasetTable }))
);
import { ReportStorageCharts } from "./ReportStorageCharts";
import { ReportFindings } from "./ReportFindings";
import { ReportArtifactList } from "./ReportArtifactList";
import "./reports.css";
export function ReportDetailPage({
  reportId,
  query
}: {
  reportId: string;
  key?: string;
  query?: string;
}) {
  const sourceQuery = new URLSearchParams(query);
  const requestedView = sourceQuery.get("dataset") ?? sourceQuery.get("view") ?? "overview";
  const view = [
    "overview",
    "findings",
    "files",
    "chain",
    "index",
    "table",
    "block",
    "lob"
  ].includes(requestedView)
    ? requestedView
    : "overview";
  const [report, setReport] = useState(undefined as ReportMetadata | undefined),
    [summary, setSummary] = useState(undefined as any),
    [error, setError] = useState(""),
    [cancelError, setCancelError] = useState(""),
    [cancelling, setCancelling] = useState(false),
    [attempt, setAttempt] = useState(0),
    [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const c = new AbortController();
    setReport(undefined);
    setSummary(undefined);
    async function load() {
      try {
        const { report } = await reportsApi.detail(reportId, c.signal);
        if (stopped) return;
        setReport(report);
        setError("");
        if (!terminalReport(report.state)) timer = setTimeout(load, 2000);
      } catch (e) {
        if (!stopped) {
          setError((e as Error).message);
          timer = setTimeout(load, 2000);
        }
      }
    }
    void load();
    return () => {
      stopped = true;
      c.abort();
      clearTimeout(timer);
    };
  }, [reportId, attempt]);
  useEffect(() => {
    const c = new AbortController();
    if (report?.projectionRevision)
      reportsApi
        .result(reportId, "summary", c.signal)
        .then(setSummary)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    return () => c.abort();
  }, [reportId, report?.projectionRevision]);
  useEffect(() => {
    const update = () =>
      setElapsed(
        Math.max(
          0,
          Math.floor(
            ((report?.finishedAt ? Date.parse(report.finishedAt) : Date.now()) -
              Date.parse(report?.startedAt ?? report?.createdAt ?? new Date().toISOString())) /
              1000
          )
        )
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [report?.startedAt, report?.createdAt, report?.finishedAt]);
  async function cancel() {
    setCancelling(true);
    setCancelError("");
    try {
      setReport((await reportsApi.cancel(reportId)).report);
    } catch (e) {
      setCancelError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  }
  return (
    <main className="control-page reports-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">PARKBENCH / REPORTS</p>
          <h1>{report ? report.type + " report" : "Report"}</h1>
        </div>
        <div className="report-actions">
          <a href="#reports">All reports</a>
          <a
            href={
              report
                ? "#reports/help?" +
                  new URLSearchParams({
                    columnsVersion: report.columnsVersion,
                    rulesVersion: report.rulesVersion
                  })
                : "#reports/help"
            }
          >
            Report guide
          </a>
        </div>
      </header>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setAttempt((v) => v + 1)}>Retry report</button>
        </p>
      )}
      {!report ? (
        <p role="status">Loading report…</p>
      ) : (
        <>
          <section className="report-panel">
            <h2>Collection status</h2>
            <p role="status">
              <strong>{report.state}</strong>
              {report.cancelRequestedAt && !terminalReport(report.state) ? " · Cancelling" : ""}
              {report.cleanupState === "FAILED" ? " · Cleanup pending" : ""} · Elapsed {elapsed}s
            </p>
            <p>
              Reports take priority over waiting experiments. Active work finishes uninterrupted.
              There is no automatic time limit and no reliable progress percentage.
            </p>
            {!terminalReport(report.state) && (
              <button disabled={cancelling} onClick={cancel}>
                {cancelling
                  ? "Requesting cancellation…"
                  : report.cancelRequestedAt
                    ? "Retry cancellation"
                    : "Cancel report"}
              </button>
            )}
            {cancelError && <p role="alert">{cancelError}</p>}
            {report.cleanupState === "FAILED" && (
              <div role="status" className="report-warning">
                <p>
                  Capacity remains reserved. Pending outcome: {report.pendingTerminalState}. Next
                  automatic cleanup retry: {report.cleanupRetryAt}.
                </p>
                <p>
                  Cleanup retries five seconds after each failed attempt finishes, without a retry
                  cutoff. Recovery needs no controller restart.
                </p>
              </div>
            )}
            {report.failure && (
              <div role="alert">
                <h3>{report.failure.code}</h3>
                <p>
                  {report.failure.message}. {report.failure.correctiveAction}
                </p>
              </div>
            )}
            {report.warnings.length > 0 && (
              <aside>
                <h3>Execution warnings</h3>
                {report.warnings.map((w, i) => (
                  <p key={i}>
                    {w.code}: {w.message}. {w.correctiveAction}
                  </p>
                ))}
              </aside>
            )}
            <details>
              <summary>Historical collection provenance</summary>
              <dl className="report-provenance">
                <dt>Report ID</dt>
                <dd>{report.id}</dd>
                <dt>Seed / database</dt>
                <dd>
                  {report.seedSnapshot.name} / {report.seedSnapshot.databaseName}
                </dd>
                <dt>Seed on disk</dt>
                <dd>{report.seedSnapshot.path}</dd>
                <dt>Image / observed version</dt>
                <dd>
                  {report.executionSnapshot.image} /{" "}
                  {report.executionSnapshot.observedVersion ?? "Not observed"}
                </dd>
                <dt>Native options</dt>
                <dd>{report.executionSnapshot.options.join(" ")}</dd>
                <dt>Submitted / started / finished</dt>
                <dd>
                  {report.createdAt} / {report.startedAt ?? "Not started"} /{" "}
                  {report.finishedAt ?? "Not finished"}
                </dd>
                <dt>Retained versions</dt>
                <dd>
                  {report.parserVersion}; {report.columnsVersion}; {report.csvVersion};{" "}
                  {report.rulesVersion}
                </dd>
                <dt>Visualization</dt>
                <dd>{report.projectionState}</dd>
              </dl>
              <p>
                This retained evidence describes collection time; it does not establish the current
                seed contents.
              </p>
            </details>
          </section>
          <div className="report-view-selector">
            <label htmlFor="report-view">Report view</label>
            <select
              id="report-view"
              value={view}
              onChange={(e) => {
                window.location.hash = `#reports/${reportId}?view=${e.target.value}`;
              }}
            >
              <option value="overview">Full report overview</option>
              <option value="findings">Review findings</option>
              <option value="block">Block dataset</option>
              <option value="chain">Chain dataset</option>
              <option value="index">Index dataset</option>
              <option value="table">Table dataset</option>
              <option value="lob">LOB dataset</option>
              <option value="files">Files and downloads</option>
            </select>
          </div>
          {view === "files" && (
            <ReportArtifactList reportId={reportId} artifacts={report.artifacts} />
          )}
          {view === "overview" &&
            (summary ? (
              <ReportStorageCharts summary={summary} />
            ) : (
              <p>No published overview is available yet.</p>
            ))}
          {view === "findings" &&
            (report.projectionRevision ? (
              <ReportFindings key={report.projectionRevision} reportId={reportId} />
            ) : (
              <p>No published findings are available yet.</p>
            ))}
          <React.Suspense fallback={<p role="status">Loading dataset…</p>}>
            {report.datasets
              .filter((d) => d.kind === view)
              .map((d) => (
                <ReportDatasetTable
                  key={report.id + d.kind + (report.projectionRevision ?? "")}
                  reportId={reportId}
                  dataset={d}
                  sourceAreaId={
                    sourceQuery.get("dataset") === d.kind
                      ? (sourceQuery.get("areaId") ?? undefined)
                      : undefined
                  }
                  guideHref={
                    "#reports/help?" +
                    new URLSearchParams({
                      columnsVersion: report.columnsVersion,
                      rulesVersion: report.rulesVersion
                    })
                  }
                  objectKey={
                    sourceQuery.get("dataset") === d.kind
                      ? (sourceQuery.get("objectKey") ?? undefined)
                      : undefined
                  }
                />
              ))}
          </React.Suspense>
        </>
      )}
    </main>
  );
}
