import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DataFactory } from "../../apps/loadgen/src/data-factory";

/** TypeScript mirror of bank_mix.p's row selection (research R8). */
function rows(sequence: number, value: number) {
  const maxIds = { Currency: 40, Branch: 250, AccountType: 24, DebitTransaction: 365318 };
  return {
    currency: 1 + (sequence % maxIds.Currency),
    branch: 1 + (sequence % maxIds.Branch),
    accountType: 1 + (sequence % maxIds.AccountType),
    contactRandom100: 1 + (value % 100),
    holderRandom1000: 1 + (sequence % 1000),
    debitStart: 1 + (sequence % Math.max(1, maxIds.DebitTransaction - 100))
  };
}

function sequenceFor(seed: number, count: number) {
  const factory = new DataFactory(seed);
  return Array.from({ length: count }, () => {
    const key = factory.record();
    return rows(Number(key.sequence), Number(key.value));
  });
}

describe("bank_mix row selection", () => {
  it("replays the same rows for the same effective load seed and differs for another seed", () => {
    assert.deepEqual(sequenceFor(2026, 25), sequenceFor(2026, 25));
    assert.notDeepEqual(sequenceFor(2026, 25), sequenceFor(2027, 25));
  });

  it("keeps the mirror in step with the procedure's formulas", () => {
    const source = fs.readFileSync("openedge/workloads/Workloads/ParkBench/bank_mix.p", "utf8");
    for (const formula of [
      "targetId = 1 + (keySequence MODULO MAXIMUM(maxId, 1)).",
      "CustomerContact.RandomInt100 = 1 + INTEGER(keyValue MODULO 100)",
      "AccountHolder.RandomInt1000 = 1 + INTEGER(keySequence MODULO 1000)",
      "startId = 1 + (keySequence MODULO MAXIMUM(1, maxId - 100))."
    ])
      assert.ok(source.includes(formula), formula);
  });
});
