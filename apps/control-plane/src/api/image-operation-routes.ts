import { CONTROL_UI_CONTRACT_VERSION } from "../../../../packages/contracts/src";
import { Platform } from "../platform";
import { sendControlUiError } from "./control-ui-errors";

export function registerImageOperationRoutes(app: any, platform: Platform): void {
  app.post("/api/v1/image-operations", async (_request: any, reply: any) => {
    reply.code(410);
    return { error: "operation_retired" };
  });
  app.get("/api/v1/image-operations/:operationId", async (request: any, reply: any) => {
    const operation = platform.controlUi.getImageOperation(request.params.operationId);
    return (
      (operation && {
        contractVersion: CONTROL_UI_CONTRACT_VERSION,
        operationId: operation.id,
        ...operation
      }) ??
      sendControlUiError(
        reply,
        new Error("image_operation_not_found"),
        "image_operation_not_found",
        404
      )
    );
  });
  app.post("/api/v1/image-operations/:operationId/cancel", async (_request: any, reply: any) => {
    reply.code(410);
    return { error: "operation_retired" };
  });
  app.post("/api/v1/image-operations/:operationId/retry", async (_request: any, reply: any) => {
    reply.code(410);
    return { error: "operation_retired" };
  });
}
