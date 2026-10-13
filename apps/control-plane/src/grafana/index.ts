import type { ParameterSnapshotQueries } from "./parameter-snapshots";
import type { SavedSummaryQueries } from "./summary-results";
import { registerGrafanaHealthRoute } from "./health";
import { registerOpenRedirectRoute } from "./open-redirect";
import { registerGrafanaDatasourceRoutes } from "./prom-api";
import { RunTimelineSource } from "./run-timeline";

export interface GrafanaRoutesDeps {
  metricsAvailability?: import("./prom-api").GrafanaDatasourceDeps["metricsAvailability"];
  parameterSnapshots?: ParameterSnapshotQueries;
  savedSummaries?: SavedSummaryQueries;
  prometheusUrl: string;
  grafanaUrl: string;
  timelines: RunTimelineSource;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
}

/** Registers the ParkBench Runs datasource, its health check, and the dashboard redirect. */
export function registerGrafanaRoutes(app: any, deps: GrafanaRoutesDeps): void {
  registerGrafanaDatasourceRoutes(app, deps);
  registerGrafanaHealthRoute(app, deps);
  registerOpenRedirectRoute(app, deps);
}

export { repositoryTimelineSource, timelineFromRun } from "./run-timeline";
export { alignedRange, clockRange } from "./alignment";
