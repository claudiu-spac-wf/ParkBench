import { randomUUID } from "node:crypto";
import type { OpenEdgeDbObserverPayload } from "../../contracts/src/openedge";
import catalog from "../../contracts/src/openedge-db-metric-catalog.json";
export interface NativeMeasurementInventory {
  contractVersion: "measurement-native-inventory.v1";
  evidenceId: string;
  runId: string;
  capturedAtMs: number;
  dimensions: Record<string, string[]>;
  availability: Array<{
    metricName: string;
    dimensions: Record<string, string>;
    availability: string;
    reasonCode: string;
    sourceRef: string;
  }>;
}
/** Independent native availability inventory, including readings absent from metrics.
 * This copies configuration/identity/availability metadata, never measurement values. */
export function nativeMeasurementInventory(
  payload: OpenEdgeDbObserverPayload,
  runId: string
): NativeMeasurementInventory {
  const dimensions = new Map<string, Set<string>>(),
    availability: NativeMeasurementInventory["availability"] = [];
  const add = (name: string, value: string) => {
    if (value) {
      const values = dimensions.get(name) ?? new Set<string>();
      values.add(value);
      dimensions.set(name, values);
    }
  };
  if (payload.protocolVersion === 4) {
    // Protocol4 ABL enumerates all application tables independently of VST
    // readings. Index labels are capped and deliberately have no such proof.
    add("table_inventory_contract", "openedge-db.v4.application-tables-complete");
    for (const table of payload.labels.tables) add("application_table", table);
    add("database", payload.latchInventory.database);
    add("database_epoch", payload.latchInventory.databaseEpoch);
    for (const latch of payload.latchInventory.instances) {
      for (const [key, value] of Object.entries(latch))
        if (typeof value === "string" || typeof value === "number") add(key, String(value));
    }
  }
  for (const family of payload.families)
    for (const measurement of family.measurements) {
      const definition = catalog.entries.find((entry) => entry.name === measurement.name);
      const identity = Object.fromEntries(
        Object.entries(measurement.labels ?? {}).filter(([key]) =>
          definition?.dimensions.includes(key)
        )
      );
      for (const [key, value] of Object.entries(identity)) add(key, value);
      availability.push({
        metricName: `parkbench_openedge_db_${measurement.name}`,
        dimensions: identity,
        availability: measurement.availability,
        reasonCode: measurement.reason,
        sourceRef: measurement.source
      });
    }
  return {
    contractVersion: "measurement-native-inventory.v1",
    evidenceId: randomUUID(),
    runId,
    capturedAtMs: Date.parse(payload.collectedAt),
    dimensions: Object.fromEntries(
      [...dimensions]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, values]) => [name, [...values].sort()])
    ),
    availability
  };
}
