import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileDiscovery } from "../../packages/metrics/src/discovery";
import { RUN_STATES } from "../../packages/contracts/src/run";

describe("run monitoring contract", () => {
  it("includes explicit lifecycle and terminal states", () => {
    assert.ok(RUN_STATES.includes("QUEUED"));
    assert.ok(RUN_STATES.includes("INCOMPLETE"));
    assert.ok(RUN_STATES.includes("INTERRUPTED"));
  });

  it("updates run host and platform targets as one phase-scoped file-SD snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-target-phase-"));
    const file = path.join(root, "active-runs.json");
    const discovery = new FileDiscovery(file);
    const context = {
      experiment_id: "exp-1",
      run_id: "run-1",
      variant_id: "baseline",
      repetition: "1",
      component: "host",
      service: "node-exporter",
      phase: "idle" as const
    };
    try {
      discovery.add("run-1", [
        { targets: ["node-exporter:9100"], labels: context },
        {
          targets: ["cadvisor:8080"],
          labels: {
            ...context,
            component: "platform",
            service: "cadvisor",
            project: "parkbench-platform"
          }
        },
        {
          targets: ["control-plane:3000"],
          labels: { ...context, component: "run", service: "run-cadvisor" }
        }
      ]);
      const before = fs.readFileSync(file, "utf8");
      discovery.updatePhase("run-1", "measurement");
      const after = fs.readFileSync(file, "utf8");
      const targets = discovery.read();
      assert.notEqual(before, after);
      assert.equal(targets.length, 3);
      assert.ok(targets.every((target) => target.labels.phase === "measurement"));
      for (const target of targets) {
        assert.equal(target.labels.experiment_id, "exp-1");
        assert.equal(target.labels.run_id, "run-1");
        assert.equal(target.labels.variant_id, "baseline");
        assert.equal(target.labels.repetition, "1");
        assert.equal(typeof target.labels.component, "string");
        assert.equal(typeof target.labels.service, "string");
      }
      assert.equal(targets[1].labels.project, "parkbench-platform");
      assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates run-scoped cAdvisor scrape jobs from the ambient platform scrape", () => {
    const prometheus = fs.readFileSync("deploy/prometheus/prometheus.yml", "utf8");
    const coordinator = fs.readFileSync("apps/control-plane/src/runs/coordinator.ts", "utf8");
    const routes = fs.readFileSync("apps/control-plane/src/routes/index.ts", "utf8");
    assert.match(prometheus, /scrape_interval: \$\{PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL\}/);
    assert.doesNotMatch(prometheus, /scrape_interval: (?:1s|15s)/);
    assert.match(prometheus, /job_name: parkbench-run-platform-cadvisor/);
    assert.match(prometheus, /job_name: parkbench-run-owned-cadvisor/);
    assert.match(prometheus, /regex: parkbench-platform/);
    assert.match(prometheus, /regex: cadvisor\|run-cadvisor/);
    assert.match(prometheus, /source_labels: \[run_id\]\s+target_label: __param_run_id/);
    assert.match(coordinator, /targets: \["cadvisor:8080"\]/);
    assert.match(
      coordinator,
      /targets: \[this\.options\.runCAdvisorTarget\?\.\(\) \?\? "control-plane:3000"\]/
    );
    assert.match(coordinator, /\["node-exporter", "cadvisor"\]/);
    assert.match(routes, /filterCAdvisorMetrics\(await response\.text\(\),\s*runId\)/);
    assert.match(routes, /request\.query\?\.run_id/);
  });
});
