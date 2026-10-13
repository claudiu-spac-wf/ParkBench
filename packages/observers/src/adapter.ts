import type { OpenEdgeDbLatchInventory } from "../../contracts/src/openedge";
import { MetricLabels, MetricSample } from "../../contracts/src/metrics";
export interface ObserverContext {
  runId: string;
  experimentId: string;
  variantId: string;
  repetition: number;
  phase: string;
}
export interface ObserverAdapter {
  id: string;
  kind: string;
  ready(): Promise<boolean>;
  latchInventory?(context: ObserverContext): Promise<OpenEdgeDbLatchInventory>;
  sample(context: ObserverContext): Promise<MetricSample[]>;
}
export function observerLabels(
  context: ObserverContext,
  component: string,
  service: string
): MetricLabels {
  return {
    experiment_id: context.experimentId,
    run_id: context.runId,
    variant_id: context.variantId,
    repetition: String(context.repetition),
    component,
    service,
    phase: context.phase as any
  };
}
