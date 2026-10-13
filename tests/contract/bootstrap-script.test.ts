import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateBootstrapReadiness } from "../../packages/contracts/src/bootstrap-readiness";

const root = process.cwd();
const bootstrapPath = path.join(root, "scripts/bootstrap.sh");
const requiredProbes = [
  "control-plane",
  "web-ui",
  "prometheus",
  "grafana",
  "cadvisor",
  "node-exporter"
];

describe("bootstrap script", () => {
  it("gives image-build recovery guidance for platform and support-image failures", () => {
    const source = fs.readFileSync(bootstrapPath, "utf8");
    const recover = source.match(/^recover_for_stage\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(recover);
    for (const stage of ["support_images", "platform_start"]) {
      const result = spawnSync(
        "bash",
        ["-c", `${recover}\nrecover_for_stage "$1"`, "bootstrap-recovery", stage],
        {
          encoding: "utf8"
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /image.build/i);
      assert.match(result.stdout, /retained redacted/i);
      assert.doesNotMatch(result.stdout, /^Restore access to the Docker Engine/);
    }
  });

  it("exists as an executable repository-root-aware shell entry point", () => {
    const mode = fs.statSync(bootstrapPath).mode;
    assert.ok(mode & 0o111);
    assert.match(
      fs.readFileSync(bootstrapPath, "utf8"),
      /source \"\$SCRIPT_DIR\/lib\/common\.sh\"/
    );
  });

  it("documents and preserves the clean-machine dependency order", () => {
    const source = fs.readFileSync(bootstrapPath, "utf8");
    const steps = [
      "run_stage host_preflight",
      "run_stage input_preflight",
      "run_stage dependency_install npm-dependencies npm ci",
      'run_stage application_build parkbench-application "$SCRIPT_DIR/build.sh"',
      "run_stage openedge_generic generic-openedge-images npm run openedge:build -- --image-stage generic",
      "run_stage openedge_final final-openedge-image npm run openedge:build -- --image-stage final",
      'load_generated_environment "$images_env"',
      'run_stage catalog_inputs managed-runner-archive node "$SCRIPT_DIR/openedge/stage-catalog-inputs.mjs"',
      'run_stage support_images support-images "$SCRIPT_DIR/build-images.sh"',
      'run_stage platform_start local-platform "$SCRIPT_DIR/start.sh" --no-build',
      'node "$SCRIPT_DIR/bootstrap-readiness.mjs" > "$readiness_raw" 2>&1'
    ];
    let previous = -1;
    for (const step of steps) {
      const position = source.indexOf(step);
      assert.ok(position > previous, `bootstrap step is out of order: ${step}`);
      previous = position;
    }
    assert.match(source, /--image-stage all/);
    assert.match(
      fs.readFileSync(path.join(root, "scripts/bootstrap-readiness.mjs"), "utf8"),
      /bootstrap-readiness\.json/
    );
    assert.match(source, /redact-diagnostics\.mjs/);
    assert.match(source, /load-env\.cjs/);
    assert.doesNotMatch(source, /source ["']\$images_env["']/);
    assert.doesNotMatch(source, /docker\s+(?:system\s+prune|compose\s+down\s+-v)/);
  });

  it("gives the generated final images.env handoff precedence over inherited settings", () => {
    const source = fs.readFileSync(bootstrapPath, "utf8");
    assert.match(
      source,
      /load_generated_environment\(\)[\s\S]*?--env-file "\$file" --required --prefer-file --shell/
    );
  });

  it("loads generated OpenEdge image settings when starting an initialized platform", () => {
    const start = fs.readFileSync(path.join(root, "scripts/start.sh"), "utf8");
    const common = fs.readFileSync(path.join(root, "scripts/lib/common.sh"), "utf8");

    assert.match(start, /load_openedge_generated_environment\s+compose up/);
    assert.match(
      common,
      /load_openedge_generated_environment\(\)[\s\S]*?--env-file "\$generated_environment" --required --prefer-file --shell/
    );
  });

  it("uses the normalized Compose environment for in-container readiness probes", () => {
    const readiness = fs.readFileSync(path.join(root, "scripts/bootstrap-readiness.mjs"), "utf8");
    assert.match(readiness, /createComposeEnvironment/);
    assert.match(readiness, /env:\s*composeEnvironment/);
  });

  it("retains the failed lifecycle stage and safe recovery fields in bootstrap output", () => {
    const reporterPath = path.join(root, "scripts/bootstrap-readiness.mjs");
    const outputRoot = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "parkbench-bootstrap-result-")
    );
    const startedAt = "2026-09-23T12:00:00Z";
    const result = spawnSync(process.execPath, [reporterPath, "--report"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PARKBENCH_HOST_DATA_ROOT: outputRoot,
        PARKBENCH_BOOTSTRAP_STARTED_AT: startedAt,
        PARKBENCH_BOOTSTRAP_STATUS: "failed",
        PARKBENCH_BOOTSTRAP_STAGE: "openedge_generic",
        PARKBENCH_BOOTSTRAP_COMPONENT: "generic-observer",
        PARKBENCH_BOOTSTRAP_VALID: "false",
        PARKBENCH_BOOTSTRAP_ERROR: "docker_build_failed:generic-observer",
        PARKBENCH_BOOTSTRAP_CHECKS: "host_preflight,input_preflight,openedge_generic",
        PARKBENCH_BOOTSTRAP_SERVICES: "{}",
        PARKBENCH_BOOTSTRAP_DIAGNOSTIC_LOG: "bootstrap/attempt-safe.log",
        PARKBENCH_BOOTSTRAP_RECOVERY_ACTION: "Check local base images and rerun bootstrap."
      }
    });
    try {
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      validateBootstrapReadiness(report);
      assert.equal(report.valid, false);
      assert.equal(report.status, "failed");
      assert.equal(report.stage, "openedge_generic");
      assert.equal(report.component, "generic-observer");
      assert.equal(report.error, "docker_build_failed:generic-observer");
      assert.equal(report.diagnosticLog, "bootstrap/attempt-safe.log");
      assert.ok(report.recoveryAction);
      assert.ok(report.finishedAt);
      assert.deepEqual(Object.keys(report.services), requiredProbes);
      assert.deepEqual(Object.values(report.services), Array(6).fill("not_ready"));
      assert.equal(fs.existsSync(path.join(outputRoot, "bootstrap-readiness.json")), true);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("exits nonzero and persists an actionable result when host preflight fails", () => {
    const outputRoot = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "parkbench-bootstrap-failure-")
    );
    const missingEnvironment = path.join(outputRoot, "missing.env");
    const result = spawnSync(bootstrapPath, [], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PARKBENCH_ENV_FILE: missingEnvironment,
        PARKBENCH_HOST_DATA_ROOT: outputRoot
      }
    });
    try {
      assert.notEqual(result.status, 0);
      const report = JSON.parse(
        fs.readFileSync(path.join(outputRoot, "bootstrap-readiness.json"), "utf8")
      );
      validateBootstrapReadiness(report);
      assert.equal(report.valid, false);
      assert.equal(report.status, "failed");
      assert.equal(report.stage, "host_preflight");
      assert.equal(report.component, "host-environment");
      assert.equal(report.error, "host_preflight_failed");
      assert.ok(report.recoveryAction);
      assert.match(report.diagnosticLog, /^bootstrap\//);
      assert.equal(result.stdout.includes(outputRoot), false);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("cannot report ready unless every required service is ready", () => {
    const reporterPath = path.join(root, "scripts/bootstrap-readiness.mjs");
    const outputRoot = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "parkbench-bootstrap-ready-")
    );
    const services = {
      "control-plane": "ready",
      "web-ui": "ready",
      prometheus: "ready",
      grafana: "ready",
      cadvisor: "ready",
      "node-exporter": "ready"
    };
    const result = spawnSync(process.execPath, [reporterPath, "--report"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PARKBENCH_HOST_DATA_ROOT: outputRoot,
        PARKBENCH_BOOTSTRAP_STARTED_AT: "2026-09-23T12:00:00Z",
        PARKBENCH_BOOTSTRAP_STATUS: "ready",
        PARKBENCH_BOOTSTRAP_STAGE: "ready",
        PARKBENCH_BOOTSTRAP_COMPONENT: "parkbench-platform",
        PARKBENCH_BOOTSTRAP_CHECKS: "required_services_ready",
        PARKBENCH_BOOTSTRAP_SERVICES: JSON.stringify({ services }),
        PARKBENCH_BOOTSTRAP_DIAGNOSTIC_LOG: "bootstrap/attempt-safe.log"
      }
    });
    try {
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      validateBootstrapReadiness(report);
      assert.equal(report.status, "ready");
      assert.equal(report.valid, true);
      assert.deepEqual(Object.keys(report.services), requiredProbes);
      assert.ok(Object.values(report.services).every((service) => service === "ready"));
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("turns a declared ready result into a failed service-readiness report when one probe is missing", () => {
    const reporterPath = path.join(root, "scripts/bootstrap-readiness.mjs");
    const outputRoot = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "parkbench-bootstrap-incomplete-")
    );
    const services = Object.fromEntries(requiredProbes.map((service) => [service, "ready"]));
    delete services["node-exporter"];
    const result = spawnSync(process.execPath, [reporterPath, "--report"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PARKBENCH_HOST_DATA_ROOT: outputRoot,
        PARKBENCH_BOOTSTRAP_STATUS: "ready",
        PARKBENCH_BOOTSTRAP_STAGE: "ready",
        PARKBENCH_BOOTSTRAP_COMPONENT: "parkbench-platform",
        PARKBENCH_BOOTSTRAP_SERVICES: JSON.stringify({ services }),
        PARKBENCH_BOOTSTRAP_ERROR: "required_services_not_ready",
        PARKBENCH_BOOTSTRAP_RECOVERY_ACTION: "Restore the missing service and rerun bootstrap."
      }
    });
    try {
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      validateBootstrapReadiness(report);
      assert.equal(report.valid, false);
      assert.equal(report.status, "failed");
      assert.equal(report.stage, "service_readiness");
      assert.equal(report.error, "required_services_not_ready");
      assert.match(report.recoveryAction, /Restore the missing service/);
      assert.deepEqual(Object.keys(report.services), requiredProbes);
      assert.equal(report.services["node-exporter"], "not_ready");
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
