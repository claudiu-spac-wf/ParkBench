import { Scenario } from "../../../packages/contracts/src/scenario";
import { DataFactory } from "./data-factory";
import { renderTemplateValues } from "./template-values";
import { OperationSelector } from "./operation-selector";
import { LoadgenHttpClient } from "./http-client";
import { buildSummary } from "./summary";
import { writeSummary } from "./artifacts";
import {
  cancellationRequested,
  signalCancellation
} from "../../control-plane/src/runs/cancellation";
import { phaseWindow, LoadPhase } from "./phases";
import { runWorker } from "./workers";
import {
  loadgenMetrics,
  metricSeriesKey,
  OperationMetricAccumulator,
  startMetricsServer
} from "./metrics";
import { validateScenario } from "../../../packages/contracts/src/validator";
import fs from "node:fs";
export async function runLoadgen(config: {
  scenario: Scenario;
  runId: string;
  experimentId?: string;
  variantId?: string;
  repetition?: number;
  targetBaseUrl: string;
  summaryPath: string;
  shutdownFile?: string;
  workloadStartFile?: string;
  workloadSeed?: number;
}): Promise<ReturnType<typeof buildSummary>> {
  config.scenario = validateScenario(config.scenario);
  const startedAt = new Date().toISOString();
  const client = new LoadgenHttpClient(config.targetBaseUrl, config.scenario.target.timeoutMs);
  const seed =
    config.workloadSeed ?? mixSeed(config.scenario.workload.load.seed ?? 1, config.runId);
  const results: any[] = [];
  let timeoutHit = false;
  const liveSamples = new Map<string, any>();
  const metricsServer = process.env.PARKBENCH_METRICS_PORT
    ? await startMetricsServer(() => [...liveSamples.values()])
    : undefined;
  // Initialize the actual phase counters before traffic starts. Each is zero
  // until that phase has requests; phase transitions need no publication wait.
  for (const phase of ["warmup", "measurement", "cooldown"] as const)
    for (const sample of loadgenMetrics({
      labels: {
        experiment_id: config.experimentId ?? "exp_local",
        run_id: config.runId,
        variant_id: config.variantId ?? "baseline",
        repetition: String(config.repetition ?? 1),
        component: "loadgen",
        service: "loadgen",
        phase,
        operation: "startup"
      },
      requests: 0,
      errors: 0,
      inFlight: 0,
      latencySeconds: 0,
      phase,
      operation: "startup",
      latencies: []
    }))
      liveSamples.set(metricSeriesKey(sample), sample);
  if (!(await waitForWorkloadStart(config.workloadStartFile, config.shutdownFile))) {
    const summary = buildSummary({
      runId: config.runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      phaseDurationsSeconds: config.scenario.phases,
      results,
      shutdownReason: "cancelled"
    });
    writeSummary(config.summaryPath, summary);
    await metricsServer?.close();
    return summary;
  }
  if (!(await client.health(config.scenario.target.healthPath ?? "/health")))
    throw new Error("target_unhealthy");
  const phaseDurations = config.scenario.phases;
  const scale = Number(process.env.PARKBENCH_PHASE_SCALE ?? 1);
  const phaseClockPath = process.env.PARKBENCH_PHASE_CLOCK_PATH;
  let phaseClockStart = readPhaseClock(phaseClockPath)?.startedAt;
  let continuous = readPhaseClock(phaseClockPath)?.continuous === true;
  const runPhase = async (phase: LoadPhase, seconds: number) => {
    const offsetSeconds =
      phase === "warmup"
        ? 0
        : phase === "measurement"
          ? phaseDurations.warmupSeconds
          : phaseDurations.warmupSeconds + phaseDurations.measurementSeconds;
    const initialClock = readPhaseClock(phaseClockPath);
    if (phaseClockPath && initialClock?.phase && !continuous) {
      if (
        !(await waitForPhaseClock(phaseClockPath, phase, config.shutdownFile, phase === "warmup"))
      )
        return;
      const releasedClock = readPhaseClock(phaseClockPath);
      continuous = releasedClock?.continuous === true;
      phaseClockStart = releasedClock?.startedAt;
    }
    if (phaseClockStart && (continuous || !initialClock?.phase)) {
      await waitUntil(phaseClockStart + offsetSeconds * 1000 * scale);
    }
    const deadline =
      (continuous && phaseClockStart
        ? phaseClockStart + offsetSeconds * 1000 * scale
        : Date.now()) + Math.max(0, seconds * 1000 * scale);
    const phaseStartedAt = Date.now();
    let phaseCompletions = 0;
    const operationStats = new Map<string, OperationMetricAccumulator>();
    const lastPublished = new Map<string, number>();
    const publish = (operation: string, force = false) => {
      const stats = operationStats.get(operation)!;
      const current = Date.now();
      if (!force && current - (lastPublished.get(operation) ?? 0) < 250) return;
      lastPublished.set(operation, current);
      const snapshot = stats.snapshot();
      for (const sample of loadgenMetrics({
        labels: {
          experiment_id: config.experimentId ?? "exp_local",
          run_id: config.runId,
          variant_id: config.variantId ?? "baseline",
          repetition: String(config.repetition ?? 1),
          component: "loadgen",
          service: "loadgen",
          phase,
          operation
        },
        ...snapshot,
        inFlight: 0,
        throughputPerSecond: snapshot.requests / Math.max(0.001, (current - phaseStartedAt) / 1000),
        phase,
        operation
      }))
        liveSamples.set(metricSeriesKey(sample), sample);
    };
    const stop = () =>
      cancellationRequested(config.shutdownFile ?? "") ||
      (scale === 0
        ? phaseCompletions >= Math.max(1, config.scenario.workload.load.concurrency)
        : Date.now() >= deadline);
    await Promise.all(
      Array.from({ length: config.scenario.workload.load.concurrency }, async (_, worker) => {
        const factory = new DataFactory((seed + worker) >>> 0);
        const selector = new OperationSelector(config.scenario.workload.operations, () =>
          factory.next()
        );
        let workerCompletions = 0;
        await runWorker(
          client,
          () => selector.next(),
          (operation) =>
            renderBody(
              renderTemplateValues(operation.bodyTemplate, operation.templateValues, factory),
              factory
            ),
          () => stop() || (scale === 0 && workerCompletions >= 1),
          results,
          (result) => {
            result.phase = phase;
            phaseCompletions += 1;
            workerCompletions += 1;
            if (result.timeout) {
              timeoutHit = true;
              if (config.shutdownFile) signalCancellation(config.shutdownFile);
            }
            const stats = operationStats.get(result.operation) ?? new OperationMetricAccumulator();
            stats.record(result);
            operationStats.set(result.operation, stats);
            publish(result.operation);
          }
        );
      })
    );
    for (const operation of operationStats.keys()) publish(operation, true);
  };
  await phaseWindow(
    "warmup",
    phaseDurations.warmupSeconds,
    () => runPhase("warmup", phaseDurations.warmupSeconds),
    scale,
    false
  );
  if (!cancellationRequested(config.shutdownFile ?? ""))
    await phaseWindow(
      "measurement",
      phaseDurations.measurementSeconds,
      () => runPhase("measurement", phaseDurations.measurementSeconds),
      scale,
      false
    );
  if (!cancellationRequested(config.shutdownFile ?? ""))
    await phaseWindow(
      "cooldown",
      phaseDurations.cooldownSeconds,
      () => runPhase("cooldown", phaseDurations.cooldownSeconds),
      scale,
      false
    );
  const summary = buildSummary({
    runId: config.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    phaseDurationsSeconds: phaseDurations,
    results,
    shutdownReason: timeoutHit
      ? "timeout"
      : cancellationRequested(config.shutdownFile ?? "")
        ? "cancelled"
        : "phase-complete"
  });
  writeSummary(config.summaryPath, summary);
  if (
    metricsServer &&
    summary.shutdownReason === "phase-complete" &&
    !cancellationRequested(config.shutdownFile ?? "")
  ) {
    // The coordinator owns observer collection and may still be completing
    // its final scrape when the workload phases finish. Keep the endpoint
    // serving the last phase-local samples long enough for that hand-off.
    const graceMs = Math.max(
      0,
      Math.min(10000, Number(process.env.PARKBENCH_METRICS_POST_RUN_GRACE_MS ?? 1000))
    );
    if (graceMs) await new Promise((resolve) => setTimeout(resolve, graceMs));
  }
  await metricsServer?.close();
  return summary;
}

function readPhaseClock(
  file?: string
): { startedAt: number; phase?: string; continuous?: boolean } | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const timestamp = Date.parse(value.startedAt);
    return Number.isFinite(timestamp)
      ? { startedAt: timestamp, phase: value.phase, continuous: value.continuous === true }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForPhaseClock(
  file: string,
  phase: LoadPhase,
  shutdownFile?: string,
  acceptContinuous = false
): Promise<boolean> {
  while (!cancellationRequested(shutdownFile ?? "")) {
    const clock = readPhaseClock(file);
    if (
      clock?.phase === phase ||
      (acceptContinuous && clock?.continuous && clock.phase !== "pending")
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitUntil(timestampMs: number): Promise<void> {
  const wait = timestampMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function waitForWorkloadStart(startFile?: string, shutdownFile?: string): Promise<boolean> {
  if (!startFile) return true;
  while (true) {
    if (cancellationRequested(shutdownFile ?? "")) return false;
    try {
      const stats = fs.statSync(startFile);
      if (stats.isFile() && stats.size > 0) return true;
    } catch {
      // The bind-mounted marker may not exist until Compose creates it.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function mixSeed(seed: number, runId: string): number {
  let mixed = seed >>> 0;
  for (const character of runId) mixed = Math.imul(mixed ^ character.charCodeAt(0), 16777619);
  return mixed >>> 0;
}

export function renderBody(template: unknown, factory: DataFactory): unknown {
  if (template === undefined) return factory.record();
  if (template === "generated") return factory.record();
  if (Array.isArray(template)) return template.map((value) => renderBody(value, factory));
  if (template && typeof template === "object")
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, renderBody(value, factory)])
    );
  return template;
}
