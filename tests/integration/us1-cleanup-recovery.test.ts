import { describe, it } from "node:test";
import assert from "node:assert";
import { ownershipLabels, selectOwnedResources } from "../../packages/compose-runner/src";
describe("cleanup recovery", () => {
  it("selects only exact run ownership", () => {
    const a: any = { labels: ownershipLabels("run-a", "exp", "db") };
    const b: any = { labels: ownershipLabels("run-b", "exp", "db") };
    assert.equal(selectOwnedResources([a, b], "run-a").length, 1);
  });
});
