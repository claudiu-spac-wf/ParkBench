import { api, idempotencyKey } from "../../api";
export const createExperiment = (body: unknown) =>
  api<{ experimentId: string }>("/experiments", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(body)
  });
export const getSetupScripts = () =>
  api<import("../../../../../packages/contracts/src/database-setup").SetupScriptsDiscovery>(
    "/database-setup/scripts"
  );
