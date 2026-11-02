import { createRequire } from "node:module";
import { globalPlatformContextMatches } from "./measurement-chart-scope.mjs";
const require = createRequire(import.meta.url);
const {
  measurementStatistics
} = require("../../dist/packages/metrics/src/measurement-statistics.js");
const {
  cadvisorSourceAgeSeconds
} = require("../../dist/packages/metrics/src/cadvisor-source-age.js");
export const memoryLimitSelector =
  'container_spec_memory_limit_bytes{job="cadvisor",container_label_com_docker_compose_project="parkbench-platform",container_label_com_docker_compose_service!=""}';
const platformKeys = (diagnostics) =>
  Object.keys(diagnostics.deployedRefs ?? {})
    .filter((key) => /^platform:[^:]+:[a-f0-9]{64}$/.test(key))
    .sort();

// cAdvisor v0.55.1 metrics/prometheus.go specMemoryValue emits zero for
// unlimited memory. Absence alone never establishes this applicability rule.
export function memoryLimitAvailability({
  samples,
  diagnostics,
  runId,
  startMs,
  endMs,
  cadenceSeconds,
  acquisitionLagSeconds
}) {
  const members = platformKeys(diagnostics).map((key) => {
    const [, service, id] = key.split(":");
    const points = samples.filter(
      (p) =>
        p.labels.id?.endsWith(id) && p.labels.container_label_com_docker_compose_service === service
    );
    const { coverage } = measurementStatistics(
      [
        {
          cadenceSeconds,
          acquisitionLagSeconds,
          observations: points.map((p) => ({ timestamp: p.timestamp, value: p.value }))
        }
      ],
      { start: startMs / 1000, end: endMs / 1000 },
      { type: "gauge", unit: "bytes" }
    );
    return {
      key,
      samples: points.length,
      nonzeroSamples: points.filter((p) => p.value !== 0).length,
      missingSeconds: coverage.missingSeconds
    };
  });
  return {
    contractVersion: "measurement-global-availability.v1",
    runId,
    startMs,
    endMs,
    reason: "memory_limit_not_configured",
    sourceSelector: memoryLimitSelector,
    members,
    unexpectedSamples: samples.filter(
      (p) =>
        !members.some((m) => {
          const [, service, id] = m.key.split(":");
          return (
            p.labels.id?.endsWith(id) &&
            p.labels.container_label_com_docker_compose_service === service
          );
        })
    ).length
  };
}
export async function auditGlobalAvailability({
  prom,
  run,
  diagnostics,
  panels,
  charts,
  startMs,
  endMs,
  cadenceSeconds
}) {
  let from = startMs,
    to = endMs;
  for (const panel of panels) {
    const chart = charts.find(
      (c) => c.dashboardUid === panel.dashboardUid && c.panelId === panel.panelId
    );
    for (const query of chart?.queries ?? []) {
      if (
        panel.queries.find((q) => q.refId === query.refId)?.emptyRule !==
          "memory_limit_not_configured" ||
        !globalPlatformContextMatches(query, panel, { runId: run.id, startMs, endMs })
      )
        continue;
      from = Math.min(from, query.effectiveStartMs);
      to = Math.max(to, query.effectiveEndMs);
    }
  }
  return memoryLimitAvailability({
    samples: await prom.queryRawRange(memoryLimitSelector, from / 1000, to / 1000, cadenceSeconds),
    diagnostics,
    runId: run.id,
    startMs: from,
    endMs: to,
    cadenceSeconds,
    acquisitionLagSeconds: cadvisorSourceAgeSeconds(
      Number(run.environmentSnapshot?.sourceCadences?.cadvisorHousekeepingSeconds) || 0
    )
  });
}
export function globalQueryAvailabilityMatches(query, declared, proof, diagnostics, runId) {
  const source = query.sourceMetadata;
  if (source?.seriesCount > 0 && source.evaluationPointCount > 0) return true;
  if (
    source?.seriesCount !== 0 ||
    source.evaluationPointCount !== 0 ||
    declared.emptyRule !== "memory_limit_not_configured"
  )
    return false;
  const expected = platformKeys(diagnostics);
  return Boolean(
    proof?.contractVersion === "measurement-global-availability.v1" &&
    proof.runId === runId &&
    proof.reason === declared.emptyRule &&
    proof.sourceSelector === memoryLimitSelector &&
    proof.startMs <= query.effectiveStartMs &&
    proof.endMs >= query.effectiveEndMs &&
    proof.unexpectedSamples === 0 &&
    expected.length &&
    proof.members?.length === expected.length &&
    expected.every((key) => {
      const member = proof.members.find((m) => m.key === key);
      return member?.samples > 0 && member.nonzeroSamples === 0 && member.missingSeconds === 0;
    })
  );
}
