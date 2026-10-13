import { describe, it } from "node:test";
import assert from "node:assert";
import { VersionedCatalog, validateScenario } from "../../packages/contracts/src";
import { ObserverRegistry, validateBuiltinObserverDeclaration } from "../../packages/observers/src";
import scenario from "../../examples/scenarios/crud-rest.json";
describe("scenario extensibility", () => {
  it("keeps immutable versioned documents", () => {
    const catalog = new VersionedCatalog();
    catalog.add(validateScenario(scenario));
    assert.equal(catalog.list()[0].version, "1.0.0");
  });

  it("rejects malformed built-in declarations before resource creation", () => {
    const declaration: any = {
      ...scenario.observers[0],
      configuration: undefined
    };
    assert.throws(
      () => validateBuiltinObserverDeclaration(declaration),
      /observer_metrics_url_required/
    );
    assert.throws(
      () =>
        validateBuiltinObserverDeclaration({
          ...scenario.observers[0],
          metrics: ["parkbench_workload_requests_total", "not a metric"]
        } as any),
      /observer_metric_invalid/
    );
  });

  it("requires a registered extension to expose the full observer lifecycle", () => {
    const registry = new ObserverRegistry([{ kind: "broken_v1", factory: () => undefined }]);
    assert.throws(
      () =>
        registry.validateDeclaration({
          id: "broken",
          kind: "broken_v1",
          required: true,
          samplingIntervalSeconds: 1,
          metrics: ["parkbench_broken_value"]
        }),
      /observer_lifecycle_invalid/
    );
  });
});
