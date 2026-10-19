import React, { useEffect, useState } from "react";
import { getDashboardContext } from "../../shared/control-ui-client";
import {
  getGrafanaDashboards,
  groupGrafanaDashboards,
  resolveDashboardUid
} from "../../shared/grafana-client";
import type { GrafanaDashboard } from "../../shared/grafana-client";
import { grafanaDashboardUrl } from "../../shared/grafana-dashboard-url";
import { WorkflowState } from "../../shared/workflow-state";

const SELECTED_GRAFANA_DASHBOARD_KEY = "parkbench-selected-grafana-dashboard";

export function DashboardPanel({ contextId }: { contextId?: string }) {
  const [context, setContext] = useState(undefined as any);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(contextId));
  const [dashboards, setDashboards] = useState([] as GrafanaDashboard[]);
  const [dashboardsError, setDashboardsError] = useState("");
  const [dashboardsLoading, setDashboardsLoading] = useState(true);
  const [selectedDashboardUid, setSelectedDashboardUid] = useState("");
  const loadContext = () => {
    if (!contextId) return;
    setError("");
    setLoading(true);
    void getDashboardContext(contextId)
      .then((value) => {
        setContext(value);
        setError("");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  };
  const loadDashboards = () => {
    setDashboardsError("");
    setDashboardsLoading(true);
    void getGrafanaDashboards()
      .then((available) => {
        available = groupGrafanaDashboards(available).flatMap((g) => g.dashboards);
        setDashboards(available);
        const remembered = window.localStorage.getItem(SELECTED_GRAFANA_DASHBOARD_KEY);
        const selected =
          available.find((dashboard) => dashboard.uid === resolveDashboardUid(remembered ?? "")) ??
          available[0];
        setSelectedDashboardUid(selected?.uid ?? "");
      })
      .catch((reason) =>
        setDashboardsError(reason instanceof Error ? reason.message : String(reason))
      )
      .finally(() => setDashboardsLoading(false));
  };
  useEffect(() => {
    loadContext();
    loadDashboards();
  }, [contextId]);
  if (loading) return <WorkflowState state="loading" message="Loading dashboard context…" />;
  if (error)
    return <WorkflowState state="error" message={error} action="Retry" onAction={loadContext} />;
  if (!context) return <p className="muted">Dashboard context is unavailable.</p>;
  const runIds = context.variables?.run_id ?? context.runIds ?? [];
  const dashboardIndex = dashboards.findIndex(
    (dashboard) => dashboard.uid === selectedDashboardUid
  );
  const selectedDashboard = dashboards[dashboardIndex];
  const dashboardUrl = grafanaDashboardUrl(context, selectedDashboard?.uid);
  const select = (uid: string) => {
    setSelectedDashboardUid(uid);
    window.localStorage.setItem(SELECTED_GRAFANA_DASHBOARD_KEY, uid);
  };
  return (
    <section className="dashboard-panel">
      <div className="panel-heading">
        <h3>Grafana context</h3>
        <div className="button-row">
          <a href={`#dashboards/${contextId}`}>Open dashboard</a>
          <span className={`status ${context.availability}`}>{context.availability}</span>
        </div>
      </div>
      {context.availability === "available" ? (
        dashboardsLoading ? (
          <WorkflowState state="loading" message="Loading Grafana dashboards…" />
        ) : dashboardsError ? (
          <WorkflowState
            state="error"
            message="Grafana dashboards could not be loaded."
            action="Retry"
            onAction={loadDashboards}
          />
        ) : !selectedDashboard ? (
          <p className="muted">No Grafana dashboards are available yet.</p>
        ) : (
          <>
            <div className="button-row dashboard-actions">
              <label className="dashboard-picker">
                <span>Grafana dashboard</span>
                <select
                  aria-label="Grafana dashboard"
                  value={selectedDashboardUid}
                  onChange={(event) => select(event.target.value)}
                >
                  {groupGrafanaDashboards(dashboards).map((group) => (
                    <optgroup key={group.title} label={group.title}>
                      {group.dashboards.map((dashboard) => (
                        <option key={dashboard.uid} value={dashboard.uid}>
                          {dashboard.title}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <span>
                Dashboard {dashboardIndex + 1} of {dashboards.length}
              </span>
              {dashboardUrl && (
                <a
                  className="button secondary"
                  href={dashboardUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Grafana
                </a>
              )}
              {dashboards.length > 1 && (
                <>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      select(
                        dashboards[(dashboardIndex - 1 + dashboards.length) % dashboards.length].uid
                      )
                    }
                  >
                    Previous dashboard
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => select(dashboards[(dashboardIndex + 1) % dashboards.length].uid)}
                  >
                    Next dashboard
                  </button>
                </>
              )}
            </div>
            {dashboardUrl ? (
              <iframe
                className="grafana-dashboard-frame"
                title="ParkBench Grafana dashboard"
                src={dashboardUrl}
              />
            ) : (
              <WorkflowState
                state="error"
                message="Grafana dashboard URL is unavailable."
                action="Retry"
                onAction={loadDashboards}
              />
            )}
          </>
        )
      ) : (
        <WorkflowState
          state="error"
          message={
            context.availability === "expired"
              ? "Run metrics have expired from Prometheus and are no longer available for charts. Saved summaries remain available."
              : `Grafana is unavailable for ${runIds.length} selected run${runIds.length === 1 ? "" : "s"}. Stored evidence remains available.`
          }
          action="Retry"
          onAction={() => {
            loadContext();
            loadDashboards();
          }}
        />
      )}
    </section>
  );
}
