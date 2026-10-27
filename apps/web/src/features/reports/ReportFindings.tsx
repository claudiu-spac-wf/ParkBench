import React, { useEffect, useState } from "react";
import { reportsApi } from "./reportsApi";
export function ReportFindings({ reportId }: { reportId: string; key?: string; query?: string }) {
  const [data, setData] = useState(undefined as any),
    [cursor, setCursor] = useState(""),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    reportsApi
      .result(reportId, "findings?" + new URLSearchParams(cursor ? { cursor } : {}), c.signal)
      .then((r) => {
        if (c.signal.aborted) return;
        setData(r);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [reportId, cursor, attempt]);
  return (
    <section className="report-panel">
      <h2>Review findings</h2>
      <p>
        Color indicates review priority. Neutral, unavailable, and size-exempt values do not
        establish health. Findings do not prove corruption or poor performance.
      </p>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setAttempt((v) => v + 1)}>Retry findings</button>
        </p>
      )}
      {data?.items.map((f: any, i: number) => (
        <article key={i} className={"report-finding " + f.severity.toLowerCase()}>
          <h3>
            {f.severity === "HIGHER_CONCERN"
              ? "Higher concern"
              : f.severity === "REVIEW"
                ? "Review"
                : f.severity === "not_assessed"
                  ? "Not assessed — size exemption"
                  : f.severity === "unavailable"
                    ? "Unavailable"
                    : "Neutral"}
            : {f.ruleId}
          </h3>
          <p>
            Observed: {f.observed ?? "Missing/invalid"}. {f.explanation} Source: {f.source}.
          </p>
          <a
            href={`#reports/${reportId}?dataset=${f.datasetKind}&objectKey=${encodeURIComponent(f.objectKey)}&row=${f.sourceRowOrdinal}`}
          >
            Open source {f.datasetKind} row {f.sourceRowOrdinal}
          </a>
        </article>
      ))}
      {data?.items.length === 0 && <p>No retained rule assessments are available.</p>}
      <div className="report-actions">
        {cursor && <button onClick={() => setCursor("")}>First findings</button>}
        {data?.hasMore && <button onClick={() => setCursor(data.nextCursor)}>Next findings</button>}
      </div>
    </section>
  );
}
