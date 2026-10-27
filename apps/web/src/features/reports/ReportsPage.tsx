import React, { useEffect, useRef, useState } from "react";
import { idempotencyKey } from "../../api";
import { reportsApi } from "./reportsApi";
import {
  ReportMetadata,
  ReportType
} from "../../../../../packages/contracts/src/database-analysis-report";
import "./reports.css";
export function ReportsPage() {
  const [seeds, setSeeds] = useState([] as any[]),
    [seed, setSeed] = useState(""),
    [type, setType] = useState("DBANALYS" as ReportType),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [seedError, setSeedError] = useState(""),
    [seedAttempt, setSeedAttempt] = useState(0);
  const key = useRef(idempotencyKey()),
    unresolved = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    reportsApi
      .seeds(c.signal)
      .then((v) => {
        setSeeds(v.items);
        setSeedError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setSeedError(e.message);
      });
    return () => c.abort();
  }, [seedAttempt]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (unresolved.current) return;
    unresolved.current = true;
    setPending(true);
    setError("");
    try {
      const v = await reportsApi.create(seed, type, key.current);
      window.location.hash = "reports/" + v.report.id;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
      unresolved.current = false;
    }
  }
  function newSelection(fn: () => void) {
    fn();
    key.current = idempotencyKey();
    setError("");
  }
  return (
    <main className="control-page reports-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">PARKBENCH / DATABASE EVIDENCE</p>
          <h1>Reports</h1>
        </div>
        <a href="#reports/help">Report guide</a>
      </header>
      <section className="report-panel">
        <h2>Database analysis</h2>
        <p>
          Analyze a temporary database started from a copy of the selected seed. Reports take
          priority over waiting experiments; active work finishes uninterrupted. There is no
          automatic time limit.
        </p>
        <form onSubmit={submit} className="report-form">
          <label>
            Database seed
            <select
              required
              value={seed}
              disabled={pending}
              onChange={(e) => newSelection(() => setSeed(e.target.value))}
            >
              <option value="">Select a ready seed</option>
              {seeds.map((s) => {
                const ready =
                  s.verificationState === "VERIFIED" &&
                  (!s.readiness || s.readiness === "READY") &&
                  (!s.availability || s.availability === "AVAILABLE");
                return (
                  <option key={s.id} value={s.id} disabled={!ready}>
                    {s.displayName ?? s.name}
                    {ready ? "" : " — " + (s.reason ?? s.readiness ?? s.verificationState)}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            Report type
            <select
              value={type}
              disabled={pending}
              onChange={(e) => newSelection(() => setType(e.target.value as ReportType))}
            >
              <option value="DBANALYS">DBANALYS — full database analysis</option>
              <option value="IDXANALYS">IDXANALYS — indexes and blocks</option>
              <option value="TABANALYS">TABANALYS — tables, blocks and LOBs</option>
            </select>
          </label>
          <button disabled={pending || !seed}>{pending ? "Submitting…" : "Generate report"}</button>
        </form>
        {seedError && (
          <p role="alert">
            {seedError} <button onClick={() => setSeedAttempt((v) => v + 1)}>Retry seeds</button>
          </p>
        )}
        {error && <p role="alert">{error} Retry uses the same request identity.</p>}
      </section>
      <ReportHistory />
    </main>
  );
}
export function ReportHistory() {
  const [state, setState] = useState(""),
    [type, setType] = useState(""),
    [seed, setSeed] = useState(""),
    [cursor, setCursor] = useState(""),
    [result, setResult] = useState(undefined as any),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    const q = new URLSearchParams();
    if (state) q.set("state", state);
    if (type) q.set("type", type);
    if (seed) q.set("seedAssetId", seed);
    if (cursor) q.set("cursor", cursor);
    reportsApi
      .list(q, c.signal)
      .then((r) => {
        setResult(r);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [state, type, seed, cursor, attempt]);
  return (
    <section className="report-panel">
      <h2>Report history</h2>
      <div className="report-form">
        <label>
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setCursor("");
            }}
          >
            <option value="">All states</option>
            {["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          History type
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setCursor("");
            }}
          >
            <option value="">All types</option>
            {["DBANALYS", "IDXANALYS", "TABANALYS"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Captured seed ID
          <input
            value={seed}
            onChange={(e) => {
              setSeed(e.target.value);
              setCursor("");
            }}
          />
        </label>
      </div>
      {error ? (
        <p role="alert">
          {error} <button onClick={() => setAttempt((v) => v + 1)}>Retry history</button>
        </p>
      ) : !result ? (
        <p role="status">Loading reports…</p>
      ) : !result.items.length ? (
        <p>No reports match these filters.</p>
      ) : (
        <div className="report-scroll">
          <table>
            <caption>Independent database analysis history</caption>
            <thead>
              <tr>
                <th>Seed</th>
                <th>Type</th>
                <th>Submitted</th>
                <th>State</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((r: ReportMetadata) => (
                <tr key={r.id}>
                  <td>{r.seedSnapshot.name}</td>
                  <td>{r.type}</td>
                  <td>{r.createdAt}</td>
                  <td>{r.state}</td>
                  <td>
                    <a href={"#reports/" + r.id}>Inspect {r.id}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="report-actions">
        {cursor && <button onClick={() => setCursor("")}>First page</button>}
        {result?.hasMore && (
          <button onClick={() => setCursor(result.nextCursor)}>Next history page</button>
        )}
      </div>
    </section>
  );
}
