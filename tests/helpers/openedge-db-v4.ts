import { fixtureCollectorSnapshot } from "./openedge-db-v2";
import fixture from "../fixtures/openedge/named-latches.json";

export function namedLatchSnapshot(): any {
  const snapshot = fixtureCollectorSnapshot();
  snapshot.protocolVersion = 4;
  snapshot.database.name = "owned-db";
  snapshot.labels = { tables: [], indexes: [] };
  snapshot.snapshot._Latch = structuredClone(fixture.instances);
  // The collector declares exhaustive capture; the adapter may not infer completeness from a subset.
  snapshot.latchInventory = {
    complete: true,
    count: fixture.instances.length,
    runId: "owned-run",
    authoritativePublisher: "endpoint"
  };
  return snapshot;
}
