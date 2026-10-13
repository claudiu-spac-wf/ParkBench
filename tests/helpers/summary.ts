import { Run } from "../../packages/contracts/src/run";
export function summaryRun(id = "run-test"): Run {
  return {
    id,
    experimentId: "exp-test",
    variantId: "v1",
    repetition: 1,
    state: "SUCCEEDED",
    measurementValidity: "VALID",
    composeProject: id,
    resourceNamespace: {},
    cleanupStatus: "COMPLETE",
    summary: { old: true }
  };
}
export function summaryHeader(id = "run-test"): any {
  return {
    contractVersion: "run-summary.v1",
    metricDefinitionsVersion: "measurement-summary.v1",
    run: {
      id,
      experimentId: "exp-test",
      variantId: "v1",
      repetition: 1,
      state: "SUCCEEDED",
      measurementValidity: "VALID"
    },
    generatedAt: "2026-09-30T00:00:00.000Z",
    origin: "new_run",
    windows: {
      run: { start: "2026-09-30T00:00:00.000Z", end: "2026-09-30T00:00:10.000Z" },
      measurement: {
        start: "2026-09-30T00:00:00.000Z",
        end: "2026-09-30T00:00:10.000Z",
        state: "completed",
        durationSeconds: 10
      }
    },
    sampling: {
      baseStepSeconds: 1,
      observationStepSeconds: 1,
      sources: [],
      boundaryEstimation: "nearest in-phase segment; bounded edge only"
    },
    quality: { complete: true, requiredGaps: [], optionalWarnings: [], cleanupStatus: "COMPLETE" },
    memberships: [],
    workload: {},
    observerHealth: {},
    metricsReference: { source: "http://prometheus", queries: [], labelKeys: ["run_id"] },
    contextReference: { path: id + "/run-context.v1.json" },
    totalRowCount: 0,
    tableRowCount: 0
  };
}
export function summaryRow(table?: string): any {
  const dimensions = table ? { table } : {};
  const coverage = {
    coverageModel: "single_source",
    durationSeconds: 10,
    observedSeconds: 9,
    estimatedEdgeSeconds: 1,
    missingSeconds: 0,
    sourceStepSeconds: 1,
    observationStepSeconds: 1,
    percentileBinCount: 9,
    omittedBinCount: 1,
    expectedAcquisitions: 10,
    observedAcquisitions: 10,
    reasons: []
  };
  const row = {
    definitionId: table ? "db.table.read" : "memory.used",
    group: "database",
    displayName: table ? "Table reads" : "Used memory",
    coverageScope: table ? "table_covered" : "resource",
    dimensions,
    rateOrLevelUnit: table ? "records_per_second" : "bytes",
    totalUnit: table ? "records" : null,
    statistics: {
      average: {
        value: 1,
        status: "estimated",
        reasons: [],
        unit: table ? "records_per_second" : "bytes",
        coverage
      },
      p90: {
        value: 1,
        status: "available",
        reasons: [],
        unit: table ? "records_per_second" : "bytes",
        coverage
      },
      p95: {
        value: 1,
        status: "available",
        reasons: [],
        unit: table ? "records_per_second" : "bytes",
        coverage
      },
      ...(table
        ? {
            total: {
              value: 10,
              observedTotal: 9,
              estimatedTotal: 1,
              status: "estimated",
              reasons: [],
              unit: "records",
              coverage
            }
          }
        : {})
    },
    coverage,
    sourceReferences: []
  };
  return {
    ...row,
    rowKey: JSON.stringify([
      row.definitionId,
      row.group,
      row.coverageScope,
      row.rateOrLevelUnit,
      row.totalUnit,
      Object.entries(dimensions)
    ])
  };
}
