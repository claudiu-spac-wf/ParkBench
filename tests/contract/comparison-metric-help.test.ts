import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARISON_METRIC_CATALOG as catalog,
  COMPARISON_METRIC_CATALOG_VERSION,
  COMPARISON_METRIC_SELECTION_VERSION
} from "../../packages/contracts/src/comparison-metric-selection";
import inventory from "../fixtures/comparison-metric-selection/catalog-inventory.json";
test("all audited metric meanings retain identities and acquire meaningful shared help", () => {
  assert.deepEqual(catalog.map((d) => d.metricId).sort(), [...inventory].sort());
  assert.equal(COMPARISON_METRIC_CATALOG_VERSION as string, "comparison-metrics.v2");
  assert.equal(COMPARISON_METRIC_SELECTION_VERSION, "comparison-metric-selection.v1");
  for (const descriptor of catalog as any[]) {
    assert.equal(descriptor.version, 1);
    assert.ok(descriptor.description?.length > 20, descriptor.metricId);
    assert.ok(descriptor.scopeDescription?.length > 20, descriptor.metricId);
    assert.ok(Object.keys(descriptor.units).length);
  }
  const platform = catalog.find((d) => d.metricId === "resource.platform.cpu.usage") as any;
  assert.match(platform.scopeDescription, /not the whole host/i);
  const records = catalog.find((d) => d.metricId === "database.db.records.read") as any;
  const tables = catalog.find((d) => d.metricId === "database.db.tables.aggregate.read") as any;
  assert.notEqual(records.description, tables.description);
  assert.notEqual(records.scope, tables.scope);
});
