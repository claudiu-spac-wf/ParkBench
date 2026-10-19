import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActiveRunPage } from "./features/monitoring/ActiveRunPage";
import { CatalogPage } from "./features/catalog/CatalogPage";
import { MatrixExperimentPage } from "./features/experiments/MatrixExperimentPage";
import { QueueDashboardPage } from "./features/runs/QueueDashboardPage";
import { ComparisonPage } from "./features/comparison/ComparisonPage";
import { HistoryPage } from "./features/history/HistoryPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { DashboardDirectoryPage } from "./features/dashboards/DashboardDirectoryPage";
import { FieldHelpProvider } from "./shared/FieldHelp";
import { WorkflowState } from "./shared/workflow-state";
import "./app.css";

function App() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const update = () => setHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (hash === "scenarios") window.location.hash = "catalog";
    if (hash === "dashboards") window.location.hash = "history";
  }, [hash]);
  const [path, query] = hash.split("?");
  const [route, id, extra] = path.split("/");
  const page =
    (route === "" || route === "overview") && !id ? (
      <OverviewPage />
    ) : route === "catalog" && !id ? (
      <CatalogPage />
    ) : route === "experiments" && !id ? (
      <MatrixExperimentPage />
    ) : route === "queue" && !id ? (
      <QueueDashboardPage />
    ) : route === "runs" && id && !extra ? (
      <ActiveRunPage runId={id} />
    ) : route === "comparison" && !extra ? (
      <ComparisonPage
        experimentId={id}
        comparisonId={new URLSearchParams(query).get("comparisonId") ?? undefined}
      />
    ) : route === "history" && !id ? (
      <HistoryPage />
    ) : route === "dashboards" && id && !extra ? (
      <DashboardDirectoryPage contextId={id} />
    ) : (
      <main className="control-page">
        <header className="page-heading">
          <div>
            <p className="eyebrow">PARKBENCH / NAVIGATION</p>
            <h1>Destination unavailable</h1>
          </div>
        </header>
        <WorkflowState
          state="unavailable"
          message="This destination is unavailable. Check the link or return to Overview."
          action="Open Overview"
          onAction={() => {
            window.location.hash = "";
          }}
        />
      </main>
    );
  return (
    <div className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#">
          PARKBENCH / CONTROL
        </a>
        <div className="nav">
          <a
            href="#"
            aria-current={(route === "" || route === "overview") && !id ? "page" : undefined}
          >
            Overview
          </a>
          <a href="#catalog" aria-current={route === "catalog" && !id ? "page" : undefined}>
            Catalog
          </a>
          <a href="#experiments" aria-current={route === "experiments" && !id ? "page" : undefined}>
            Schedule
          </a>
          <a href="#queue" aria-current={route === "queue" && !id ? "page" : undefined}>
            Queue
          </a>
          <a
            href="#comparison"
            aria-current={route === "comparison" && !extra ? "page" : undefined}
          >
            Comparisons
          </a>
          <a href="#history" aria-current={route === "history" && !id ? "page" : undefined}>
            History
          </a>
        </div>
      </nav>
      <FieldHelpProvider>{page}</FieldHelpProvider>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
