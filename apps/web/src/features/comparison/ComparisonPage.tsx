import {
  DEFAULT_COMPARISON_METRICS,
  type MetricSelection,
  type ProjectedMetricValue
} from "../../../../../packages/contracts/src/comparison-metric-selection";
import { MetricSelectionPanel } from "./MetricSelectionPanel";
import { SelectedMetricTable } from "./SelectedMetricTable";
import { supportedMetricSelection } from "./metricSelection";
import React, { useEffect, useRef, useState } from "react";
import { latencyOf, latencySummary } from "../../shared/latency";
import {
  createComparison,
  comparisonExportUrl,
  getControlExperiments,
  getComparisonSelection
} from "../../shared/control-ui-client";
import { ResourceComparisonTable } from "./ResourceComparisonTable";
import { DatabaseComparisonTable } from "./DatabaseComparisonTable";
import { DashboardPanel } from "../dashboards/DashboardPanel";
import { FieldHelp } from "../../shared/FieldHelp";
import { WorkflowState } from "../../shared/workflow-state";
import { experimentDisplayName } from "../../shared/experiment-label";

import { candidateUnion, pageCandidates, changeBasket } from "./comparisonSelection";
import {
  ComparisonResultLoader,
  MetricValuesLoader,
  DetailHydrator,
  restoreComparisonSelection,
  type BaselineQualitySnapshot,
  type ComparisonLoadResult
} from "./comparisonApi";
import { projectScheduledParameters } from "./comparisonPresentation";

export function ComparisonPage({
  experimentId,
  comparisonId
}: {
  experimentId?: string;
  comparisonId?: string;
}) {
  const [experiments, setExperiments] = useState([] as any[]);
  const [selectedExperimentIds, setSelectedExperimentIds] = useState([] as string[]);
  const [candidateFilter, setCandidateFilter] = useState("");
  const [candidatePage, setCandidatePage] = useState(0);
  const [detailErrors, setDetailErrors] = useState({} as Record<string, string>);
  const hydrator = useRef(new DetailHydrator());
  const [restoring, setRestoring] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [variants, setVariants] = useState([] as string[]);
  const [runDetails, setRunDetails] = useState([] as any[]);
  const [comparison, setComparison] = useState(undefined as any);
  const resultLoader = useRef(new ComparisonResultLoader());
  const resultRequestId = useRef(0);
  const [baselineQuality, setBaselineQuality] = useState(
    undefined as BaselineQualitySnapshot | undefined
  );
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(undefined as number | undefined);
  const [resultBusy, setResultBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadingExperiments, setLoadingExperiments] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorAction, setErrorAction] = useState(
    "experiments" as "experiments" | "runs" | "compare" | "results"
  );
  const [runCursor, setRunCursor] = useState(undefined as string | undefined);
  const [runCursors, setRunCursors] = useState([] as Array<string | undefined>);
  const [selectionPage, setSelectionPage] = useState(undefined as any);
  const [pageBusy, setPageBusy] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("");
  const downloadController = useRef(undefined as AbortController | undefined);

  const [metricSelection, setMetricSelection] = useState(
    structuredClone(DEFAULT_COMPARISON_METRICS) as MetricSelection[]
  );
  const [customMetrics, setCustomMetrics] = useState(false);
  const [metricRows, setMetricRows] = useState([] as ProjectedMetricValue[]);
  const [metricsMore, setMetricsMore] = useState(false);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [metricsError, setMetricsError] = useState("");
  const metricLoader = useRef(new MetricValuesLoader());
  const metricRequest = useRef(0);
  const metricsComparisonId = useRef("");
  useEffect(() => {
    if (comparison?.id && comparison.id !== metricsComparisonId.current) {
      metricsComparisonId.current = comparison.id;
      setMetricSelection(structuredClone(DEFAULT_COMPARISON_METRICS));
      setCustomMetrics(false);
    }
  }, [comparison?.id]);
  const changeMetrics = (metrics: MetricSelection[]) => {
    setMetricSelection(metrics);
    setCustomMetrics(true);
  };
  useEffect(() => {
    metricLoader.current.cancel();
    const generation = ++metricRequest.current;
    setMetricRows([]);
    setMetricsMore(false);
    setMetricsError("");
    if (!comparison || !customMetrics || resultBusy) {
      setMetricsBusy(false);
      return;
    }
    const supported = supportedMetricSelection(metricSelection);
    if (!supported.metrics.length) {
      setMetricsBusy(false);
      return;
    }
    setMetricsBusy(true);
    void metricLoader.current
      .load(
        comparison.id,
        comparison.selectionRevision,
        comparison.runs.map((r: any) => r.runId),
        supported.metrics
      )
      .then((value) => {
        if (value && generation === metricRequest.current) {
          setMetricRows(value.rows);
          setMetricsMore(value.hasMore);
        }
      })
      .catch((e) => {
        if (generation === metricRequest.current) setMetricsError(e.message);
      })
      .finally(() => {
        if (generation === metricRequest.current) setMetricsBusy(false);
      });
    return () => metricLoader.current.cancel();
  }, [comparison, metricSelection, customMetrics, resultBusy]);
  const nextMetricRows = async () => {
    const generation = metricRequest.current;
    setMetricsBusy(true);
    try {
      const value = await metricLoader.current.next();
      if (value && generation === metricRequest.current) {
        setMetricRows(value.rows);
        setMetricsMore(value.hasMore);
      }
    } catch (e) {
      if (generation === metricRequest.current) {
        setMetricRows([]);
        setMetricsMore(false);
        setMetricsError((e as Error).message);
      }
    } finally {
      if (generation === metricRequest.current) setMetricsBusy(false);
    }
  };

  const applyLoadedResult = (loaded: ComparisonLoadResult) => {
    setComparison(loaded.comparison);
    setBaselineQuality(loaded.baselineQuality);
    setRetryAfterSeconds(loaded.retryAfterSeconds);
  };
  const invalidateQuality = (requestId: number) => {
    setBaselineQuality({
      status: "pending",
      sourceStatus: "pending",
      reason: "Baseline quality is being revalidated.",
      comparisonId: comparison?.id ?? "",
      selectionRevision: comparison?.selectionRevision ?? 0,
      baselineRunId: comparison?.baselineRunId,
      generation: requestId
    });
    setRetryAfterSeconds(undefined);
  };

  const experimentsRequestId = useRef(0);
  const loadExperiments = () => {
    const requestId = ++experimentsRequestId.current;
    setError("");
    setErrorAction("experiments");
    setLoadingExperiments(true);
    void getControlExperiments()
      .then((value) => {
        if (requestId !== experimentsRequestId.current) return;
        const items = value.items?.length ? value.items : (value.experiments ?? []);
        setExperiments(items);
        const selected = items.find((item: any) => item.id === experimentId);
        setSelectedExperimentIds(experimentId && selected ? [experimentId] : []);
        if (experimentId && !selected)
          setError(`Experiment ${experimentId} is unavailable. Choose an available experiment.`);
      })
      .catch((reason) => {
        if (requestId === experimentsRequestId.current) setError(reason.message);
      })
      .finally(() => {
        if (requestId === experimentsRequestId.current) setLoadingExperiments(false);
      });
  };
  useEffect(() => {
    loadExperiments();
  }, [experimentId]);
  const candidates = candidateUnion(experiments, selectedExperimentIds);
  const page = pageCandidates(candidates, candidateFilter, candidatePage);
  const selectedIds = [...new Set([...(baseline ? [baseline] : []), ...variants])];
  const wantedIds = [
    ...new Set([
      ...page.items.map((run) => run.id),
      ...selectedIds,
      ...(comparison?.runs ?? []).map((run: any) => run.runId)
    ])
  ];
  const wantedKey = wantedIds.join("\0");
  const acceptDetail = (id: string, value?: any, reason?: Error) => {
    if (reason) setDetailErrors((current) => ({ ...current, [id]: reason.message }));
    else {
      setRunDetails((current) => [...current.filter((run) => run.id !== id), value]);
      setDetailErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };
  const loadRuns = () =>
    hydrator.current.setWanted(
      wantedIds,
      acceptDetail,
      setLoadingRuns,
      wantedIds.filter((id) => detailErrors[id])
    );
  useEffect(() => {
    hydrator.current.setWanted(wantedIds, acceptDetail, setLoadingRuns);
  }, [wantedKey]);
  useEffect(() => () => hydrator.current.cancel(), []);
  useEffect(() => {
    const requestId = ++resultRequestId.current;
    resultLoader.current.cancel();
    invalidateQuality(requestId);
    setResultBusy(false);
    setPageBusy(false);
    setCreating(false);
    setComparison(undefined);
    setSelectionPage(undefined);
    if (!comparisonId) {
      setRunCursor(undefined);
      setRunCursors([]);
      setRestoring(false);
      return () => {
        resultRequestId.current++;
        resultLoader.current.cancel();
      };
    }
    let disposed = false;
    setRestoring(true);
    setErrorAction("results");
    void restoreComparisonSelection(comparisonId)
      .then(({ comparison: saved, runIds }) => {
        if (disposed || requestId !== resultRequestId.current) return;
        applyLoadedResult(resultLoader.current.accept(saved));
        setSelectionPage(saved.selectionPage);
        setBaseline(saved.baselineRunId ?? "");
        setVariants(runIds.filter((id) => id !== saved.baselineRunId));
        setRunCursor(undefined);
        setRunCursors([]);
      })
      .catch((reason) => {
        if (!disposed) setError(reason.message);
      })
      .finally(() => {
        if (!disposed) setRestoring(false);
      });
    return () => {
      disposed = true;
      resultRequestId.current++;
      resultLoader.current.cancel();
    };
  }, [comparisonId, experimentId]);
  const mutateBasket = (kind: "baseline" | "toggle" | "remove" | "add", id: string) => {
    if (restoring) return;
    const next = changeBasket(
      { baselineRunId: baseline || undefined, variantRunIds: variants },
      { kind, id }
    );
    setBaseline(next.baselineRunId ?? "");
    setVariants(next.variantRunIds);
  };
  const runLabel = (id: string) => {
    const detail = runDetails.find((run) => run.id === id);
    const stub = candidateUnion(
      experiments,
      experiments.map((e) => e.id)
    ).find((run) => run.id === id);
    const run = detail ?? stub;
    return `${run?.name ? `${run.name} (${id})` : id} — ${detail?.state ?? "details pending"} / ${detail?.measurementValidity ?? "unknown"} · ${run?.experimentId ?? stub?.experimentId ?? "experiment unavailable"}${detail?.environmentSnapshot?.scenario?.id ? ` · ${detail.environmentSnapshot.scenario.id}@${detail.environmentSnapshot.scenario.version ?? ""}` : ""}`;
  };
  const compare = () => {
    if (creating) return;
    const requestId = ++resultRequestId.current;
    resultLoader.current.cancel();
    invalidateQuality(requestId);
    setResultBusy(false);
    setPageBusy(false);
    setError("");
    setErrorAction("compare");
    setCreating(true);
    void createComparison({
      baselineRunId: baseline || undefined,
      variantRunIds: variants.filter((runId: string) => runId !== baseline)
    })
      .then((value) => {
        if (requestId !== resultRequestId.current) return;
        applyLoadedResult(resultLoader.current.accept(value));
        setSelectionPage(value.selectionPage);
        setRunCursor(undefined);
        setRunCursors([]);
      })
      .catch((reason) => {
        if (requestId === resultRequestId.current) setError(reason.message);
      })
      .finally(() => {
        if (requestId === resultRequestId.current) setCreating(false);
      });
  };
  const loadResults = async (
    id: string,
    cursor: string | undefined,
    move?: "next" | "back" | "reset"
  ) => {
    const requestId = ++resultRequestId.current;
    invalidateQuality(requestId);
    setResultBusy(true);
    setPageBusy(false);
    setError("");
    setErrorAction("results");
    try {
      const loaded = await resultLoader.current.load(id, { cursor });
      if (!loaded || requestId !== resultRequestId.current) return;
      applyLoadedResult(loaded);
      if (move) {
        setRunCursors((stack) =>
          move === "reset" ? [] : move === "back" ? stack.slice(0, -1) : [...stack, runCursor]
        );
        setRunCursor(cursor);
      }
      if (move === "reset") setSelectionPage(loaded.comparison.selectionPage);
      return loaded;
    } catch (reason) {
      if (requestId === resultRequestId.current) {
        const message = (reason as Error).message;
        setError(message);
        setBaselineQuality(
          (current) =>
            current && {
              ...current,
              status: "unavailable",
              sourceStatus: "unavailable",
              reason: `Comparison refresh unavailable: ${message}. Retry comparison.`
            }
        );
      }
    } finally {
      if (requestId === resultRequestId.current) setResultBusy(false);
    }
  };
  const refreshResults = () => {
    const id = comparison?.id ?? comparisonId;
    if (!id) return;
    if (!comparison && comparisonId) {
      // Retry restoration without creating a new comparison or changing the saved selection.
      const requestId = ++resultRequestId.current;
      resultLoader.current.cancel();
      invalidateQuality(requestId);
      setRestoring(true);
      setError("");
      void restoreComparisonSelection(id)
        .then(({ comparison: saved, runIds }) => {
          if (requestId !== resultRequestId.current) return;
          applyLoadedResult(resultLoader.current.accept(saved));
          setSelectionPage(saved.selectionPage);
          setBaseline(saved.baselineRunId ?? "");
          setVariants(runIds.filter((runId) => runId !== saved.baselineRunId));
          setRunCursor(undefined);
          setRunCursors([]);
        })
        .catch((reason) => {
          if (requestId === resultRequestId.current) setError(reason.message);
        })
        .finally(() => {
          if (requestId === resultRequestId.current) setRestoring(false);
        });
    } else void loadResults(id, runCursor);
  };
  useEffect(() => {
    if (!comparison?.id || !retryAfterSeconds || resultBusy || pageBusy || creating || restoring)
      return;
    const timer = setTimeout(
      () => {
        void loadResults(comparison.id, runCursor);
      },
      Math.min(10000, Math.max(2000, retryAfterSeconds * 1000))
    );
    return () => clearTimeout(timer);
  }, [comparison, runCursor, retryAfterSeconds, resultBusy, pageBusy, creating, restoring]);
  useEffect(() => () => downloadController.current?.abort(), []);
  const pageRuns = async (cursor: string | undefined, back = false) => {
    await loadResults(comparison.id, cursor, back ? "back" : "next");
  };
  const pageSelection = async () => {
    const requestId = resultRequestId.current;
    const id = comparison.id;
    const revision = comparison.selectionRevision;
    setPageBusy(true);
    try {
      const value = await getComparisonSelection(id, {
        cursor: selectionPage?.nextCursor
      });
      if (requestId !== resultRequestId.current) return;
      if (value.selectionRevision !== revision)
        throw new Error("comparison_selection_cursor_stale");
      setSelectionPage(value.selectionPage);
    } catch (reason) {
      if (requestId !== resultRequestId.current) return;
      if (
        ((reason as any).code ?? (reason as Error).message) === "comparison_selection_cursor_stale"
      ) {
        await loadResults(id, undefined, "reset");
      } else setError((reason as Error).message);
    } finally {
      if (requestId === resultRequestId.current) setPageBusy(false);
    }
  };
  const download = async (event: React.MouseEvent) => {
    event.preventDefault();
    downloadController.current?.abort();
    const controller = new AbortController();
    downloadController.current = controller;
    try {
      while (!controller.signal.aborted) {
        const response = await fetch(comparisonExportUrl(comparison.id), {
          signal: controller.signal
        });
        if (response.status === 409) {
          const wait = Math.max(2, Number(response.headers.get("Retry-After")) || 2);
          await response.body?.cancel();
          setDownloadStatus("Preparing comparison summaries…");
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, Math.min(wait, 30) * 1000);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(controller.signal.reason);
              },
              { once: true }
            );
          });
          continue;
        }
        if (!response.ok) throw new Error("Comparison download failed. Try again.");
        await response.body?.cancel();
        const anchor = document.createElement("a");
        anchor.href = comparisonExportUrl(comparison.id);
        anchor.download = `comparison-${comparison.id}.csv`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setDownloadStatus("");
        break;
      }
    } catch (reason) {
      if (!controller.signal.aborted) setDownloadStatus((reason as Error).message);
    }
  };
  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ANALYZE / COMPARISON</p>
          <h1>Compare runs</h1>
          <p>
            Compare runs across experiments and scenarios with an optional baseline. You are
            responsible for interpreting the results.
          </p>
        </div>
      </header>
      {error && (
        <WorkflowState
          state="error"
          message={error}
          action={
            errorAction === "experiments"
              ? "Retry experiments"
              : errorAction === "runs"
                ? "Retry run details"
                : "Retry comparison"
          }
          onAction={
            errorAction === "experiments"
              ? loadExperiments
              : errorAction === "runs"
                ? () => loadRuns()
                : errorAction === "results"
                  ? refreshResults
                  : compare
          }
        />
      )}
      {loadingExperiments && <WorkflowState state="loading" message="Loading experiments…" />}
      <section className="panel">
        <label>
          <span>Experiments</span>
          <select
            multiple
            size={Math.max(3, Math.min(8, experiments.length))}
            aria-label="Experiments"
            value={selectedExperimentIds}
            onChange={(event) => {
              setSelectedExperimentIds(
                Array.from(
                  event.target.selectedOptions as HTMLOptionsCollection,
                  (option: HTMLOptionElement) => option.value
                )
              );
              setCandidatePage(0);
            }}
          >
            {experiments.map((item) => (
              <option key={item.id} value={item.id}>
                {experimentDisplayName(item)} — {item.status}
              </option>
            ))}
          </select>
        </label>
        <p>
          Selected experiments:{" "}
          {selectedExperimentIds
            .map((id) => experimentDisplayName(experiments.find((e) => e.id === id)))
            .join(", ") || "None"}
        </p>
        {restoring && <WorkflowState state="loading" message="Restoring saved selection…" />}
        {loadingRuns && <WorkflowState state="loading" message="Loading runs…" />}
        <label>
          Filter candidate runs
          <input
            aria-label="Filter candidate runs"
            value={candidateFilter}
            onChange={(event) => {
              setCandidateFilter(event.target.value);
              setCandidatePage(0);
            }}
          />
        </label>
        <button
          disabled={restoring || !page.total}
          onClick={() => {
            if (restoring) return;
            setVariants((current) =>
              [...new Set([...current, ...page.filtered.map((run) => run.id)])].filter(
                (id) => id !== baseline
              )
            );
          }}
        >
          Select all candidates
        </button>
        <p>
          {page.total} candidate runs. Page {page.page + 1} of {page.pageCount}.
        </p>
        <div className="check-list">
          {page.items.map((run) => (
            <label key={run.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(run.id)}
                disabled={restoring || baseline === run.id}
                onChange={() => mutateBasket("toggle", run.id)}
              />
              {runLabel(run.id)}
              {detailErrors[run.id] && (
                <span role="status">Details unavailable: {detailErrors[run.id]}</span>
              )}
            </label>
          ))}
        </div>
        <button disabled={page.page === 0} onClick={() => setCandidatePage(page.page - 1)}>
          Previous candidates
        </button>{" "}
        <button
          disabled={page.page + 1 >= page.pageCount}
          onClick={() => setCandidatePage(page.page + 1)}
        >
          Next candidates
        </button>
        {!page.total && <p>No candidate runs. Select experiments or change the filter.</p>}
        <h2>
          Baseline{" "}
          <FieldHelp label="Baseline">
            Choose any run as a baseline, or leave it blank to show run values. Every run status and
            scenario is allowed.
          </FieldHelp>
        </h2>
        <select
          aria-label="Baseline"
          disabled={restoring}
          value={baseline}
          onChange={(event) => mutateBasket("baseline", event.target.value)}
        >
          <option value="">No baseline — descriptive only</option>
          {[...new Set([...candidates.map((run) => run.id), ...selectedIds])].map((id) => (
            <option key={id} value={id}>
              {runLabel(id)}
            </option>
          ))}
        </select>
        <h2>Selected runs ({selectedIds.length})</h2>
        <ul>
          {selectedIds.map((id) => (
            <li key={id}>
              {runLabel(id)} {baseline === id && "(baseline)"}
              {detailErrors[id] && (
                <span role="status">Details unavailable: {detailErrors[id]}</span>
              )}
              <button
                aria-label={`Remove ${id}`}
                disabled={restoring}
                onClick={() => mutateBasket("remove", id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {Object.keys(detailErrors).some((id) => wantedIds.includes(id)) && (
          <button onClick={loadRuns}>Retry run details</button>
        )}
        <button onClick={compare} disabled={creating || restoring || !selectedIds.length}>
          {creating ? "Creating…" : "Create comparison"}
        </button>
        {!loadingExperiments && !experiments.length && (
          <WorkflowState
            state="empty"
            message="No experiments are available for comparison yet."
            action="Schedule a run"
            onAction={() => {
              window.location.hash = "experiments";
            }}
          />
        )}
      </section>
      {comparison && (
        <section className="panel">
          <h2>Comparison summary</h2>
          <MetricSelectionPanel
            selection={metricSelection}
            onChange={changeMetrics}
            onDefaults={() => {
              setMetricSelection(structuredClone(DEFAULT_COMPARISON_METRICS));
              setCustomMetrics(false);
            }}
          />
          {customMetrics && !metricSelection.length && (
            <p role="status">No metrics selected. Choose metrics or restore defaults.</p>
          )}
          {metricsBusy && <p role="status">Loading selected measurements…</p>}
          {metricsError && <p role="alert">{metricsError}</p>}
          {metricsMore && (
            <button disabled={metricsBusy} onClick={() => void nextMetricRows()}>
              Load more selected measurements
            </button>
          )}
          {comparison.warnings?.map((warning: any) => (
            <p key={warning.code} role="status">
              {warning.message}
            </p>
          ))}
          <p>
            Saved comparison: <span className="mono">{comparison.id}</span>{" "}
            <a href={`#comparison?comparisonId=${encodeURIComponent(comparison.id)}`}>
              Reopen saved comparison
            </a>
          </p>
          <p>
            Baseline: {comparison.baselineRunId ?? "No baseline"}. Selected runs:{" "}
            {comparison.totalSelectedRunCount}.
          </p>
          <details>
            <summary>Selected run IDs</summary>
            <p className="mono">{selectionPage?.runIds.join(", ")}</p>
            <button
              disabled={pageBusy || resultBusy || creating || restoring || !selectionPage?.hasMore}
              onClick={() => void pageSelection()}
            >
              Next selected runs
            </button>
          </details>
          <a
            className="button secondary"
            href={comparisonExportUrl(comparison.id)}
            onClick={download}
            download={`comparison-${comparison.id}.csv`}
          >
            Download comparison CSV
          </a>
          {downloadStatus && <p role="status">{downloadStatus}</p>}
          <button disabled={resultBusy || creating || restoring} onClick={refreshResults}>
            Refresh comparison
          </button>
          {resultBusy && (
            <p role="status">Refreshing comparison measurements and baseline quality…</p>
          )}
          {baselineQuality?.status !== "accepted" &&
            comparison.baselineRunId &&
            baselineQuality?.reason && (
              <p role="status" className="comparison-warning">
                Warning: {baselineQuality.reason}
              </p>
            )}
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Run</th>
                <th>State</th>
                <th>Validity</th>
                <th>Summary</th>
                <th>Cleanup</th>
              </tr>
            </thead>
            <tbody>
              {comparison.runs.map((run: any) => (
                <tr key={run.runId}>
                  <td>{run.role}</td>
                  <td>{run.name ?? run.runId}</td>
                  <td>{run.state}</td>
                  <td>{run.measurementValidity}</td>
                  <td>
                    {run.summary.status} {run.summary.reason?.replaceAll("_", " ")}
                  </td>
                  <td>{run.context?.cleanupStatus ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {retryAfterSeconds && (
            <p role="status">Preparing saved measurements. Available results remain visible.</p>
          )}
          {comparison.runs.map((run: any) => {
            const detail = runDetails.find((item) => item.id === run.runId);
            const parameters = projectScheduledParameters(detail?.environmentSnapshot);
            return (
              <details
                key={`${comparison.id}:${comparison.selectionRevision}:${runCursor ?? "first"}:${run.runId}`}
                data-run-id={run.runId}
                className="panel comparison-run"
              >
                <summary>
                  <strong>{run.name ?? run.runId}</strong>{" "}
                  {run.name && <span className="mono">({run.runId})</span>}{" "}
                  <span className="status">{run.role}</span>{" "}
                  <span>
                    {run.state} / {run.measurementValidity} · {run.summary.status}
                  </span>
                </summary>
                {run.summary.header && (
                  <p>
                    Measurement: {run.summary.header.windows.measurement.start ?? "not started"} to{" "}
                    {run.summary.header.windows.measurement.end ?? "—"} (
                    {run.summary.header.windows.measurement.state})
                  </p>
                )}
                {run.summary.artifactId && (
                  <a
                    href={`/api/v1/runs/${encodeURIComponent(run.runId)}/artifacts/${encodeURIComponent(run.summary.artifactId)}`}
                  >
                    Full saved summary
                  </a>
                )}
                {customMetrics ? (
                  <SelectedMetricTable runId={run.runId} rows={metricRows} />
                ) : (
                  <>
                    <ResourceComparisonTable run={run} baselineQuality={baselineQuality} />
                    <DatabaseComparisonTable
                      comparisonId={comparison.id}
                      run={run}
                      baselineQuality={baselineQuality}
                    />
                  </>
                )}
                <section aria-label={`Parameters for ${run.runId}`}>
                  <h3>Parameters</h3>
                  {parameters.entries.length > 0 && (
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Parameter</th>
                          <th scope="col">Scheduled value</th>
                          <th scope="col">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parameters.entries.map((entry) => (
                          <tr key={JSON.stringify([entry.name, entry.value, entry.sources])}>
                            <th scope="row">{entry.name}</th>
                            <td>{entry.value === "" ? "(empty string)" : entry.value}</td>
                            <td>{entry.sources.join(" · ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {parameters.status === "empty" && <p>None set</p>}
                  {(parameters.status === "partial" || parameters.status === "unavailable") && (
                    <p role="status">
                      {detailErrors[run.runId]
                        ? `Scheduled parameters unavailable: ${detailErrors[run.runId]}`
                        : !detail && loadingRuns
                          ? "Loading scheduled parameters…"
                          : `Scheduled parameters unavailable: ${parameters.unavailableSources.join(" and ")}.`}
                    </p>
                  )}
                </section>
                <p>
                  Database latency:{" "}
                  {latencySummary(
                    latencyOf(
                      run.context?.effectiveConfiguration as Record<string, unknown> | undefined
                    ),
                    run.context?.databaseLatency as { status?: string } | undefined
                  )}
                </p>
                <details>
                  <summary>Run context</summary>
                  <pre>{JSON.stringify(run.context, null, 2)}</pre>
                </details>
              </details>
            );
          })}
          <button
            disabled={pageBusy || resultBusy || creating || restoring || !runCursors.length}
            onClick={() => void pageRuns(runCursors.at(-1), true)}
          >
            Previous runs
          </button>{" "}
          <button
            disabled={pageBusy || resultBusy || creating || restoring || !comparison.page.hasMore}
            onClick={() => void pageRuns(comparison.page.nextCursor)}
          >
            Next runs
          </button>
          <DashboardPanel contextId={comparison.dashboardContextId} />
        </section>
      )}
    </main>
  );
}
