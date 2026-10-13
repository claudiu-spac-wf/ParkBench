import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fixtures from "../fixtures/image-references.json";
import {
  ImageReferenceError,
  imageIdentitySnapshot,
  parseImageReference,
  isValidImageReference
} from "../../packages/contracts/src/image-reference";

describe("explicit tagged image references", () => {
  it("accepts tagged references with optional digest identity", () => {
    for (const item of fixtures.accepted) {
      const parsed = parseImageReference(item.reference);
      assert.equal(parsed.identityStrength, item.identityStrength);
      assert.equal(parsed.reference, item.reference);
    }
  });

  it("rejects unsafe or incomplete reference forms with actionable codes", () => {
    for (const item of fixtures.rejected) {
      assert.throws(
        () => parseImageReference(item.reference),
        (error: unknown) => error instanceof ImageReferenceError && error.code === item.code
      );
      assert.equal(isValidImageReference(item.reference), false);
    }
  });

  it("records tag identity without retaining a resolved Docker digest", () => {
    const snapshot = imageIdentitySnapshot("parkbench/loadgen:local", {
      Id: "sha256:" + "1".repeat(64),
      RepoDigests: ["parkbench/loadgen@sha256:" + "2".repeat(64)]
    });
    assert.equal(snapshot.configuredReference, "parkbench/loadgen:local");
    assert.equal(snapshot.identityStrength, "tag");
    assert.equal("digest" in snapshot, false);
    assert.equal("imageId" in snapshot, false);
  });
});
