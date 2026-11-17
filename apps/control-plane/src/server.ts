import { createPlatform, Platform } from "./platform";
import { registerRoutes } from "./routes";
import Fastify from "fastify";
import cors from "@fastify/cors";
export function buildServer(platform = createPlatform()) {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 256 } });
  void app.register(cors, { origin: false });
  app.addHook("preHandler", async (request: any, reply: any) =>
    platform.experimentActions.registerRead(request, reply)
  );
  app.setErrorHandler((error: any, _request, reply) => {
    const code = error.message ?? "request_failed";
    const status = /unavailable_experiment_rerun|dashboard_context_execution_replaced/.test(code)
      ? 410
      : code === "experiment_action_in_progress"
        ? 409
        : undefined;
    if (status)
      return reply.code(status).send({
        error: {
          code,
          message:
            status === 410
              ? "An experiment in this comparison was rerun. Create a new comparison."
              : "Experiment cleanup is in progress.",
          details: {
            contractVersion: "comparison-availability.v1",
            ...(_request.params?.comparisonId
              ? { comparisonId: _request.params.comparisonId }
              : {}),
            retryable: false,
            action: "CREATE_NEW_COMPARISON"
          }
        }
      });
    reply.send(error);
  });
  registerRoutes(app, platform);
  const startupRecovery = (platform as Platform & { startupRecovery?: Promise<number> })
    .startupRecovery;
  if (startupRecovery) app.addHook("onReady", async () => void (await startupRecovery));
  app.addHook("onReady", async () => void (await platform.discoveryReady));
  app.addHook("onClose", async () => platform.close());
  return app;
}
export { Platform };
