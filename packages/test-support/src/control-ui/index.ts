import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createManagedInputFixture(): {
  root: string;
  roots: Record<"scenarios" | "workloads" | "observers" | "seeds" | "archives", string>;
  configuredInputs: { databaseImage: string; pasImage: string; credentialRef: string };
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-inputs-"));
  const roots = {
    scenarios: path.join(root, "scenarios"),
    workloads: path.join(root, "workloads"),
    observers: path.join(root, "observers"),
    seeds: path.join(root, "seeds"),
    archives: path.join(root, "archives")
  };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true });
  return {
    root,
    roots,
    configuredInputs: {
      databaseImage: "parkbench/openedge-db:fixture",
      pasImage: "parkbench/openedge-pas:fixture",
      credentialRef: "credential:pas-metrics-fixture"
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

export const fakeControlUiAssets = [
  {
    id: "asset_fake_db",
    kind: "database_image",
    name: "Fake database",
    version: "1",
    immutableRef: "fake-db:fixture",
    verificationState: "VERIFIED"
  },
  {
    id: "asset_fake_pas",
    kind: "pas_image",
    name: "Fake PAS",
    version: "1",
    immutableRef: "fake-pas:fixture",
    verificationState: "VERIFIED"
  },
  {
    id: "asset_fake_workload",
    kind: "workload",
    name: "Fake workload",
    version: "1",
    immutableRef: "workload:fake:fixture",
    verificationState: "VERIFIED"
  }
] as const;

export function fakeOperationId(): string {
  return `imgop_fake_${crypto.randomUUID()}`;
}

export function fakeMatrixRequest(): Record<string, unknown> {
  return {
    scenario: { id: "crud-rest", version: "1.0.0" },
    dimensions: [
      { name: "-B", values: [500, 1000, 1500, 2000] },
      { name: "-B2", values: [500, 1000, 1500, 2000] }
    ],
    repetitions: 1,
    fixedOverrides: {}
  };
}

export class FakeControlUiServices {
  private capacityAvailable = true;
  setCapacityAvailable(value: boolean): void {
    this.capacityAvailable = value;
  }
  isCapacityAvailable(): boolean {
    return this.capacityAvailable;
  }
  reset(): void {
    this.capacityAvailable = true;
  }
}
