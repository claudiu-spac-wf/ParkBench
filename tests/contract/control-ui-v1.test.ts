import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_UI_CONTRACT_VERSION, stableJson } from "../../packages/contracts/src";

describe("control-ui.v1", () => {
  it("uses stable contract and canonical object ordering", () => {
    assert.equal(CONTROL_UI_CONTRACT_VERSION, "control-ui.v1");
    assert.equal(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });
});
