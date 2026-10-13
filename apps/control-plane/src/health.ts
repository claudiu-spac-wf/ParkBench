import { MetricSample } from "../../../packages/contracts/src/metrics";
import { Run } from "../../../packages/contracts/src/run";
import { PrometheusClient } from "../../../packages/metrics/src/prometheus-client";

export function dependencyHealth(
  input: { sqlite?: string; docker?: string; prometheus?: string } = {}
) {
  const dependencies = {
    sqlite: input.sqlite ?? "healthy",
    docker: input.docker ?? "healthy",
    prometheus: input.prometheus ?? "healthy"
  };
  return {
    status: Object.values(dependencies).every((status) => status === "healthy")
      ? "healthy"
      : "unavailable",
    dependencies,
    checkedAt: new Date().toISOString()
  };
}

export interface LiveRunHealth {
  status: "healthy" | "degraded" | "unknown";
  services: Record<string, { status: "healthy" | "degraded" | "unknown"; asOf?: string }>;
  observers: Record<string, unknown>;
  completeness?: unknown;
  latestEventId: number;
  latestEventAt?: string;
  asOf: string;
  stale: boolean;
}

export async function liveRunHealth(
  run: Run,
  events: Array<{ id: number; occurredAt: string }>,
  prometheus: PrometheusClient
): Promise<LiveRunHealth> {
  const latestEvent = events.at(-1);
  try {
    const samples = await prometheus.queryInstant(`{run_id="${run.id}"}`);
    return buildLiveRunHealth(run, samples, latestEvent, false);
  } catch {
    return buildLiveRunHealth(run, [], latestEvent, true);
  }
}

export function buildLiveRunHealth(
  run: Run,
  samples: MetricSample[],
  latestEvent?: { id: number; occurredAt: string },
  stale = false
): LiveRunHealth {
  const services: LiveRunHealth["services"] = {};
  for (const sample of samples) {
    if (!sample.metricName.endsWith("_health")) continue;
    const service = sample.labels.service;
    if (!service) continue;
    services[service] = {
      status: sample.value > 0 ? "healthy" : "degraded",
      asOf: new Date(sample.timestamp * 1000).toISOString()
    };
  }
  const observerRecords = (run.observerHealth?.observers ?? {}) as Record<string, unknown>;
  const status = stale
    ? "unknown"
    : Object.values(services).some((service) => service.status === "degraded")
      ? "degraded"
      : Object.keys(services).length
        ? "healthy"
        : "unknown";
  return {
    status,
    services,
    observers: observerRecords,
    completeness: run.completeness,
    latestEventId: latestEvent?.id ?? 0,
    latestEventAt: latestEvent?.occurredAt,
    asOf: new Date().toISOString(),
    stale
  };
}
