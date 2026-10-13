import { RunTimelineSource } from "./run-timeline";

export interface GrafanaHealthDeps {
  prometheusUrl: string;
  timelines: RunTimelineSource;
  fetch?: typeof fetch;
}

/** GET /api/v1/grafana/health: 200 when Prometheus and the run store are usable, else 503. */
export async function grafanaDatasourceHealth(deps: GrafanaHealthDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  let prometheus: "ok" | "unavailable" = "unavailable";
  try {
    const response = await fetchImpl(`${deps.prometheusUrl.replace(/\/$/, "")}/-/ready`, {
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) prometheus = "ok";
  } catch {
    prometheus = "unavailable";
  }
  let runStore: "ok" | "unavailable" = "ok";
  try {
    deps.timelines.list();
  } catch {
    runStore = "unavailable";
  }
  const ok = prometheus === "ok" && runStore === "ok";
  return {
    status: ok ? 200 : 503,
    body: { status: ok ? "ok" : "unavailable", prometheus, runStore }
  };
}

export function registerGrafanaHealthRoute(app: any, deps: GrafanaHealthDeps): void {
  app.get("/api/v1/grafana/health", async (_request: any, reply: any) => {
    const result = await grafanaDatasourceHealth(deps);
    reply.code(result.status);
    return result.body;
  });
}
