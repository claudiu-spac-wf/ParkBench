import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../../packages/contracts/src";

describe("control UI service primitives", () => {
  it("canonicalizes nested values deterministically", () => {
    assert.equal(
      stableJson({ z: { b: 2, a: 1 }, a: [3, 2, 1] }),
      '{"a":[3,2,1],"z":{"a":1,"b":2}}'
    );
  });
});
