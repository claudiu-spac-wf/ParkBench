import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { databaseMemoryArguments } = createRequire(path.join(process.cwd(), "package.json"))(
  "./scripts/lib/db-memory.cjs"
);
const nativeImport = new Function("specifier", "return import(specifier)") as (
  s: string
) => Promise<any>;
const load = (name: string) =>
  nativeImport(pathToFileURL(path.resolve("scripts/openedge", name + ".mjs")).href);
test("calibration ceiling bounds both RAM and swap without raising the global DB limit", () => {
  const ceiling = 2 * 1024 ** 3;
  assert.deepEqual(databaseMemoryArguments({ PARKBENCH_DB_MEMORY_LIMIT: "10g" }, ceiling), [
    "--memory",
    "2147483648b",
    "--memory-swap",
    "2147483648b"
  ]);
  assert.deepEqual(databaseMemoryArguments({ PARKBENCH_DB_MEMORY_LIMIT: "1g" }, ceiling), [
    "--memory",
    "1073741824b",
    "--memory-swap",
    "1073741824b"
  ]);
  assert.deepEqual(databaseMemoryArguments({ PARKBENCH_DB_MEMORY_LIMIT: "10g" }), [
    "--memory",
    "10g",
    "--memory-swap",
    "10g"
  ]);
  for (const cap of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => databaseMemoryArguments({}, cap), /database_memory_ceiling_invalid/);
});
test("actual fixture startup passes its ceiling to Docker and calibration rejects pressure before Docker", async () => {
  const { NativeFixture } = await load("test-write-workloads"),
    { ReadFixture } = await load("calibrate-read-footprint");
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "calibration-memory-"));
  fs.writeFileSync(path.join(seed, "parkbench.db"), "seed");
  const fixture = new NativeFixture({
    seed,
    image: "test/image:tag",
    memoryLimitBytes: 2 * 1024 ** 3
  });
  const calls: any[] = [];
  fixture.docker = (args: string[]) => {
    calls.push(args);
    return args[0] === "image" ? JSON.stringify([{ Id: "test/image" }]) : "";
  };
  const calibration = new ReadFixture({
    seed,
    image: "test/image:tag",
    memoryInfo: () => "MemAvailable: 2097151 kB"
  });
  let dockerCalls = 0;
  calibration.docker = () => {
    dockerCalls++;
    return "";
  };
  try {
    await fixture.start();
    const run = calls.find((a) => a[0] === "run");
    assert.ok(run);
    assert.equal(run[run.indexOf("--memory") + 1], "2147483648b");
    assert.equal(run[run.indexOf("--memory-swap") + 1], "2147483648b");
    assert.equal(calibration.options.databaseStartupWords, "-B=16384");
    assert.equal(calibration.options.memoryLimitBytes, 2 * 1024 ** 3);
    await assert.rejects(calibration.start(), /read_calibration_host_memory_pressure/);
    assert.equal(dockerCalls, 0);
    assert.equal(calibration.started, false);
    calibration.memoryInfo = () => "MemFree: 9000000 kB";
    await assert.rejects(calibration.start(), /read_calibration_host_memory_unavailable/);
    assert.equal(dockerCalls, 0);
  } finally {
    fixture.close();
    fs.rmSync(seed, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(calibration.root, { recursive: true, force: true });
  }
});
