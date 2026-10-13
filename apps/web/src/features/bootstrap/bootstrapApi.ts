import { api } from "../../api";
export const preflight = (body: unknown) =>
  api<{ valid: boolean }>("/preflight", { method: "POST", body: JSON.stringify(body) });
export const bootstrap = (body: unknown) =>
  api<any>("/environments/bootstrap", { method: "POST", body: JSON.stringify(body) });
