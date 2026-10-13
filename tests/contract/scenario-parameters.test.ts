import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateParameterConfiguration,
  validateParameterValue
} from "../../packages/contracts/src/matrix-expansion";

describe("scenario parameter contract", () => {
  it("enforces typed range values", () => {
    const definition: any = {
      canonicalName: "-B",
      type: "integer",
      minimum: 1,
      maximum: 10,
      matrixAllowed: true,
      secret: false
    };
    assert.doesNotThrow(() => validateParameterValue(definition, 5));
    assert.throws(() => validateParameterValue(definition, 11), /parameter_above_maximum/);
    assert.throws(() => validateParameterValue(definition, "5"), /invalid_parameter_type/);
  });

  it("rejects malformed and unsatisfied dependency rules", () => {
    const definitions: any[] = [
      {
        canonicalName: "-B",
        type: "integer",
        minimum: 1,
        maximum: 10,
        defaultValue: 2,
        matrixAllowed: true,
        secret: false
      },
      {
        canonicalName: "-B2",
        type: "integer",
        minimum: 1,
        maximum: 10,
        defaultValue: 4,
        dependencies: [{ parameter: "-B", operator: "gte", value: 5 }],
        matrixAllowed: true,
        secret: false
      }
    ];
    assert.throws(
      () => validateParameterConfiguration(definitions, { "-B": 2, "-B2": 4 }),
      /dependency_not_satisfied:-B2:-B/
    );
    assert.throws(
      () =>
        validateParameterConfiguration(
          [
            {
              ...definitions[1],
              dependencies: [{ parameter: "-missing", operator: "eq", value: 1 }]
            }
          ],
          { "-B2": 4 }
        ),
      /dependency_parameter_unknown/
    );
  });
});
