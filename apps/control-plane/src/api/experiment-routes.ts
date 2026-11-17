import { Platform } from "../platform";
import { sendControlUiError, queryString } from "./control-ui-errors";

export function registerExperimentRoutes(app: any, platform: Platform): void {
  const actionError = (reply: any, error: any) => {
    reply.header("Cache-Control", "no-store");
    const code = error.message ?? "experiment_action_failed";
    const status = /not_found/.test(code)
      ? 404
      : /request_invalid|confirmation_required|key_required/.test(code)
        ? 400
        : 409;
    return sendControlUiError(reply, error, code, status);
  };
  app.get("/api/v1/runs/:runId/actions", async (request: any, reply: any) => {
    try {
      reply.header("Cache-Control", "no-store");
      return platform.experimentActions.runEligibility(request.params.runId);
    } catch (error) {
      return actionError(reply, error);
    }
  });
  app.post("/api/v1/runs/:runId/actions", { bodyLimit: 4096 }, async (request: any, reply: any) => {
    try {
      const action = platform.experimentActions.submitRun(
        request.params.runId,
        request.body,
        request.headers["idempotency-key"]
      );
      reply
        .code(202)
        .header("Location", `/api/v1/experiment-actions/${action.id}`)
        .header("Cache-Control", "no-store");
      return action;
    } catch (error) {
      return actionError(reply, error);
    }
  });
  app.get("/api/v1/experiments/:experimentId/actions", async (request: any, reply: any) => {
    try {
      reply.header("Cache-Control", "no-store");
      return platform.experimentActions.eligibility(request.params.experimentId);
    } catch (error) {
      return actionError(reply, error);
    }
  });
  app.post(
    "/api/v1/experiments/:experimentId/actions",
    { bodyLimit: 4096 },
    async (request: any, reply: any) => {
      try {
        const result = platform.experimentActions.submit(
          request.params.experimentId,
          request.body,
          request.headers["idempotency-key"]
        );
        reply
          .code(202)
          .header("Location", `/api/v1/experiment-actions/${result.id}`)
          .header("Cache-Control", "no-store");
        return result;
      } catch (error) {
        return actionError(reply, error);
      }
    }
  );
  app.get("/api/v1/experiment-actions/:actionId", async (request: any, reply: any) => {
    try {
      reply.header("Cache-Control", "no-store");
      return platform.experimentActions.get(request.params.actionId);
    } catch (error) {
      return actionError(reply, error);
    }
  });
  app.post(
    "/api/v1/experiment-actions/:actionId/retry",
    { bodyLimit: 4096 },
    async (request: any, reply: any) => {
      try {
        reply.code(202).header("Cache-Control", "no-store");
        return platform.experimentActions.retry(
          request.params.actionId,
          request.body,
          request.headers["idempotency-key"]
        );
      } catch (error) {
        return actionError(reply, error);
      }
    }
  );

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
