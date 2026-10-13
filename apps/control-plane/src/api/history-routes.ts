import { Platform } from "../platform";
import { queryString } from "./control-ui-errors";

export function registerHistoryRoutes(app: any, platform: Platform): void {
  app.get("/api/v1/history/runs", async (request: any) => {
    const filters = {
      experiment: queryString(request, "experiment"),
      status: queryString(request, "status"),
      runId: queryString(request, "runId"),
      scenario: queryString(request, "scenario"),
      workload: queryString(request, "workload"),
      image: queryString(request, "image"),
      parameter: queryString(request, "parameter"),
      repetition: queryString(request, "repetition"),
      from: queryString(request, "from"),
      to: queryString(request, "to")
    };
    const page = platform.controlUi.historyPage(
      filters,
      queryString(request, "pageToken"),
      Number(queryString(request, "pageSize"))
    );
    return {
      contractVersion: "control-ui.v1",
      ...page
    };
  });
  app.get("/api/v1/history/runs/:runId", async (request: any, reply: any) => {
    const detail = platform.controlUi.historyDetail(request.params.runId);
    if (detail) return detail;
    reply.code(404);
    return {
      error: {
        code: "history_run_not_found",
        message: "The requested historical run was not found."
      }
    };
  });
}
