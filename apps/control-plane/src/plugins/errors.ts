export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  fields: unknown[] = []
) {
  return { error: { code, message, requestId, fields } };
}
