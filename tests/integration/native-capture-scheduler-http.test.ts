import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { namedLatchSnapshot } from "../helpers/openedge-db-v4";
test(
  "owned native captures run before HTTP demand, keep real timestamps, expire and drain without diagnostics",
  { timeout: 15000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-clock-http-"));
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((r) => listener.close(() => r()));
    const executable = path.join(root, "adapter.cjs"),
      clock = path.join(root, "clock.json"),
      payload = namedLatchSnapshot();
    payload.latchInventory.runId = "clock-run";
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node\nconst p=${JSON.stringify(payload)};p.collectedAt=new Date().toISOString();process.stdout.write(JSON.stringify(p));\n`,
      { mode: 0o755 }
    );
    const start = Date.now() + 1000,
      end = start + 6000;
    await fs.writeFile(
      clock,
      JSON.stringify({
        contractVersion: "run-phase-clock.v1",
        runId: "clock-run",
        continuous: true,
        nativeDatabaseIntervalMs: 1000,
        nativePhases: [
          { phase: "warmup", startMs: start, endMs: start + 2000 },
          { phase: "measurement", startMs: start + 2000, endMs: start + 5000 },
          { phase: "cooldown", startMs: start + 5000, endMs: end }
        ]
      })
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("PARKBENCH_")) delete env[key];
    const child = spawn(process.execPath, [path.resolve("dist/apps/observer/src/index.js")], {
      env: {
        ...env,
        PARKBENCH_ENV_FILE: path.join(root, "absent.env"),
        PARKBENCH_OBSERVER_KIND: "openedge_db_v1",
        PARKBENCH_METRICS_PORT: String(port),
        PARKBENCH_RUN_ID: "clock-run",
        PARKBENCH_PHASE_CLOCK_PATH: clock,
        PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE: executable,
        PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE: "parkbench-db-observer-v2.r"
      },
      stdio: "pipe"
    });
    child.stdout.resume();
    child.stderr.resume();
    t.after(async () => {
      if (child.exitCode === null) {
        const exit = once(child, "exit");
        child.kill();
        await exit;
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const timing = async () => {
      const r = await fetch(`http://127.0.0.1:${port}/native-capture-timing`, {
        signal: AbortSignal.timeout(1000)
      });
      assert.equal(r.status, 200);
      return r.json() as Promise<any>;
    };
    let frame: any;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        frame = await timing();
        if (frame.events.filter((e: any) => e.stage === "CAPTURE").length >= 2) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    const before = frame.events.filter((e: any) => e.stage === "CAPTURE");
    assert.ok(
      before.length >= 2,
      "clock produces native observations without metrics/health demand"
    );
    assert.ok(!frame.events.some((e: any) => e.stage === "EXPOSITION"));
    assert.ok(
      before.every(
        (e: any) => e.sourceCapturedAtMs >= start && e.sourceCapturedAtMs <= e.finishedAtMs
      )
    );
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(response.status, 200);
    await response.text();
    const actual = Number(response.headers.get("x-parkbench-source-captured-at-ms"));
    const after = await timing();
    assert.ok(
      after.events.some((e: any) => e.stage === "CAPTURE" && e.sourceCapturedAtMs === actual)
    );
    await new Promise((r) => setTimeout(r, Math.max(0, end + 250 - Date.now())));
    const complete = await timing(),
      captures = complete.events.filter((e: any) => e.stage === "CAPTURE");
    assert.equal(captures.length, 6);
    assert.equal(new Set(captures.map((e: any) => e.collectionGeneration)).size, 6);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await timing()).events.filter((e: any) => e.stage === "CAPTURE").length, 6);
    const exit = once(child, "exit");
    child.kill();
    assert.deepEqual(await exit, [0, null]);
  }
);
