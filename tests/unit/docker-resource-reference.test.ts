import test from "node:test";
import assert from "node:assert/strict";
import { dockerWindowCpu } from "../browser/support/docker-resource-reference";

test("Docker reference integrates full-window counters and preserves multicore CPU", () => {
  const first = { read: "2026-09-30T20:00:00.000Z", totalNanoseconds: 10e9 };
  assert.equal(
    dockerWindowCpu(first, { read: "2026-09-30T20:01:00.000Z", totalNanoseconds: 490e9 }),
    800
  );
  assert.equal(
    dockerWindowCpu(first, { read: "2026-09-30T20:01:00.000Z", totalNanoseconds: 10e9 }),
    0
  );
  assert.throws(
    () => dockerWindowCpu(first, { ...first, totalNanoseconds: 9e9 }),
    /window_invalid/
  );
});
