import { Scenario } from "../../../../packages/contracts/src/scenario";

export interface BootstrapRecord {
  environmentId: string;
  runId: string;
  state: string;
  createdAt: string;
  updatedAt?: string;
  phase?: string;
  scenario?: Scenario;
  inputs?: Record<string, unknown>;
  credentialReference?: string;
  inputProvenance?: unknown[];
  composeProject?: string;
  resolvedImages?: Record<string, unknown>;
  hostDocker?: Record<string, unknown>;
  hostCapacity?: Record<string, unknown>;
  topology?: Record<string, unknown>;
  readiness?: {
    state: string;
    services?: Record<string, unknown>;
    transitions: Array<Record<string, unknown>>;
  };
  resources?: unknown[];
  diagnostics?: unknown[];
  cleanupStatus?: string;
  closedAt?: string;
}
export class BootstrapRepository {
  private records = new Map<string, BootstrapRecord>();
  save(record: BootstrapRecord): void {
    this.records.set(record.environmentId, record);
  }
  get(environmentId: string): BootstrapRecord | undefined {
    return this.records.get(environmentId);
  }
}
