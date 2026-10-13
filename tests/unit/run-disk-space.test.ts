import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { checkRunRootSpace } from "../../packages/compose-runner/src/input-checks";

describe("run root free space", () => {
  it("needs room for one more seed copy with 20% headroom", () => {
    const seed = { sizeBytes: 1000 };
    checkRunRootSpace(seed, os.tmpdir(), () => 1200);
    assert.throws(
      () => checkRunRootSpace(seed, os.tmpdir(), () => 1199),
      /insufficient_disk_space:run_root/
    );
    checkRunRootSpace(seed, "/definitely/missing/run/root", () => 5000);
  });
});
