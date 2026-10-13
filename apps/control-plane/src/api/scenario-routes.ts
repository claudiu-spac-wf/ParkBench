import { Platform } from "../platform";
import { sendControlUiError } from "./control-ui-errors";

export function registerScenarioRoutes(app: any, platform: Platform): void {
  app.get("/api/v1/scenarios/:scenarioId/:version", async (request: any, reply: any) => {
    try {
      const scenario = platform.controlUi.getScenario(
        request.params.scenarioId,
        request.params.version
      );
      return (
        scenario ??
        sendControlUiError(reply, new Error("scenario_not_found"), "scenario_not_found", 404)
      );
    } catch (error) {
      return sendControlUiError(reply, error, "scenario_source_ambiguous", 409);
    }
  });
  app.post("/api/v1/scenarios/:scenarioId/versions", async (_request: any, reply: any) => {
    reply.code(410);
    return { error: "operation_retired" };
  });
}
