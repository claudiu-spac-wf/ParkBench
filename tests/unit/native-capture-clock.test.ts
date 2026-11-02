import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeCaptureClock } from "../../packages/observers/src/native-capture-clock";
const frame = () => ({
  contractVersion: "run-phase-clock.v1",
  runId: "owned",
  continuous: true,
  nativeDatabaseIntervalMs: 5000,
  nativePhases: [
    { phase: "warmup", startMs: 0, endMs: 3000 },
    { phase: "measurement", startMs: 3000, endMs: 13000 },
    { phase: "cooldown", startMs: 13000, endMs: 15000 }
  ]
});
function fixture(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-native-clock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "phase-clock.json");
}
test("source slots follow non-aligned phase boundaries and expire after the declared schedule", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify(frame()));
  const clock = new NativeCaptureClock(file, "owned");
  for (const [now, expected] of [
    [0, 0],
    [2999, 0],
    [3000, 3000],
    [7999, 3000],
    [8000, 8000],
    [12999, 8000],
    [13000, 13000],
    [14999, 13000],
    [15000, undefined]
  ] as const)
    assert.equal(clock.minimumCapturedAtMs(now), expected);
  // The already frozen schedule does not depend on another in-place phase write.
  fs.writeFileSync(file, "{");
  assert.equal(clock.minimumCapturedAtMs(8001), 8000);
});
test("missing, malformed, oversized, foreign and overlapping clocks never authorize cached readings", (t) => {
  const file = fixture(t),
    clock = new NativeCaptureClock(file, "owned");
  assert.equal(clock.minimumCapturedAtMs(4000), undefined);
  for (const value of [
    "{",
    JSON.stringify({ ...frame(), padding: "x".repeat(4096) }),
    JSON.stringify({ ...frame(), runId: "foreign" }),
    JSON.stringify({ ...frame(), nativeDatabaseIntervalMs: 0 }),
    JSON.stringify({
      ...frame(),
      nativePhases: [{ phase: "warmup", startMs: 0, endMs: 4000 }, ...frame().nativePhases.slice(1)]
    })
  ]) {
    fs.writeFileSync(file, value);
    assert.equal(clock.minimumCapturedAtMs(4000), undefined);
  }
  fs.writeFileSync(file, JSON.stringify(frame()));
  assert.equal(clock.minimumCapturedAtMs(4000), 3000);
  assert.equal(new NativeCaptureClock(undefined, "owned").minimumCapturedAtMs(4000), undefined);
});
