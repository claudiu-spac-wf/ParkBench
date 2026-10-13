import { MetricSample } from "../../../contracts/src/metrics";
import { ObserverAdapter, ObserverContext, observerLabels } from "../adapter";
import { PAS_WEB_METRICS, pasMetricDefinition, normalizePasMetrics } from "./metrics";
export class OpenEdgePasObserver implements ObserverAdapter {
  id = "openedge-pas";
  kind = "openedge_pas_v1";
  private readonly replicas: number[];
  constructor(
    private readonly sampleFn: (
      replica: number,
      context?: ObserverContext
    ) => Promise<Record<string, number> | MetricSample[]>,
    replica: number | number[] = 1,
    private readonly readyFn: () => Promise<boolean> = async () => true
  ) {
    this.replicas = Array.isArray(replica) ? replica : [replica];
    if (this.replicas.some((r) => !Number.isInteger(r) || r < 1))
      throw new Error("pas_replica_invalid");
  }
  async ready() {
    return this.readyFn();
  }
  async sample(context: ObserverContext): Promise<MetricSample[]> {
    return (
      await Promise.all(
        this.replicas.map(async (replica) => {
          const payload = await this.sampleFn(replica, context);
          const labels = observerLabels(context, "pas", `pas-${replica}`);
          if (Array.isArray(payload))
            return payload
              .filter(
                (s) =>
                  s.metricName.startsWith("parkbench_openedge_pas_") &&
                  pasMetricDefinition(s.metricName.slice("parkbench_openedge_pas_".length)) &&
                  Number.isFinite(s.value)
              )
              .map((s) => ({
                ...s,
                type: pasMetricDefinition(s.metricName.slice("parkbench_openedge_pas_".length))
                  .type,
                labels: { ...s.labels, ...labels, replica: `pas-${replica}` }
              }));
          return Object.entries(normalizePasMetrics(payload)).flatMap(([name, value]) => {
            const definition = PAS_WEB_METRICS[name] ?? pasMetricDefinition(name);
            if (!definition) return [];
            return [
              {
                metricName: `parkbench_openedge_pas_${definition.suffix}`,
                type: definition.type,
                labels: { ...labels, replica: `pas-${replica}` },
                timestamp: Date.now() / 1000,
                value: value * (PAS_WEB_METRICS[name]?.scale ?? 1),
                source: "pas-management"
              }
            ];
          });
        })
      )
    ).flat();
  }
}
