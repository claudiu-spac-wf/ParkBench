#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createComposeEnvironment } from "./host-preflight.mjs";

export const REQUIRED_SERVICES = [
  "control-plane",
  "web-ui",
  "prometheus",
  "grafana",
  "cadvisor",
  "node-exporter"
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { loadEnvironment } = require("./lib/load-env.cjs");
const { resolveHostPath } = require("./lib/resolve-paths.cjs");
loadEnvironment({ root: ROOT });

export async function checkRequiredServices(probe) {
  const entries = await Promise.all(
    REQUIRED_SERVICES.map(async (service) => {
      try {
        return [service, (await probe(service)) ? "ready" : "not_ready"];
      } catch {
        return [service, "not_ready"];
      }
    })
  );
  const services = Object.fromEntries(entries);
  return {
    ready: REQUIRED_SERVICES.every((service) => services[service] === "ready"),
    services
  };
}

export async function waitForRequiredServices(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await checkRequiredServices(probe);
    if (result.ready || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return result;
}

async function main() {
  if (process.argv.includes("--report")) {
    writeBootstrapReadinessReport();
    return;
  }
  const timeoutMs =
    positiveInteger(process.env.PARKBENCH_BOOTSTRAP_HEALTH_TIMEOUT_SECONDS, 120) * 1000;
  const result = await waitForRequiredServices(probeService, { timeoutMs });
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
}

async function probeService(service) {
  if (service === "cadvisor") return probeInsideControlPlane("http://cadvisor:8080/healthz");
  if (service === "node-exporter")
    return probeInsideControlPlane("http://node-exporter:9100/metrics", "node_exporter_build_info");

  const settings = {
    "control-plane": ["PARKBENCH_CONTROL_PLANE_HOST_PORT", 13000, "/api/v1/health", "healthy"],
    "web-ui": ["PARKBENCH_WEB_HOST_PORT", 13002, "/", null],
    prometheus: ["PARKBENCH_PROMETHEUS_HOST_PORT", 19090, "/-/ready", null],
    grafana: ["PARKBENCH_GRAFANA_HOST_PORT", 13001, "/api/health", "ok"]
  };
  const [setting, fallback, pathname, expectedText] = settings[service];
  const port = positiveInteger(process.env[setting], fallback);
  const bindAddress = process.env.PARKBENCH_BIND_ADDRESS || "127.0.0.1";
  const host = ["0.0.0.0", "::", "::0"].includes(bindAddress) ? "127.0.0.1" : bindAddress;
  const response = await fetch(`http://${host}:${port}${pathname}`, {
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) return false;
  if (expectedText === null) return true;
  if (service === "control-plane" || service === "grafana") {
    try {
      const body = await response.json();
      return service === "grafana" ? body.database === "ok" : body.status === expectedText;
    } catch {
      return false;
    }
  }
  return (await response.text()).includes(expectedText);
}

export function createBootstrapReadinessReport(environment = process.env, now = new Date()) {
  const status = ["running", "ready", "failed"].includes(environment.PARKBENCH_BOOTSTRAP_STATUS)
    ? environment.PARKBENCH_BOOTSTRAP_STATUS
    : "failed";
  const stage = [
    "started",
    "host_preflight",
    "input_preflight",
    "dependency_install",
    "application_build",
    "openedge_generic",
    "seed_create",
    "openedge_final",
    "catalog_inputs",
    "support_images",
    "platform_start",
    "service_readiness",
    "ready"
  ].includes(environment.PARKBENCH_BOOTSTRAP_STAGE)
    ? environment.PARKBENCH_BOOTSTRAP_STAGE
    : "started";
  const component = String(environment.PARKBENCH_BOOTSTRAP_COMPONENT || "bootstrap")
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .slice(0, 128);
  let readiness = {};
  try {
    readiness = JSON.parse(environment.PARKBENCH_BOOTSTRAP_SERVICES || "{}");
  } catch {
    readiness = {};
  }
  const sourceServices = readiness.services ?? readiness;
  const services = Object.fromEntries(
    REQUIRED_SERVICES.map((service) => [
      service,
      sourceServices[service] === "ready" ? "ready" : "not_ready"
    ])
  );
  const valid =
    status === "ready" && REQUIRED_SERVICES.every((service) => services[service] === "ready");
  const failed = status === "failed" || (status === "ready" && !valid);
  const report = {
    contractVersion: "bootstrap-readiness.v1",
    startedAt: validIso(environment.PARKBENCH_BOOTSTRAP_STARTED_AT) ?? now.toISOString(),
    finishedAt: now.toISOString(),
    status: failed ? "failed" : valid ? "ready" : "running",
    stage: failed ? (stage === "ready" ? "service_readiness" : stage) : valid ? "ready" : stage,
    component,
    valid,
    ...(failed ? { error: safeError(environment.PARKBENCH_BOOTSTRAP_ERROR) } : {}),
    checks: String(environment.PARKBENCH_BOOTSTRAP_CHECKS || "")
      .split(",")
      .filter((check) => /^[a-z][a-z0-9_]{0,63}$/.test(check)),
    services,
    diagnosticLog: safeDiagnosticPath(environment.PARKBENCH_BOOTSTRAP_DIAGNOSTIC_LOG),
    ...(failed
      ? { recoveryAction: safeRecovery(environment.PARKBENCH_BOOTSTRAP_RECOVERY_ACTION) }
      : {})
  };
  return report;
}

export function writeBootstrapReadinessReport(environment = process.env, now = new Date()) {
  const report = createBootstrapReadinessReport(environment, now);
  let dataRoot;
  try {
    dataRoot = resolveHostPath(
      environment.PARKBENCH_HOST_DATA_ROOT || path.join(ROOT, ".parkbench"),
      { root: ROOT }
    );
  } catch {
    dataRoot = path.join(ROOT, ".parkbench");
  }
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(dataRoot, "bootstrap-readiness.json");
  const temporary = path.join(dataRoot, `.bootstrap-readiness-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function validIso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function safeError(value) {
  return /^[a-z][a-z0-9_:-]{0,239}$/.test(String(value ?? "")) ? String(value) : "bootstrap_failed";
}

function safeRecovery(value) {
  const fallback =
    "Review the retained redacted bootstrap log, correct the failed setup condition, and rerun bootstrap.";
  const candidate = String(value ?? "")
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .trim();
  return candidate && candidate.length <= 240 ? candidate : fallback;
}

function safeDiagnosticPath(value) {
  const candidate = String(value ?? "bootstrap/attempt.log").replaceAll("\\", "/");
  if (
    candidate.startsWith("/") ||
    candidate.split("/").some((part) => part === "..") ||
    !/^[A-Za-z0-9._/-]+$/.test(candidate)
  )
    return "bootstrap/attempt.log";
  return candidate;
}

function probeInsideControlPlane(url, expectedText) {
  const envFile = resolveRoot(process.env.PARKBENCH_ENV_FILE || ".env.local");
  const composeFile = resolveRoot(
    process.env.PARKBENCH_COMPOSE_FILE || "deploy/platform-compose.yml"
  );
  const composeEnvironment = createComposeEnvironment(ROOT, process.env, envFile, composeFile);
  const probe = `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) }).then(async r => { const t = await r.text(); if (!r.ok || (${JSON.stringify(expectedText)} && !t.includes(${JSON.stringify(expectedText)}))) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });`;
  try {
    execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        envFile,
        "-f",
        composeFile,
        "exec",
        "-T",
        "control-plane",
        "node",
        "-e",
        probe
      ],
      { cwd: ROOT, env: composeEnvironment, stdio: "ignore", timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

function resolveRoot(value) {
  try {
    return resolveHostPath(value, { root: ROOT });
  } catch {
    return "";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  if (process.argv.includes("--report")) {
    try {
      writeBootstrapReadinessReport();
    } catch {
      console.error('{"valid":false,"error":"bootstrap_report_failed"}');
      process.exitCode = 1;
    }
  } else
    main().catch(() => {
      console.log(
        JSON.stringify({
          ready: false,
          services: Object.fromEntries(REQUIRED_SERVICES.map((service) => [service, "not_ready"]))
        })
      );
      process.exitCode = 1;
    });
}
