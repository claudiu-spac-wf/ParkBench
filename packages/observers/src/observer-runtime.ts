import { ObserverDeclaration } from "../../contracts/src/scenario";
import { MetricSample } from "../../contracts/src/metrics";
import { ObserverContext, ObserverAdapter } from "./adapter";
import { observerDiagnostic, ObserverDiagnostic } from "./diagnostics";
export class ObserverRuntime {
  diagnostics: ObserverDiagnostic[] = [];
  constructor(
    public readonly declaration: ObserverDeclaration,
    private readonly adapter: ObserverAdapter
  ) {}
  async ready(): Promise<boolean> {
    return this.adapter.ready();
  }
  async latchInventory(context: ObserverContext) {
    if (!this.adapter.latchInventory)
      throw new Error("named_latch_evidence_missing:collector_protocol");
    return this.adapter.latchInventory(context);
  }
  async sample(context: ObserverContext): Promise<MetricSample[]> {
    try {
      return await this.adapter.sample(context);
    } catch (error) {
      this.diagnostics.push(
        observerDiagnostic(this.declaration.id, context.phase, "sample_failed", String(error))
      );
      throw error;
    }
  }
}
