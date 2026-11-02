import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { crc32 } from "node:zlib";
import { auditGlobalAvailability } from "./measurement-global-availability.mjs";
import { generatedPanelQueries } from "./measurement-chart-scope.mjs";
import { auditEmptyPlatformDiskSources } from "./measurement-source-availability.mjs";

const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compiled = (name) => require(path.join(repository, "dist", name));
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invariant = (condition, reason) => {
  if (!condition) throw new Error(`acceptance_${reason}`);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
};
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function validateScreenshotPng(bytes) {
  invariant(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 57 &&
      bytes.length <= 8 * 1024 ** 2 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "screenshot_png"
  );
  let position = 8,
    header = false,
    data = false,
    end = false;
  while (position < bytes.length) {
    invariant(position + 12 <= bytes.length && !end, "screenshot_truncated");
    const length = bytes.readUInt32BE(position),
      finish = position + length + 12;
    invariant(finish <= bytes.length, "screenshot_truncated");
    const type = bytes.toString("ascii", position + 4, position + 8);
    invariant(
      crc32(bytes.subarray(position + 4, finish - 4)) === bytes.readUInt32BE(finish - 4),
      "screenshot_crc"
    );
    if (!header) {
      invariant(
        type === "IHDR" &&
          length === 13 &&
          bytes.readUInt32BE(position + 8) > 0 &&
          bytes.readUInt32BE(position + 12) > 0,
        "screenshot_header"
      );
      header = true;
    } else invariant(type !== "IHDR", "screenshot_header");
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      invariant(length === 0 && finish === bytes.length && data, "screenshot_end");
      end = true;
    }
    position = finish;
  }
  invariant(header && data && end, "screenshot_truncated");
  return true;
}

export function nativeIdentityCovered(identity) {
  const covered = (c) => Number.isFinite(c?.missingSeconds) && c.missingSeconds <= 1e-8;
  if (
    !covered(identity.availabilityCoverage) ||
    identity.missingAvailableValues !== 0 ||
    identity.unexpectedValueTimes !== 0
  )
    return false;
  if (!identity.unavailable)
    return identity.available > 0 && identity.samples > 0 && covered(identity.coverage);
  const reasons = identity.unavailabilityReasons;
  if (!Array.isArray(reasons) || reasons.length !== 1) return false;
  if (identity.limitation === "alternate_pool_disabled")
    return (
      identity.dimensions.pool === "alternate" &&
      identity.independentAvailability === "not_configured" &&
      identity.independentReason === "alternate_pool_disabled" &&
      reasons[0] === "alternate_pool_disabled" &&
      identity.available === 0 &&
      identity.samples === 0
    );
  if (identity.limitation === "synthetic_table_other")
    return (
      identity.metric === "parkbench_openedge_db_table_operations_total" &&
      identity.dimensions.table === "other" &&
      identity.syntheticOtherProof === true &&
      reasons[0] === "statistics_range_excludes_object" &&
      identity.available === 0 &&
      identity.samples === 0
    );
  return (
    identity.limitation === "time_scoped_not_applicable" &&
    identity.metric === "parkbench_openedge_db_transaction_oldest_active_age_seconds" &&
    reasons[0] === "not_applicable"
  );
}

export function parseComparisonCsv(content) {
  invariant(
    typeof content === "string" && Buffer.byteLength(content) <= 8 * 1024 ** 2,
    "csv_limit"
  );
  const records = [],
    row = [];
  let field = "",
    quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      invariant(field === "", "csv_quote");
      quoted = true;
    } else if (c === "," || c === "\n") {
      row.push(field);
      field = "";
      if (c === "\n") {
        records.push([...row]);
        row.length = 0;
      }
    } else if (c !== "\r") field += c;
  }
  invariant(!quoted, "csv_truncated");
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  const headers = records.shift();
  invariant(headers?.includes("run_id") && new Set(headers).size === headers.length, "csv_header");
  invariant(
    records.length <= 100000 && records.every((r) => r.length === headers.length),
    "csv_shape"
  );
  return records.map((r) => Object.fromEntries(headers.map((k, i) => [k, r[i]])));
}

export async function auditComparison({ client, run, saved }) {
  const comparison = await client.get(
    `/api/v1/comparisons/${encodeURIComponent(run.experimentId)}?limit=25`
  );
  invariant(comparison.contractVersion === "comparison.v2", "comparison_contract");
  const entry = comparison.runs.find((r) => r.runId === run.id);
  invariant(entry?.summary.status === "READY", "comparison_summary_missing");
  const rows = entry.rows.map((r) => r.row);
  let cursor = entry.tablePage?.hasMore ? entry.tablePage.nextCursor : null;
  const cursors = new Set();
  while (cursor) {
    invariant(!cursors.has(cursor) && cursors.size < 2048, "comparison_cursor");
    cursors.add(cursor);
    const page = await client.get(
      `/api/v1/comparisons/${encodeURIComponent(comparison.id)}/runs/${encodeURIComponent(run.id)}/tables?limit=500&cursor=${encodeURIComponent(cursor)}`
    );
    rows.push(...page.rows.map((r) => r.row));
    cursor = page.hasMore ? page.nextCursor : null;
    invariant(!page.hasMore || cursor, "comparison_truncated");
  }
  const index = new Map(rows.map((r) => [r.rowKey, r]));
  const comparisonMismatches = saved.rows
    .filter((r) => !equal(r, index.get(r.rowKey)))
    .map((r) => r.rowKey);
  if (index.size !== saved.rows.length || rows.length !== index.size)
    comparisonMismatches.push("row_inventory");
  const csv = await client.text(`/api/v1/comparisons/${encodeURIComponent(comparison.id)}/export`);
  const selected = parseComparisonCsv(csv).filter((r) => r.run_id === run.id);
  const identity = (r) =>
    JSON.stringify([
      r.group,
      r.definition_id,
      r.metric,
      r.coverage_scope,
      ...["service", "replica", "table", "pool", "direction", "operation", "file", "scope"].map(
        (k) => r[k] ?? ""
      )
    ]);
  const csvIndex = new Map(selected.map((r) => [identity(r), r])),
    csvMismatches = [];
  for (const row of saved.rows) {
    const c = csvIndex.get(
      identity({
        group: row.group,
        definition_id: row.definitionId,
        metric: row.displayName,
        coverage_scope: row.coverageScope,
        ...row.dimensions
      })
    );
    let matches =
      !!c &&
      c.measurement_start === saved.windows.measurement.start &&
      c.measurement_end === saved.windows.measurement.end;
    for (const [stat, value] of Object.entries(row.statistics))
      matches &&=
        c[stat] === (value.value === null ? "" : String(value.value)) &&
        c[stat + "_status"] === value.status;
    for (const [column, property] of [
      ["observed_seconds", "observedSeconds"],
      ["estimated_edge_seconds", "estimatedEdgeSeconds"],
      ["missing_seconds", "missingSeconds"],
      ["observation_step_seconds", "observationStepSeconds"]
    ])
      matches &&= Number(c[column]) === row.coverage[property];
    if (!matches) csvMismatches.push(row.rowKey);
  }
  if (selected.length !== saved.rows.length || csvIndex.size !== selected.length)
    csvMismatches.push("row_inventory");
  return {
    comparisonId: comparison.id,
    comparisonRowCount: rows.length,
    csvRowCount: selected.length,
    comparisonMismatches,
    csvMismatches,
    csvDigest: digest(csv)
  };
}

// Counts and hashes are retained. Raw values live only for one bounded query or
// calculation batch and remain in Prometheus, the system of record.
export async function auditRunMeasurements({
  client,
  run,
  diagnostics,
  configuration,
  prometheus,
  charts = [],
  availabilityEvidence
}) {
  const { HttpPrometheusClient } = compiled("packages/metrics/src/prometheus-client.js");
  const { measurementStatistics } = compiled("packages/metrics/src/measurement-statistics.js");
  const { buildResourceSummaryRows } = compiled("packages/metrics/src/measurement-summary.js");
  const { buildDatabaseSummaryRows } = compiled("packages/metrics/src/database-summary.js");
  const { resolveResourceMembership } = compiled("packages/metrics/src/resource-membership.js");
  const catalog = require(
    path.join(repository, "packages/contracts/src/openedge-db-metric-catalog.json")
  ).entries;
  const prom = prometheus ?? new HttpPrometheusClient("http://127.0.0.1:19090");
  const runId = run.id,
    route = `/api/v1/runs/${encodeURIComponent(runId)}`;
  const listing = await client.get(`${route}/artifacts`),
    artifacts = listing.artifacts;
  const receipt = (id) => {
    const item = artifacts.find((a) => a.id === id);
    invariant(
      item && !["EXPIRED", "UNAVAILABLE"].includes(item.sourceMetadata?.availability),
      "artifact_missing"
    );
    return item;
  };
  const artifact = async (id) => {
    receipt(id);
    return client.get(`${route}/artifacts/${encodeURIComponent(id)}`);
  };
  const dimensions = new Map(),
    inventory = [],
    expectations = [];
  let header;
  for (const id of diagnostics.inventoryPages) {
    const page = await artifact(id);
    invariant(Array.isArray(page), "inventory_page");
    for (const envelope of page) {
      const record = envelope.record;
      if (record?.contractVersion === "measurement-native-inventory-header.v1") {
        invariant(!header, "duplicate_native_inventory");
        header = record;
      }
      if (record?.contractVersion === "measurement-native-dimension.v1") {
        const values = dimensions.get(record.dimension) ?? new Set();
        for (const value of record.identities) values.add(value);
        dimensions.set(record.dimension, values);
      }
      if (record?.contractVersion === "measurement-native-availability.v1") inventory.push(record);
      if (record?.contractVersion === "measurement-expectation.v1") expectations.push(record);
    }
  }
  invariant(
    header && header.availabilityCount === inventory.length && inventory.length > 0,
    "native_inventory_incomplete"
  );
  const tableNames = [...(dimensions.get("application_table") ?? [])].sort();
  invariant(
    tableNames.length > 0 &&
      dimensions.get("table_inventory_contract")?.has("openedge-db.v4.application-tables-complete"),
    "application_table_inventory"
  );
  const window = run.phaseBoundaries?.measurement;
  invariant(window?.startedAt && window.finishedAt, "measurement_window");
  const start = Date.parse(window.startedAt) / 1000,
    end = Date.parse(window.finishedAt) / 1000;
  invariant(end > start, "measurement_window");
  const cadence =
    (configuration.cadencesMs.native ?? configuration.cadencesMs["openedge-db"]) / 1000;
  invariant(cadence > 0, "native_cadence");
  const definitions = new Map(catalog.map((d) => ["parkbench_openedge_db_" + d.name, d]));
  const dimension = (labels, key) => {
    if (labels[key] !== undefined) return labels[key];
    const values = dimensions.get(key);
    invariant(values?.size === 1, "unresolved_dimension");
    return [...values][0];
  };
  const key = (metric, labels) =>
    JSON.stringify([
      metric,
      ...(definitions.get(metric)?.dimensions ?? []).map((k) => [k, dimension(labels, k)])
    ]);
  const queries = [];
  const query = async (metric) => {
    const selector = `${metric}{job="parkbench-runs",run_id=${JSON.stringify(runId)}}`;
    queries.push({ selector, start, end, cadence, mode: "RAW_STORED_SAMPLES" });
    return prom.queryRawRange(selector, start, end, cadence);
  };
  const availability = new Map();
  for (const sample of await query("parkbench_openedge_db_metric_available")) {
    invariant(sample.value === 0 || sample.value === 1, "availability_value");
    const k = key("parkbench_openedge_db_" + sample.labels.measurement, sample.labels);
    const points = availability.get(k) ?? [];
    points.push(sample);
    availability.set(k, points);
  }
  const results = [],
    tableAvailability = [];
  const statistics = (points, type = "gauge", unit = "count") =>
    measurementStatistics(
      [
        {
          cadenceSeconds: cadence,
          observations: points.map((p) => ({
            timestamp: p.timestamp,
            value: p.value,
            epoch: p.labels.database_epoch
          }))
        }
      ],
      { start, end },
      { type, unit, totalUnit: type === "counter" ? unit : null }
    );
  for (const metric of new Set(inventory.map((r) => r.metricName))) {
    const index = new Map();
    for (const sample of await query(metric)) {
      const k = key(metric, sample.labels),
        points = index.get(k) ?? [];
      points.push(sample);
      index.set(k, points);
    }
    for (const expected of inventory.filter((r) => r.metricName === metric)) {
      const k = key(metric, expected.dimensions),
        points = index.get(k) ?? [],
        av = availability.get(k) ?? [];
      const reasons = new Set(av.filter((p) => p.value === 0).map((p) => p.labels.reason));
      const available = av.filter((p) => p.value === 1),
        unavailable = av.filter((p) => p.value === 0);
      const times = new Set(points.map((p) => p.timestamp));
      const def = definitions.get(metric);
      let limitation = null;
      if (unavailable.length && !available.length && !points.length) {
        if (
          expected.availability === "not_configured" &&
          expected.reasonCode === "alternate_pool_disabled" &&
          reasons.size === 1 &&
          reasons.has("alternate_pool_disabled")
        )
          limitation = "alternate_pool_disabled";
        if (
          expected.dimensions.table === "other" &&
          metric === "parkbench_openedge_db_table_operations_total" &&
          !tableNames.some((table) => table.toLowerCase() === "other") &&
          reasons.size === 1 &&
          reasons.has("statistics_range_excludes_object")
        )
          limitation = "synthetic_table_other";
      }
      const dynamic =
        metric === "parkbench_openedge_db_transaction_oldest_active_age_seconds" &&
        unavailable.length &&
        reasons.size === 1 &&
        reasons.has("not_applicable");
      if (
        dynamic &&
        available.every((p) => times.has(p.timestamp)) &&
        points.every((p) => available.some((a) => a.timestamp === p.timestamp))
      )
        limitation = "time_scoped_not_applicable";
      const availabilityCoverage = statistics(av).coverage;
      const coverage = points.length
        ? statistics(points, def.type === "counter" ? "counter" : "gauge", def.unit).coverage
        : null;
      const complete =
        availabilityCoverage.missingSeconds <= 1e-8 &&
        (limitation !== null ||
          (coverage?.missingSeconds <= 1e-8 &&
            unavailable.length === 0 &&
            available.every((p) => times.has(p.timestamp))));
      results.push({
        metric,
        dimensions: expected.dimensions,
        inventoryEvidenceRef: expected.evidenceId,
        available: available.length,
        unavailable: unavailable.length,
        samples: points.length,
        limitation,
        independentAvailability: expected.availability,
        independentReason: expected.reasonCode,
        unavailabilityReasons: [...reasons],
        missingAvailableValues: available.filter((p) => !times.has(p.timestamp)).length,
        unexpectedValueTimes: points.filter(
          (p) => !available.some((a) => a.timestamp === p.timestamp)
        ).length,
        syntheticOtherProof:
          limitation === "synthetic_table_other" &&
          !tableNames.some((table) => table.toLowerCase() === "other"),
        availabilityCoverage,
        coverage,
        complete
      });
      if (
        metric === "parkbench_openedge_db_table_operations_total" &&
        tableNames.includes(expected.dimensions.table)
      )
        tableAvailability.push({
          table: expected.dimensions.table,
          operation: expected.dimensions.operation,
          availability: complete && available.length ? "available" : "not_collected",
          reason: complete && available.length ? "available" : "unexplained_gap"
        });
    }
  }
  const panels = new Map();
  for (const e of expectations)
    for (const view of e.consumingViews ?? [])
      if (view.dashboardUid)
        panels.set(`${view.dashboardUid}:${view.panelId}`, {
          dashboardUid: view.dashboardUid,
          panelId: view.panelId,
          queries: generatedPanelQueries(view.dashboardUid, view.panelId)
        });
  const sourceAudit = {
    contractVersion: "measurement-source-audit.v1",
    runId,
    revision: configuration.revision,
    recordedAtMs: Date.now(),
    startMs: start * 1000,
    endMs: end * 1000,
    inventoryEvidenceRef: header.evidenceId,
    inventoryCount: inventory.length,
    assessedCount: results.length,
    gapCount: results.filter((r) => !r.complete).length,
    identities: results,
    queryDigest: digest(queries),
    requiredPanels: [...panels.values()]
  };
  const summaryReceipt = artifacts.find((a) => a.path?.endsWith("comparison-summary.v1.json"));
  invariant(summaryReceipt, "saved_summary_missing");
  const saved = await artifact(summaryReceipt.id);
  invariant(saved.run?.id === runId && Array.isArray(saved.rows), "saved_summary_owner");
  const measurement = saved.windows.measurement;
  invariant(
    Date.parse(measurement.start) === start * 1000 && Date.parse(measurement.end) === end * 1000,
    "saved_summary_window"
  );
  const members = Object.keys(diagnostics.deployedRefs).flatMap((ref) => {
    const match = ref.match(/^(platform|database|pas):([^:]+):([a-f0-9]{64})$/);
    return match ? [{ group: match[1], service: match[2], id: match[3] }] : [];
  });
  invariant(members.length > 2, "physical_inventory_missing");
  const resourceCadence = (configuration.cadencesMs.scrape ?? configuration.cadencesMs.core) / 1000;
  sourceAudit.globalAvailability = await auditGlobalAvailability({
    prom,
    run,
    diagnostics,
    panels: sourceAudit.requiredPanels,
    charts,
    startMs: start * 1000,
    endMs: end * 1000,
    cadenceSeconds: resourceCadence
  });
  const resourceSamples = [];
  for (const selector of [
    `container_start_time_seconds{job="parkbench-run-owned-cadvisor",run_id=${JSON.stringify(runId)}}`,
    'container_start_time_seconds{job="cadvisor",container_label_com_docker_compose_project="parkbench-platform",container_label_com_docker_compose_service!=""}'
  ]) {
    resourceSamples.push(...(await prom.queryRawRange(selector, start, end, resourceCadence)));
    invariant(resourceSamples.length <= 100000, "membership_sample_limit");
  }
  const resources = members.map((m) => ({
    resourceType: "container",
    resourceId: m.id,
    labels: {
      "com.docker.compose.service": m.service,
      ...(m.group === "platform" ? { "com.docker.compose.project": "parkbench-platform" } : {})
    }
  }));
  const housekeeping =
    Number(run.environmentSnapshot?.sourceCadences?.cadvisorHousekeepingSeconds) || 0;
  const memberships = resolveResourceMembership(
    resourceSamples,
    runId,
    start,
    end,
    resourceCadence,
    resources,
    true,
    housekeeping
  );
  const missingMembers = members.filter(
    (m) =>
      !memberships.some(
        (s) => s.group === m.group && s.service === m.service && s.physicalId.includes(m.id)
      )
  );
  const memberKey = (m) => JSON.stringify([m.group, m.service, m.physicalId, m.epoch]);
  const membershipMismatches = memberships
    .filter(
      (m) =>
        !equal(
          m,
          saved.memberships.find((s) => memberKey(s) === memberKey(m))
        )
    )
    .map(memberKey);
  for (const m of saved.memberships)
    if (!memberships.some((s) => memberKey(s) === memberKey(m)))
      membershipMismatches.push(memberKey(m));
  const options = {
    run,
    window: measurement,
    memberships,
    expectedMembers: members.map((m) => ({
      group: m.group,
      service: m.service,
      ...(m.group === "pas" ? { replica: m.service } : {})
    })),
    sourceStepSeconds: resourceCadence,
    nativeStepSeconds: cadence,
    cadvisorHousekeepingSeconds: housekeeping,
    queries: []
  };
  const savedIndex = new Map(saved.rows.map((row) => [row.rowKey, row]));
  invariant(savedIndex.size === saved.rows.length, "duplicate_saved_row");
  const resourceRows = [];
  const mismatches = [],
    unsupportedGaps = [],
    assessed = new Set();
  const assess = async (rows) => {
    for await (const row of rows) {
      const original = savedIndex.get(row.rowKey);
      assessed.add(row.rowKey);
      if (
        !original ||
        !equal(
          { statistics: original.statistics, coverage: original.coverage },
          { statistics: row.statistics, coverage: row.coverage }
        )
      )
        mismatches.push(row.rowKey);
      const legitimate =
        row.definitionId === "disk.space.file_size"
          ? expectations.some(
              (e) =>
                e.definitionId === row.definitionId &&
                e.statistic === "source_reading" &&
                e.applicability === "UNSUPPORTED" &&
                e.applicabilityReason === "path_kind_directory" &&
                e.evidenceRefs.some((ref) => /^files:\d+$/.test(ref))
            )
          : row.dimensions.pool === "alternate" &&
            results.some((r) => r.limitation === "alternate_pool_disabled");
      if (
        (row.coverage.missingSeconds > 1e-8 ||
          Object.values(row.statistics).some((s) => s.value === null || s.status === "partial")) &&
        !legitimate
      )
        unsupportedGaps.push(row.rowKey);
    }
  };
  for await (const row of buildResourceSummaryRows(prom, options)) resourceRows.push(row);
  await assess(resourceRows);
  await assess(
    buildDatabaseSummaryRows(prom, options, {
      protocolVersion: 4,
      tables: tableNames,
      availability: tableAvailability
    })
  );
  const diskAvailability = await auditEmptyPlatformDiskSources({
    prom,
    run,
    configuration,
    memberships,
    options,
    rows: resourceRows,
    availabilityEvidence
  });
  const explained = new Set(diskAvailability.limitations.map((l) => l.rowKey));
  const unresolvedGaps = unsupportedGaps.filter((key) => !explained.has(key));
  const summaryAudit = {
    contractVersion: "measurement-summary-audit.v1",
    runId,
    recordedAtMs: Date.now(),
    startMs: start * 1000,
    endMs: end * 1000,
    summaryArtifactId: summaryReceipt.id,
    savedDigest: digest(saved),
    savedRowCount: saved.rows.length,
    assessedRowCount: assessed.size,
    mismatches,
    unassessedRows: [...savedIndex.keys()].filter((k) => !assessed.has(k)),
    unsupportedGaps: unresolvedGaps,
    ...(diskAvailability.limitations.length
      ? {
          legitimateLimitations: diskAvailability.limitations,
          sourceAvailabilityProofs: diskAvailability.proofs,
          sourceAvailabilityEvidenceRefs: [availabilityEvidence.reference]
        }
      : {}),
    missingMembers,
    membershipMismatches,
    nativeInventoryRef: header.evidenceId
  };
  summaryAudit.comparison = await auditComparison({ client, run, saved });
  return { sourceAudit, summaryAudit };
}

export function confirmationSequences(campaign) {
  const reasons = [],
    sequences = {};
  if (campaign.mode !== "CONFIRM") reasons.push("investigation_is_not_confirmation");
  for (const workload of ["READ_ONLY", "MIXED"])
    for (const setup of ["NONE", "ORDERED"])
      if (!campaign.configurations.some((c) => c.workloadClass === workload && c.setup === setup))
        reasons.push(`base_configuration_missing:${workload}:${setup}`);
  const baseIds = new Set();
  for (const workload of ["READ_ONLY", "MIXED"])
    for (const setup of ["NONE", "ORDERED"]) {
      const base = campaign.configurations.find(
        (c) => c.workloadClass === workload && c.setup === setup
      );
      if (base) baseIds.add(base.configurationId);
    }
  const seen = new Set();
  let baseAccepted = 0;
  for (const configuration of campaign.configurations) {
    const attempts = campaign.attempts.filter(
      (a) => a.configurationId === configuration.configurationId
    );
    let count = 0;
    for (const a of attempts) {
      const fresh = !seen.has(a.runId);
      seen.add(a.runId);
      count =
        fresh &&
        a.origin === "LIVE" &&
        a.assessment === "ACCEPTED" &&
        a.revision === campaign.revision &&
        a.runState === "SUCCEEDED" &&
        a.measurementValidity === "VALID" &&
        a.cleanupState === "COMPLETE" &&
        a.diagnosticCompleteness === "COMPLETE" &&
        a.sourceAuditRefs.length &&
        a.summaryAuditRefs.length &&
        a.chartRefs.length &&
        !a.reasonCodes.length
          ? count + 1
          : 0;
    }
    sequences[configuration.configurationId] = count;
    const required = baseIds.has(configuration.configurationId) ? 1 : 3;
    if (baseIds.has(configuration.configurationId)) baseAccepted += count;
    if (count < required)
      reasons.push(`consecutive_passes_missing:${configuration.configurationId}`);
  }
  const accepted = campaign.attempts.filter(
    (a) => a.assessment === "ACCEPTED" && a.origin === "LIVE" && a.revision === campaign.revision
  ).length;
  if (baseAccepted < 5) reasons.push("minimum_five_base_missing");
  return { passed: reasons.length === 0, reasonCodes: reasons, sequences, accepted, baseAccepted };
}
