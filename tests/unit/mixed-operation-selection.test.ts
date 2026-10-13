import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DataFactory } from "../../apps/loadgen/src/data-factory";
import { OperationSelector } from "../../apps/loadgen/src/operation-selector";
import { calibrationFixture } from "../helpers/read-calibration-fixture";
const nativeImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
test("100000 deterministic selections per mix follow selection probabilities independently of operation outcomes", async () => {
  const lib = await nativeImport(
    pathToFileURL(path.resolve("scripts/openedge/read-calibration.mjs")).href
  );
  const gen = await nativeImport(
    pathToFileURL(path.resolve("scripts/openedge/generate-benchmark-scenarios.mjs")).href
  );
  for (const scenario of gen.buildScenarios(calibrationFixture(lib)).slice(1)) {
    const select = () => {
      const random = new DataFactory(scenario.workload.load.seed);
      const selector = new OperationSelector(scenario.workload.operations, () => random.next());
      const counts = new Map<string, number>();
      for (let i = 0; i < 100000; i++) {
        const op = selector.next();
        counts.set(op.id, (counts.get(op.id) ?? 0) + 1);
      }
      return counts;
    };
    const counts = select();
    assert.deepEqual(select(), counts);
    const readCount = scenario.workload.operations
      .slice(0, 16)
      .reduce((s: number, o: any) => s + (counts.get(o.id) ?? 0), 0);
    const share = gen.mixes.find((m: any) => scenario.id.endsWith(m.name)).readShare;
    assert.ok(
      Math.abs(readCount / 100000 - share) <= 0.01,
      `${scenario.id}: reads=${readCount}; selections=100000`
    );
    const total = scenario.workload.operations.reduce((s: number, o: any) => s + o.weight, 0);
    for (const op of scenario.workload.operations)
      assert.ok(
        Math.abs((counts.get(op.id) ?? 0) / 100000 - op.weight / total) <= 0.01,
        `${scenario.id}/${op.id}`
      );
  }
});
