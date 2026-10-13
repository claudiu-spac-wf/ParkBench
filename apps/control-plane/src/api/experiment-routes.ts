import { Platform } from "../platform";
import { sendControlUiError, queryString } from "./control-ui-errors";

export function registerExperimentRoutes(app: any, platform: Platform): void {
  app.post("/api/v1/experiments/preview", async (request: any, reply: any) => {
    try {
      return platform.controlUi.preview(
        request.body,
        queryString(request, "pageToken"),
        Number(request.query?.pageSize)
      );
    } catch (error) {
      return sendControlUiError(reply, error, "matrix_validation_failed");
    }
  });
  app.get("/api/v1/experiments/previews/:previewId/cells", async (request: any, reply: any) => {
    try {
      return platform.controlUi.previewCells(
        request.params.previewId,
        queryString(request, "pageToken"),
        Number(request.query?.pageSize)
      );
    } catch (error) {
      return sendControlUiError(reply, error, "preview_not_available", 409);
    }
  });
  app.post("/api/v1/experiments/submit", async (request: any, reply: any) => {
    try {
      const result = platform.controlUi.submit(request.body, request.headers?.["idempotency-key"]);
      reply.code(202);
      return result;
    } catch (error) {
      return sendControlUiError(reply, error, "experiment_submission_failed");
    }
  });
}
