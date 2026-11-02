import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { buildServer } from "../../apps/control-plane/src/server";
import { summaryRun } from "../helpers/summary";

test("owned cAdvisor proxy separates upstream headers/body/filter/exposition without retaining its source payload", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostic-cadvisor-"));
  const platform = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://fixture",
      prometheusRetention: "7d",
      cadvisorUrl: "http://cadvisor-fixture",
      openedge: {}
    } as any,
    { testMode: true }
  );
  const app = buildServer(platform);
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await platform.startupRecovery;
  platform.repositories.saveRun(summaryRun("proxy-run"));
  const events: any[] = [];
  platform.coordinator.recordMeasurementPublication = (event) => {
    events.push(event);
  };
  const original = globalThis.fetch;
  const owned =
    'container_cpu_usage_seconds_total{container_label_parkbench_managed="true",container_label_parkbench_run_id="proxy-run",marker="private-proxy-body"} 17\n';
  const sibling =
    'container_cpu_usage_seconds_total{container_label_parkbench_managed="true",container_label_parkbench_run_id="other-run"} 5\n';
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(owned + sibling));
            controller.close();
          }, 25);
        }
      })
    );
  };
  try {
    const result = await app.inject({ url: "/internal/cadvisor/metrics?run_id=proxy-run" });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, owned);
    const body = events.find((e) => e.reasonCodes?.includes("cadvisor_body_read_complete"));
    assert.ok(body?.durationMs >= 15, "body consumption is timed separately from fetch headers");
    assert.ok(
      events.some((e) => e.stage === "HTTP" && e.reasonCodes.includes("cadvisor_headers_received"))
    );
    assert.ok(
      events.some(
        (e) => e.stage === "PARSE" && e.reasonCodes.includes("cadvisor_owned_filter_complete")
      )
    );
    assert.ok(
      events.some(
        (e) => e.stage === "EXPOSITION" && e.reasonCodes.includes("cadvisor_response_finished")
      )
    );
    assert.ok(events.every((e) => e.runId === "proxy-run" && e.observerId === "cadvisor-proxy"));
    assert.ok(!JSON.stringify(events).includes("private-proxy-body"));
  } finally {
    globalThis.fetch = original;
  }
});
