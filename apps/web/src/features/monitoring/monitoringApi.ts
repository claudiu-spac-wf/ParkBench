import { api, idempotencyKey } from "../../api";
export const getRun = (id: string) => api<any>(`/runs/${id}`);
export const getMetrics = (
  id: string,
  options: { phase?: string; metric?: string; operation?: string; instant?: boolean } = {}
) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options))
    if (value !== undefined) params.set(key, String(value));
  const query = params.toString();
  return api<any>(`/runs/${encodeURIComponent(id)}/metrics${query ? `?${query}` : ""}`);
};
export const getEvents = (id: string, after = 0) => api<any>(`/runs/${id}/events?after=${after}`);
export const cancelRun = (id: string) =>
  api<any>(`/runs/${id}/cancel`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey() },
    body: "{}"
  });
