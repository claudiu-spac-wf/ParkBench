import { describe, it } from "node:test";
import assert from "node:assert/strict";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
import crudScenario from "../../examples/scenarios/crud-rest.json";
import { validateScenario } from "../../packages/contracts/src/validator";
import {
  validateWorkScenario,
  workProcedureNames
} from "../../packages/contracts/src/openedge-validation";
import { syntheticImageManifest } from "../helpers/openedge";

describe("generic /work scenario validation", () => {
  it("accepts the multi-operation ParkBench scenario of any id and measurement length", () => {
    const manifest = syntheticImageManifest("final");
    validateWorkScenario(scenario, manifest);
    validateWorkScenario(
      { ...scenario, id: "any-id", phases: { ...scenario.phases, measurementSeconds: 7 } },
      manifest
    );
    assert.deepEqual(workProcedureNames(scenario), ["Workloads/ParkBench/bank_mix.p"]);
  });

  it("rejects each broken rule with work_scenario_invalid", () => {
    const manifest = syntheticImageManifest("final");
    const withOperation = (patch: Record<string, unknown>) => ({
      ...scenario,
      workload: {
        ...scenario.workload,
        operations: [{ ...scenario.workload.operations[0], ...patch }]
      }
    });
    const cases: Array<[any, any, RegExp]> = [
      [
        withOperation({ bodyTemplate: { procName: "../escape.p", input: { mode: "run" } } }),
        manifest,
        /procName/
      ],
      [
        withOperation({
          bodyTemplate: { procName: "Workloads/ParkBench/other.p", input: { mode: "run" } }
        }),
        manifest,
        /procedure_missing/
      ],
      [withOperation({ expectedStatus: [201] }), manifest, /expectedStatus/],
      [
        withOperation({
          bodyTemplate: { procName: "Workloads/ParkBench/bank_mix.p", input: "run" }
        }),
        manifest,
        /input_mode/
      ],
      [{ ...scenario, phases: { ...scenario.phases, warmupSeconds: 0 } }, manifest, /warmup/],
      [{ ...scenario, phases: { ...scenario.phases, cooldownSeconds: 0 } }, manifest, /cooldown/]
    ];
    for (const [candidate, candidateManifest, expected] of cases)
      assert.throws(
        () => validateWorkScenario(candidate, candidateManifest),
        (error: Error) =>
          error.message.startsWith("work_scenario_invalid:") && expected.test(error.message)
      );
    const uncompiled = syntheticImageManifest("final");
    uncompiled.workloads[0].compiled = false;
    assert.throws(() => validateWorkScenario(scenario, uncompiled), /procedure_uncompiled/);
    const otherImage = syntheticImageManifest("final");
    otherImage.workloads[0].imageReference = "parkbench/openedge-pasoe:other";
    assert.throws(() => validateWorkScenario(scenario, otherImage), /procedure_image/);
    const noContract = syntheticImageManifest("final");
    delete noContract.workloads[0].contract;
    assert.throws(() => validateWorkScenario(scenario, noContract), /procedure_contract/);
  });
});

describe("scenario templateValues validation", () => {
  const withTemplate = (templateValues: unknown, where = "RandomInt1000 = {{band}}") => ({
    ...scenario,
    workload: {
      ...scenario.workload,
      operations: [
        {
          id: "debit-history-amounts",
          method: "POST",
          path: "/work",
          weight: 1,
          templateValues,
          bodyTemplate: {
            procName: "Workloads/ParkBench/bank_mix.p",
            input: { mode: "run", TableName: "DebitTransaction", WhereClause: where }
          },
          expectedStatus: [200]
        }
      ]
    }
  });

  it("accepts declared, used, ordered placeholders and keeps existing scenarios valid", () => {
    validateScenario(withTemplate({ band: { kind: "uniformInt", min: 1, max: 1000 } }));
    validateWorkScenario(
      withTemplate({ band: { kind: "uniformInt", min: 1, max: 1000 } }),
      syntheticImageManifest("final")
    );
    validateScenario(scenario);
    validateScenario(crudScenario);
  });

  it("rejects bounds, undeclared and unused placeholders", () => {
    const cases: Array<[any, RegExp]> = [
      [
        withTemplate({ band: { kind: "uniformInt", min: 10, max: 1 } }),
        /scenario_template_value_bounds:debit-history-amounts:band/
      ],
      [
        withTemplate({ band: { kind: "uniformInt", min: 1, max: 9 } }, "RandomInt1000 = {{other}}"),
        /scenario_template_value_undeclared:debit-history-amounts:other/
      ],
      [
        withTemplate({ band: { kind: "uniformInt", min: 1, max: 9 } }, "RandomInt1000 = 5"),
        /scenario_template_value_unused:debit-history-amounts:band/
      ]
    ];
    for (const [candidate, expected] of cases) {
      assert.throws(() => validateScenario(candidate), expected);
      assert.throws(() => validateWorkScenario(candidate, syntheticImageManifest("final")), expected);
    }
  });

  it("rejects schema violations", () => {
    const nine = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`v${index}`, { kind: "uniformInt", min: 1, max: 2 }])
    );
    const nineWhere = Object.keys(nine).map((name) => `{{${name}}}`).join(" ");
    const cases: any[] = [
      withTemplate({ "1band": { kind: "uniformInt", min: 1, max: 2 } }, "{{1band}}"),
      withTemplate(nine, nineWhere),
      withTemplate({ band: { kind: "uniformFloat", min: 1, max: 2 } }),
      withTemplate({ band: { kind: "uniformInt", min: 1.5, max: 2 } }),
      withTemplate({ band: { kind: "uniformInt", min: -2147483649, max: 2 } }),
      withTemplate({ band: { kind: "uniformInt", min: 1, max: 2147483648 } }),
      withTemplate({ band: { kind: "uniformInt", min: 1, max: 2, extra: true } }),
      withTemplate({ band: { kind: "uniformInt", min: 1 } })
    ];
    for (const candidate of cases) assert.throws(() => validateScenario(candidate));
  });
});
