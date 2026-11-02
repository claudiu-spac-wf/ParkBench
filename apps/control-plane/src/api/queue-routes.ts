import { Platform } from "../platform";
import { sendControlUiError } from "./control-ui-errors";

export function registerQueueRoutes(app: any, platform: Platform): void {
  app.get("/api/v1/queue", async () => {
    const activeExperiment = platform.controlUi.runningExperimentId();
    const queued = platform.controlUi.listQueue();
    return {
      contractVersion: "control-ui.v1",
      activeExperiment,
      items: queued,
      hasMore: false,
      nextRetryAt: queued
        .map((run) => run.nextRetryAt)
        .filter(Boolean)
        .sort()[0]
    };
  });
  app.post("/api/v1/queue/start", async (request: any, reply: any) => {
    try {
      const key = request.headers?.["idempotency-key"];
      if (key) {
        const previous = platform.controlRepository.getCommandResult("queue-start", key);
        if (previous) {
          reply.code(previous.statusCode);
          return previous.response;
        }
      }
      const response = await platform.controlUi.startQueue();
      reply.code(202);
      if (key) platform.controlRepository.saveCommandResult("queue-start", key, 202, response);
      return response;
    } catch (error) {
      return sendControlUiError(reply, error, "queue_start_failed", 409);
    }
  });
  app.post("/api/v1/queue/runs/:runId/cancel", async (request: any, reply: any) => {
    try {
      const key = request.headers?.["idempotency-key"];
      const operation = `queue-cancel:${request.params.runId}`;
      if (key) {
        const previous = platform.controlRepository.getCommandResult(operation, key);
        if (previous) {
          reply.code(previous.statusCode);
          return previous.response;
        }
      }
      const response = platform.controlUi.cancel(request.params.runId);
      reply.code(202);
      if (key) platform.controlRepository.saveCommandResult(operation, key, 202, response);
      return response;
    } catch (error) {
      return sendControlUiError(reply, error, "run_cancellation_failed", 409);
    }
  });
}
