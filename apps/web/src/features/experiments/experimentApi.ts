import { api, idempotencyKey } from "../../api";
export const createExperiment = (body: unknown) =>
  api<{ experimentId: string }>("/experiments", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(body)
  });
