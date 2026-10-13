import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_OPERATION_STATES } from "../../packages/contracts/src/image-operation";

describe("image-operation.v1", () => {
  it("exposes only controlled durable states", () => {
    assert.deepEqual(IMAGE_OPERATION_STATES, [
      "REQUESTED",
      "VALIDATING",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED"
    ]);
  });
});
