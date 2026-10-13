import { requestId, redactSecrets, ValidationError } from "../../../../packages/contracts/src";

export function sendControlUiError(
  reply: any,
  error: unknown,
  code = "control_ui_request_failed",
  status = 422
): unknown {
  reply.code(status);
  const fields = error instanceof ValidationError ? error.fields : [];
  return {
    error: {
      code,
      message: redactSecrets(error instanceof Error ? error.message : String(error)),
      fields: redactSecrets(fields),
      requestId: requestId()
    }
  };
}

export function queryString(request: any, name: string): string | undefined {
  const value = request.query?.[name];
  return typeof value === "string" && value.length ? value : undefined;
}
