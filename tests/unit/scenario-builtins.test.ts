import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";

describe("checked-in scenario discovery", () => {
  it("retains authored schedules for smoke, reads, writes and stable reads without discovering calibration evidence", () => {
    const entries = new ScenarioFileSource(path.resolve("examples/scenarios")).list();
    assert.equal(entries.length, 8);
    for (const entry of entries) {
      const scenario = JSON.parse(
        fs.readFileSync(path.resolve("examples/scenarios", entry.relativePath), "utf8")
      );
      const expected =
        scenario.id === "parkbench-read-stable"
          ? { warmupSeconds: 120, measurementSeconds: 300, cooldownSeconds: 30 }
          : scenario.id === "crud-rest"
            ? { warmupSeconds: 30, measurementSeconds: 120, cooldownSeconds: 10 }
            : scenario.id === "parkbench-read-mix"
              ? { warmupSeconds: 60, measurementSeconds: 180, cooldownSeconds: 30 }
              : { warmupSeconds: 60, measurementSeconds: 300, cooldownSeconds: 30 };
      assert.deepEqual(scenario.phases, expected, entry.relativePath);
      assert.ok(!entry.relativePath.includes("calibration"));
    }
  });
  it("reads each JSON path once without startup registration", () => {
    const entries = new ScenarioFileSource(path.resolve("examples/scenarios")).list();
    assert.deepEqual(entries.map((entry) => entry.relativePath).sort(), [
      "crud-rest.json",
      "parkbench-bank-mix.json",
      "parkbench-banking-writes.json",
      "parkbench-read-mix.json",
      "parkbench-read-stable.json",
      "parkbench-read-write-70-30.json",
      "parkbench-read-write-80-20.json",
      "parkbench-read-write-90-10.json"
    ]);
    assert.deepEqual(
      entries.map((entry) => `${entry.declaredScenarioId}@${entry.declaredScenarioVersion}`).sort(),
      [
        "crud-rest@1.0.0",
        "parkbench-bank-mix@1.0.0",
        "parkbench-banking-writes@1.0.0",
        "parkbench-read-mix@1.0.0",
        "parkbench-read-stable@1.0.0",
        "parkbench-read-write-70-30@1.0.0",
        "parkbench-read-write-80-20@1.0.0",
        "parkbench-read-write-90-10@1.0.0"
      ]
    );
  });
});
