import { Platform } from "../platform";
import { sendControlUiError } from "./control-ui-errors";

export function registerComparisonRoutes(app: any, platform: Platform): void {
  app.post(
    "/api/v1/comparisons/:comparisonId/metric-values",
    { bodyLimit: 256 * 1024 },
    async (request: any, reply: any) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.on("aborted", abort);
      try {
        return await platform.controlUi.getComparisonMetricValues(
          request.params.comparisonId,
          request.body,
          controller.signal
        );
      } catch (error) {
        return sendControlUiError(
          reply,
          error,
          (error as Error).message,
          (error as Error).message === "comparison_not_found" ? 404 : 400
        );
      } finally {
        request.raw.off("aborted", abort);
      }
    }
  );
  app.post(
    "/api/v1/comparisons",
    { bodyLimit: Number.MAX_SAFE_INTEGER },
    async (request: any, reply: any) => {
      try {
        const comparison = platform.controlUi.createComparison(request.body);
        reply.code(201);
        return comparison;
      } catch (error) {
        return sendControlUiError(reply, error, (error as Error).message, 400);
      }
    }
  );
  app.get("/api/v1/comparisons/:comparisonId/selection", async (request: any, reply: any) => {
    try {
      const value = platform.controlUi.getComparisonSelectionPage(request.params.comparisonId, {
        cursor: request.query?.cursor,
        limit: request.query?.limit
      });
      return (
        value ??
        sendControlUiError(reply, new Error("comparison_not_found"), "comparison_not_found", 404)
      );
    } catch (error) {
      return sendControlUiError(reply, error, (error as Error).message, 400);
    }
  });
  app.get(
    "/api/v1/comparisons/:comparisonId/runs/:runId/tables",
    async (request: any, reply: any) => {
      try {
        const value = platform.controlUi.getComparisonTables(
          request.params.comparisonId,
          request.params.runId,
          { cursor: request.query?.cursor, limit: request.query?.limit }
        );
        return (
          value ??
          sendControlUiError(reply, new Error("comparison_not_found"), "comparison_not_found", 404)
        );
      } catch (error) {
        return sendControlUiError(reply, error, (error as Error).message, 400);
      }
    }
  );
  app.get("/api/v1/dashboards/context/:contextId", async (request: any, reply: any) => {
    const context = await platform.controlUi.getDashboardForUi(request.params.contextId);
    return (
      context ??
      sendControlUiError(
        reply,
        new Error("dashboard_context_not_found"),
        "dashboard_context_not_found",
        404
      )
    );
  });
}
