import React, { useEffect, useState } from "react";
import { reportsApi } from "./reportsApi";
import "./reports.css";
export function ReportsGuidePage({ query }: { query?: string }) {
  const [data, setData] = useState(undefined as any),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setData(undefined);
    setError("");
    reportsApi
      .definitions(
        new URLSearchParams(query).get("columnsVersion") ?? undefined,
        new URLSearchParams(query).get("rulesVersion") ?? undefined,
        c.signal
      )
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [attempt, query]);
  return (
    <main className="control-page reports-page">
      <header className="page-heading">
        <h1>Database analysis guide</h1>
        <a href="#reports">Back to Reports</a>
      </header>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setAttempt((v) => v + 1)}>Retry guide</button>
        </p>
      )}
      {data && (
        <>
          <section className="report-panel">
            <h2>Collecting and reading reports</h2>
            {Object.entries(data.guidance)
              .filter(([key]) => key !== "references")
              .map(([key, value]) => (
                <p key={key}>{String(value)}</p>
              ))}
          </section>
          <section className="report-panel">
            <h2>Review indicators</h2>
            <p>
              Amber means Review; red means Higher concern. These are review priorities and never
              automatic maintenance instructions.
            </p>
            {data.rules.map((rule: any) => (
              <article key={rule.id}>
                <h3>{rule.id}</h3>
                <p>
                  {rule.explanation} Source: {rule.source}.
                </p>
              </article>
            ))}
          </section>
          <section className="report-panel">
            <h2>Metric reference</h2>
            <p>
              {data.columnsVersion}; {data.rulesVersion}. Retained report headers preserve their
              original mappings.
            </p>
            <div className="report-scroll">
              <table>
                <thead>
                  <tr>
                    <th>CSV column</th>
                    <th>Meaning</th>
                    <th>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.columns.map((c: any) => (
                    <tr key={c.ordinal}>
                      <th>{c.sourceHeader}</th>
                      <td>{c.description}</td>
                      <td>{c.unit ?? "Identity / context"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Progress references</h3>
            <ul>
              {data.guidance.references.map((url: string) => (
                <li key={url}>
                  <a href={url}>{url.split("/").pop()?.replace(/-/g, " ")}</a>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
