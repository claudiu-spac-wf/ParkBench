import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { summaryRun } from "../helpers/summary";
it("returns pending promptly, publishes a bounded summary, and keeps current results after chart expiry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-read-")),
    p = new MemoryPrometheusClient(),
    platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, prometheus: p }
    ),
    app = buildServer(platform);
  try {
    await platform.startupRecovery;
    platform.repositories.saveRun({
      ...summaryRun(),
      state: "FAILED",
      environmentSnapshot: { metrics: { measurement: { state: "not_started" } } }
    });
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-test/comparison-summary"
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, "RECOMPUTING");
    assert.equal(first.headers["retry-after"], "2");
    await platform.summaryWorker!.idle();
    p.fail = true;
    const ready = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-test/comparison-summary"
    });
    assert.equal(ready.json().status, "READY");
    assert.equal(ready.json().header.run.id, "run-test");
    assert.ok(Buffer.byteLength(ready.body) < 8 * 1024 * 1024);
    const saved = ready.json();
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/runs/run-test/artifacts/${saved.artifactId}`
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.json().rows.length, saved.header.totalRowCount);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/v1/runs/unknown/comparison-summary" }))
        .statusCode,
      404
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/runs/run-test/comparison-summary?cursor=foreign"
        })
      ).statusCode,
      400
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/runs/unknown/artifacts/${saved.artifactId}`
        })
      ).statusCode,
      404
    );
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
