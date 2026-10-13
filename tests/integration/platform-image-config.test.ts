import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseImageReference } from "../../packages/contracts/src/image-reference";
import { loadConfig } from "../../packages/contracts/src/config";
import { prometheusRetention } from "../../packages/metrics/src/retention";

const { parseEnvFile } = require(path.resolve("scripts/lib/load-env.cjs"));

describe("platform image configuration", () => {
  it("connects every normative environment image to the Compose platform", () => {
    const example = parseEnvFile(path.resolve(".env.example"));
    const compose = fs.readFileSync(path.resolve("deploy/platform-compose.yml"), "utf8");
    const keys = [
      "PARKBENCH_PROMETHEUS_IMAGE",
      "PARKBENCH_GRAFANA_IMAGE",
      "PARKBENCH_CADVISOR_IMAGE",
      "PARKBENCH_NODE_EXPORTER_IMAGE",
      "PARKBENCH_NODE_BASE_IMAGE",
      "PARKBENCH_NGINX_IMAGE",
      "PARKBENCH_LOADGEN_IMAGE",
      "PARKBENCH_OBSERVER_IMAGE",
      "PARKBENCH_OPENEDGE_DB_IMAGE",
      "PARKBENCH_OPENEDGE_PAS_IMAGE",
      "PARKBENCH_OPENEDGE_JDK_IMAGE"
    ];
    for (const key of keys) {
      const value = example.values[key];
      assert.equal(typeof value, "string", `${key} must be present in .env.example`);
      if (value) assert.doesNotThrow(() => parseImageReference(value));
      assert.match(compose, new RegExp(`\\$\\{${key}[:?]`));
    }
    assert.match(compose, /NODE_BASE_IMAGE:/);
    assert.match(compose, /NGINX_IMAGE:/);
  });

  it("connects configurable retention and target paths while keeping internal container paths derived", () => {
    const compose = fs.readFileSync(path.resolve("deploy/platform-compose.yml"), "utf8");
    const config = loadConfig({
      PARKBENCH_PROMETHEUS_RETENTION: "31d",
      PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL: "250ms",
      PARKBENCH_PROMETHEUS_TARGET_DIR: "/var/lib/parkbench/custom-targets"
    } as NodeJS.ProcessEnv);

    assert.equal(config.prometheusRetention, "31d");
    assert.equal(config.prometheusScrapeInterval, "250ms");
    assert.equal(prometheusRetention(config.prometheusRetention), "31d");
    assert.equal(config.prometheusTargetDir, "/var/lib/parkbench/custom-targets");
    assert.match(compose, /--storage\.tsdb\.retention\.time=\$\{PARKBENCH_PROMETHEUS_RETENTION/);
    assert.match(compose, /entrypoint:\s*\["\/bin\/sh",\s*"-ec"\]/);
    assert.match(compose, /awk[\s\S]*ENVIRON\["PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL"\]/);
    assert.match(compose, /exec \/bin\/prometheus --config\.file=\/tmp\/parkbench-prometheus\.yml/);
    assert.match(
      compose,
      /PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL:\s*\$\{PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL:-5s\}/
    );
    assert.match(compose, /PARKBENCH_PROMETHEUS_TARGET_DIR:\s*\/etc\/prometheus\/targets/);
    assert.match(compose, /PARKBENCH_HOST_DATA_ROOT[^\n]*:\/var\/lib\/parkbench/);
    assert.match(compose, /PARKBENCH_PROMETHEUS_TARGET_DIR[^}]*}[^\n]*:\/etc\/prometheus\/targets/);
    assert.match(compose, /PARKBENCH_DB_PATH:\s*\/var\/lib\/parkbench\/parkbench\.sqlite/);
    assert.match(compose, /PARKBENCH_ARTIFACT_ROOT:\s*\/var\/lib\/parkbench\/artifacts/);
    assert.match(compose, /PARKBENCH_RUN_ROOT:\s*\/var\/lib\/parkbench\/runs/);
  });

  it("publishes the cAdvisor web UI on its configured host port", () => {
    const example = parseEnvFile(path.resolve(".env.example"));
    const compose = fs.readFileSync(path.resolve("deploy/platform-compose.yml"), "utf8");

    assert.equal(example.values.PARKBENCH_CADVISOR_HOST_PORT, "18080");
    assert.match(
      compose,
      /cadvisor:\r?\n[\s\S]*?ports:\r?\n\s+- "\$\{PARKBENCH_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{PARKBENCH_CADVISOR_HOST_PORT:-18080\}:8080"/
    );
  });

  it("reports the cAdvisor UI endpoint from platform start and status", () => {
    const start = fs.readFileSync(path.resolve("scripts/start.sh"), "utf8");
    const status = fs.readFileSync(path.resolve("scripts/status.sh"), "utf8");

    assert.match(start, /require_published_port cadvisor 8080/);
    assert.match(start, /cAdvisor UI:/);
    assert.match(status, /show_published_port 'cAdvisor UI' cadvisor 8080/);
  });

  it("scrapes persistent ParkBench container metrics directly and keeps run metrics scoped", () => {
    const prometheus = fs.readFileSync(path.resolve("deploy/prometheus/prometheus.yml"), "utf8");

    assert.match(prometheus, /job_name: cadvisor[\s\S]*?targets:\s*\["cadvisor:8080"\]/);
    assert.match(
      prometheus,
      /source_labels:\s*\[container_label_com_docker_compose_project\]\s*\n\s*regex:\s*parkbench-platform\s*\n\s*action:\s*keep/
    );
    assert.match(
      prometheus,
      /source_labels:\s*\[container_label_parkbench_managed\]\s*\n\s*regex:\s*"?true"?\s*\n\s*action:\s*drop/
    );
    assert.match(prometheus, /scrape_interval: \$\{PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL\}/);
    assert.doesNotMatch(prometheus, /scrape_interval: (?:1s|15s)/);
    assert.match(
      prometheus,
      /job_name: parkbench-run-platform-cadvisor\s*\n\s*file_sd_configs:.*targets\/\*\.json/
    );
    assert.match(
      prometheus,
      /job_name: parkbench-run-owned-cadvisor\s*\n\s*metrics_path: \/internal\/cadvisor\/metrics\s*\n\s*file_sd_configs:.*targets\/\*\.json/
    );
  });

  it("records independent cAdvisor housekeeping and validates its duration", () => {
    assert.equal(loadConfig({} as NodeJS.ProcessEnv).cadvisorHousekeepingSeconds, 1);
    assert.equal(
      loadConfig({ PARKBENCH_CADVISOR_HOUSEKEEPING_INTERVAL: "250ms" } as NodeJS.ProcessEnv)
        .cadvisorHousekeepingSeconds,
      0.25
    );
    assert.throws(
      () => loadConfig({ PARKBENCH_CADVISOR_HOUSEKEEPING_INTERVAL: "0s" } as NodeJS.ProcessEnv),
      /platform_setting_invalid:PARKBENCH_CADVISOR_HOUSEKEEPING_INTERVAL/
    );
  });

  it("defaults the scrape interval to 5s and rejects invalid durations", () => {
    assert.equal(loadConfig({} as NodeJS.ProcessEnv).prometheusScrapeInterval, "5s");
    for (const value of ["5 seconds", "0s", "fast", ""]) {
      assert.throws(
        () => loadConfig({ PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL: value } as NodeJS.ProcessEnv),
        /platform_setting_invalid:PARKBENCH_PROMETHEUS_SCRAPE_INTERVAL/
      );
    }
  });
});
