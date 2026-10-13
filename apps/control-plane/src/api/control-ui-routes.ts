import { PLATFORM_RUN_PARAMETER_DEFINITIONS } from "../../../../packages/contracts/src/run-parameters";
import { DATABASE_RUN_CONTROL_DEFINITIONS } from "../../../../packages/contracts/src/database-run-controls";
import { sendControlUiError } from "./control-ui-errors";
import { Platform } from "../platform";
import { UI_OPTIONS_CONTRACT_VERSION } from "../../../../packages/contracts/src";
import { databaseParameterOptions } from "../../../../packages/contracts/src/database-parameter-options";
import { registerCatalogRoutes } from "./catalog-routes";
import { registerImageOperationRoutes } from "./image-operation-routes";
import { registerScenarioRoutes } from "./scenario-routes";
import { registerExperimentRoutes } from "./experiment-routes";
import { registerQueueRoutes } from "./queue-routes";
import { registerHistoryRoutes } from "./history-routes";
import { registerComparisonRoutes } from "./comparison-routes";
import { registerOverviewRoutes } from "./overview-routes";

export function registerControlUiRoutes(app: any, platform: Platform): void {
  app.get("/api/v1/runs/:runId/comparison-summary", async (request: any, reply: any) => {
    const run = platform.repositories.getRun(request.params.runId);
    if (!run) return sendControlUiError(reply, new Error("run_not_found"), "run_not_found", 404);
    try {
      const reader = platform.controlUi.comparisonSummaryReader(),
        summary = reader.read(run.id);
      if (summary.status === "RECOMPUTING") reply.header("Retry-After", "2");
      let limit = request.query?.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("summary_page_limit_invalid");
      let result: any;
      do {
        const tablePage =
          summary.status === "READY"
            ? reader.page(run.id, { cursor: request.query?.cursor, limit, tablesOnly: true })
            : { rows: [], hasMore: false, returnedRowCount: 0, totalRowCount: 0 };
        result = { contractVersion: "run-summary.v1", runId: run.id, ...summary, tablePage };
        if (Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024) break;
        if (limit === 1) throw new Error("summary_limit_exceeded:read_response");
        limit = Math.max(1, Math.floor(limit / 2));
      } while (true);
      if (summary.status === "LEGACY")
        result.legacyReferences = platform.repositories
          .listArtifacts(run.id)
          .filter((a) =>
            ["run_evidence", "load_summary", "raw_prometheus_timeseries"].includes(a.kind)
          )
          .map((a) => ({ id: a.id, path: a.path }));
      return result;
    } catch (error) {
      return sendControlUiError(reply, error, (error as Error).message, 400);
    }
  });
  app.get("/api/v1/ui-options", async () => {
    return {
      contractVersion: UI_OPTIONS_CONTRACT_VERSION,
      databaseParameters: databaseParameterOptions({
        version: platform.config.openedge.version,
        features: platform.config.openedge.databaseFeatures
      }),
      runParameters: [...PLATFORM_RUN_PARAMETER_DEFINITIONS, ...DATABASE_RUN_CONTROL_DEFINITIONS]
    };
  });
  registerCatalogRoutes(app, platform);
  registerImageOperationRoutes(app, platform);
  registerScenarioRoutes(app, platform);
  registerExperimentRoutes(app, platform);
  registerQueueRoutes(app, platform);
  registerHistoryRoutes(app, platform);
  registerComparisonRoutes(app, platform);
  registerOverviewRoutes(app, platform);
}
