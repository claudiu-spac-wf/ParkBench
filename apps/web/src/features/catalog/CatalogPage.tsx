import React, { useEffect, useState } from "react";
import {
  getAllCatalog,
  getCatalogDiscovery,
  refreshCatalogDiscovery
} from "../../shared/control-ui-client";
import { WorkflowState } from "../../shared/workflow-state";

const categories = [
  ["scenarios", "Scenarios"],
  ["workloads", "Workloads"],
  ["seeds", "Seeds"],
  ["archives", "Archives"]
] as const;

export function CatalogPage() {
  const [requestedCategory, setCategory] = useState("scenarios" as string);
  const category = categories.some(([key]) => key === requestedCategory)
    ? requestedCategory
    : "scenarios";
  const [items, setItems] = useState([] as any[]);
  const [selected, setSelected] = useState(undefined as any);
  const [discovery, setDiscovery] = useState(undefined as any);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refresh = async (rescan = false) => {
    setLoading(true);
    setError("");
    try {
      if (rescan) await refreshCatalogDiscovery();
      const [catalog, snapshot] = await Promise.all([
        getAllCatalog(`category=${encodeURIComponent(category)}`),
        getCatalogDiscovery()
      ]);
      setItems(catalog.items ?? []);
      setDiscovery(snapshot);
      setSelected((current: any) => catalog.items?.find((item: any) => item.id === current?.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [category]);
  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERATE / CATALOG</p>
          <h1>Catalog</h1>
          <p>Current files in the configured managed directories.</p>
        </div>
        <button type="button" disabled={loading} onClick={() => void refresh(true)}>
          Refresh files
        </button>
      </header>
      {error && (
        <WorkflowState
          state="error"
          message={error}
          action="Retry"
          onAction={() => void refresh(true)}
        />
      )}
      <section className="catalog-tabs" role="tablist" aria-label="Catalog categories">
        {categories.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={category === key}
            className={category === key ? "active-tab" : "button secondary"}
            onClick={() => setCategory(key)}
          >
            {label}{" "}
            <small>
              {discovery?.categories?.find((item: any) => item.key === key)?.count ?? 0}
            </small>
          </button>
        ))}
      </section>
      {loading && <WorkflowState state="loading" message="Reading managed files…" />}
      <section className="card-grid">
        <section className="panel">
          <h2>{categories.find(([key]) => key === category)?.[1]}</h2>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>Last action</th>
                <th>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.relativePath ?? item.provenance?.relativePath ?? item.name}</td>
                  <td>
                    <span
                      className={`status ${String(item.sourceStatus ?? item.readiness ?? "AVAILABLE").toLowerCase()}`}
                    >
                      {item.sourceStatus ?? item.readiness ?? "AVAILABLE"}
                    </span>
                  </td>
                  <td>
                    {item.lastAction
                      ? `${item.lastAction.state} · ${item.lastAction.checkedAt}`
                      : "Not checked"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setSelected(item)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !error && items.length === 0 && (
            <WorkflowState state="empty" message="No files found in this managed directory." />
          )}
        </section>
        <aside className="panel">
          <h2>Selected file</h2>
          {selected ? (
            <dl className="details">
              <dt>Path</dt>
              <dd>{selected.relativePath ?? selected.provenance?.relativePath ?? selected.name}</dd>
              <dt>Source status</dt>
              <dd>{selected.sourceStatus ?? selected.readiness ?? "AVAILABLE"}</dd>
              <dt>Diagnostics</dt>
              <dd>
                {[...(selected.failureReasons ?? []), ...(selected.blockReasons ?? [])].join(
                  "; "
                ) || "None"}
              </dd>
              {selected.declaredScenarioId && (
                <>
                  <dt>Scenario ID</dt>
                  <dd>{selected.declaredScenarioId}</dd>
                </>
              )}
              {selected.archiveContents && (
                <>
                  <dt>Archive contents</dt>
                  <dd>{JSON.stringify(selected.archiveContents)}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="muted">Select a file to inspect its status.</p>
          )}
        </aside>
      </section>
    </main>
  );
}
