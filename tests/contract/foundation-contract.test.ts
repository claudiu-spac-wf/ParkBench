import { describe, it } from "node:test";
import assert from "node:assert";
import scenario from "../../examples/scenarios/crud-rest.json";
import { validateScenario, ValidationError } from "../../packages/contracts/src";
import {
  buildRunLabels,
  requireDiskIoSources,
  calculateCompleteness,
  summarize
} from "../../packages/metrics/src";
import { validateMatrix } from "../../apps/control-plane/src/experiments/matrix";
describe("foundation contracts", () => {
  it("returns stable field paths for invalid scenarios", () => {
    assert.throws(
      () =>
        validateScenario({ ...scenario, phases: { ...scenario.phases, measurementSeconds: 0 } }),
      (error: any) =>
        error instanceof ValidationError &&
        error.fields.some((field: any) => field.path === "/phases/measurementSeconds")
    );
  });
  it("allows comparative matrices without a submission-time baseline", () => {
    assert.doesNotThrow(() =>
      validateMatrix({
        scenario: { id: "crud-rest", version: "1.0.0" },
        comparisonMode: "comparative",
        repetitions: 1,
        variants: [{ id: "v", name: "v", parameters: {} }],
        inputs: {} as any
      })
    );
  });
  it("keeps required run labels and independent disk sources", () => {
    const labels = buildRunLabels({
      experiment_id: "e",
      run_id: "r",
      variant_id: "v",
      repetition: "1",
      component: "host",
      service: "node-exporter",
      phase: "measurement"
    });
    assert.equal(labels.run_id, "r");
    assert.throws(
      () => requireDiskIoSources({ cadvisor: false, nodeExporterBlockDevice: true }),
      /required_disk_io_source_unavailable/
    );
  });
  it("records gaps instead of turning absent samples into zero", () => {
    const result = calculateCompleteness([
      { observerId: "disk", phase: "measurement", expected: 2, observed: 1, required: true }
    ]);
    assert.equal(result.complete, false);
    assert.equal(result.requiredGaps[0].missing, 1);
    assert.deepEqual(summarize([], "run"), []);
  });
});
