import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createIopsFixture, nativeDocker } from "../helpers/iops-native";
const enabled = process.env.PARKBENCH_RUN_IOPS_TESTS === "1";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "physical HDD IOPS enforcement and exact higher presets on owned storage",
  { skip: !enabled, timeout: 900000 },
  async () => {
    const image = process.env.PARKBENCH_IOPS_TEST_IMAGE;
    assert.ok(image, "PARKBENCH_IOPS_TEST_IMAGE required");
    const results: any = {
      startedAt: new Date().toISOString(),
      policies: [],
      directions: [],
      cleanup: []
    };
    const out = path.resolve(".parkbench/validation/feature025/storage/results.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try {
      // Qualify the same real policy path before spending time on physical baseline windows.
      for (const preset of ["hdd", "sata-ssd", "slow-nvme", "fast-nvme"] as const) {
        const f = await createIopsFixture(image);
        try {
          const evidence = await f.apply(preset);
          assert.equal(evidence.verification.status, "MATCHED");
          const timings = [];
          for (let i = 0; i < 3; i++) {
            const start = Date.now();
            await f.orchestrator.checkDatabaseIops(f.bundle, evidence, "warmup", () => false);
            timings.push(Date.now() - start);
          }
          assert.ok(timings.every((t) => t <= 500));
          results.policies.push({ runId: f.runId, preset, evidence, monitorMs: timings });
          console.log(
            `verified ${preset}, devices=${evidence.coverage.devices.length}, checkMs=${timings.join(",")}`
          );
        } finally {
          await f.cleanup();
          results.cleanup.push({ runId: f.runId, remaining: 0 });
        }
      }
      for (const direction of ["read", "write"] as const) {
        let baseline: number;
        for (const preset of ["unlimited", "hdd"] as const) {
          const f = await createIopsFixture(image);
          try {
            await nativeDocker([
              "exec",
              f.id,
              "fio",
              "--name=prepare",
              "--filename=/psc/wrk/fixture/data",
              "--size=128M",
              "--rw=write",
              "--bs=1M",
              "--direct=1",
              "--ioengine=libaio",
              "--iodepth=16",
              "--output-format=json"
            ]);
            const scope = await f.snapshot();
            const evidence = await f.apply(preset);
            if (preset === "hdd") assert.equal(evidence.verification.status, "MATCHED");
            if (direction === "write" && preset === "hdd") {
              const before = await f.counters();
              await nativeDocker([
                "exec",
                f.id,
                "fio",
                "--name=buffered-attribution",
                "--filename=/psc/wrk/fixture/buffered",
                "--size=128k",
                "--rw=write",
                "--bs=4k",
                "--direct=0",
                "--fsync_on_close=1",
                "--output-format=json"
              ]);
              const after = await f.counters();
              assert.ok(
                scope.coverage.devices.some(
                  (d) => (after.counters[d.id]?.wbytes ?? 0) > (before.counters[d.id]?.wbytes ?? 0)
                )
              );
              results.bufferedWritebackAttributed = true;
            }
            const workload = nativeDocker(
              [
                "exec",
                f.id,
                "fio",
                "--name=physical",
                "--filename=/psc/wrk/fixture/data",
                "--size=128M",
                `--rw=rand${direction}`,
                "--bs=4k",
                "--direct=1",
                "--ioengine=libaio",
                "--iodepth=32",
                "--time_based=1",
                "--runtime=75",
                "--output-format=json"
              ],
              120000
            );
            await pause(10000);
            const start = await f.counters();
            await pause(60000);
            const end = await f.counters();
            const fio = JSON.parse(await workload);
            assert.equal(fio.jobs[0].error, 0);
            assert.ok(fio.jobs[0][direction].total_ios > 0);
            const ops = direction === "read" ? "rios" : "wios",
              bytes = direction === "read" ? "rbytes" : "wbytes";
            let count = 0,
              totalBytes = 0;
            for (const device of scope.coverage.devices) {
              assert.ok(
                start.counters[device.id] && end.counters[device.id],
                "missing owned physical source"
              );
              count += end.counters[device.id][ops] - start.counters[device.id][ops];
              totalBytes += end.counters[device.id][bytes] - start.counters[device.id][bytes];
            }
            const seconds = (end.at - start.at) / 1000,
              rate = count / seconds;
            assert.ok(count > 0);
            assert.ok(
              Math.abs(totalBytes / count - 4096) <= 410,
              "physical operations must remain approximately4KiB"
            );
            if (preset === "unlimited") {
              baseline = rate;
              assert.ok(rate > 300, `baseline demand insufficient: ${rate}`);
            } else {
              assert.ok(baseline > 300);
              assert.ok(rate <= 165, `HDD ceiling not enforced: ${rate}`);
            }
            results.directions.push({
              runId: f.runId,
              preset,
              direction,
              windowStart: start.at,
              windowEnd: end.at,
              seconds,
              operations: count,
              bytes: totalBytes,
              physicalIops: rate,
              successfulIo: true,
              evidence
            });
            console.log(
              `${preset} ${direction}: ${rate.toFixed(2)} physical IOPS over ${seconds.toFixed(2)}s`
            );
          } finally {
            await f.cleanup();
            results.cleanup.push({ runId: f.runId, remaining: 0 });
            fs.writeFileSync(out, JSON.stringify(results, null, 2));
          }
        }
      }
      results.status = "PASSED";
    } catch (error) {
      results.status = "FAILED_OR_BLOCKED";
      results.reason = String(error);
      throw error;
    } finally {
      results.finishedAt = new Date().toISOString();
      fs.writeFileSync(out, JSON.stringify(results, null, 2));
    }
  }
);
