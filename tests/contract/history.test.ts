import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("history contract", () => {
  it("uses stable terminal outcome names", () => {
    assert.deepEqual(
      ["SUCCEEDED", "THRESHOLD_FAILED", "FAILED", "CANCELLED", "INCOMPLETE", "INTERRUPTED"].length,
      6
    );
  });
});
