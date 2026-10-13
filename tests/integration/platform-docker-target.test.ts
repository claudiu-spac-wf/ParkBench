import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromRepository = createRequire(path.join(process.cwd(), "package.json"));
const { verifySelectedDockerTarget } = requireFromRepository(
  path.join(process.cwd(), "scripts/lib/docker-target.cjs")
) as { verifySelectedDockerTarget(): { verified: boolean } };

describe("Docker target selection", () => {
  it("does not compare the selected Engine with a stored identity", () => {
    assert.deepEqual(verifySelectedDockerTarget(), { verified: false });
  });
});
