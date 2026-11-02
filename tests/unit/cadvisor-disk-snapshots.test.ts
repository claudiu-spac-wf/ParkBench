import test from "node:test";
import assert from "node:assert/strict";
import type { MetricSample } from "../../packages/contracts/src/metrics";
import { accountCadvisorDiskSnapshots } from "../../packages/metrics/src/cadvisor-disk-snapshots";

const id = "/docker/" + "a".repeat(64);
const labels = {
  experiment_id: "e",
  variant_id: "v",
  repetition: "1",
  component: "database",
  phase: "measurement" as const,
  id,
  job: "parkbench-run-owned-cadvisor",
  run_id: "owned",
  service: "pas-1"
};
const point = (metricName: string, timestamp: number, value: number, extra = {}): MetricSample => ({
  metricName,
  timestamp,
  value,
  labels: { ...labels, ...extra },
  source: "prometheus",
  type: "counter"
});
function fixture(metric = "container_fs_reads_bytes_total") {
  const source: MetricSample[] = [],
    inventory: MetricSample[] = [];
  for (const t of [0, 5, 10, 15]) {
    source.push(point(metric, t, 10 + t, { device: "/dev/sdd" }));
    for (const operation of ["Read", "Write"])
      inventory.push(
        point("container_blkio_device_usage_total", t, operation === "Read" ? 10 + t : 0, {
          device: "/dev/sdd",
          major: "8",
          minor: "48",
          operation
        })
      );
    if (t >= 10) {
      source.push(point(metric, t, 100 + (t - 10) * 2, { device: "" }));
      for (const operation of ["Read", "Write"])
        inventory.push(
          point(
            "container_blkio_device_usage_total",
            t,
            operation === "Read" ? 100 + (t - 10) * 2 : 0,
            { device: "", major: "7", minor: "1", operation }
          )
        );
    }
  }
  return { source, inventory };
}
test("complete native inventory frames preserve a new device's first actual cumulative contribution", () => {
  const { source, inventory } = fixture(),
    before = JSON.stringify({ source, inventory });
  const result = accountCadvisorDiskSnapshots(source, inventory);
  // Whole-cgroup actual snapshots: baseline10, then15, then20+100, then25+110.
  // Counter increase is125; no synthetic zero, baseline or past device point.
  assert.deepEqual(
    result.samples.map((p) => [p.timestamp, p.value]),
    [
      [0, 10],
      [5, 15],
      [10, 120],
      [15, 135]
    ]
  );
  assert.equal(result.samples.at(-1)!.value - result.samples[0].value, 125);
  assert.equal(result.frames.length, 4);
  assert.equal(
    result.frames.reduce((n, f) => n + f.sourceSampleCount, 0),
    6
  );
  assert.equal(
    result.frames.reduce((n, f) => n + f.expectedDeviceCount, 0),
    6
  );
  assert.deepEqual(result.gaps, []);
  assert.equal(JSON.stringify({ source, inventory }), before);
});
test("missing native evidence, an expected device point or byte disagreement cannot establish a complete snapshot", () => {
  const { source, inventory } = fixture();
  for (const [input, native] of [
    [source, []],
    [source, inventory.filter((p) => p.timestamp !== 10)],
    [source.filter((p) => !(p.timestamp === 10 && p.labels.device === "")), inventory],
    [source.filter((p) => p.timestamp !== 0), inventory],
    [source, inventory.map((p, i) => (i === 0 ? { ...p, value: 999 } : p))],
    [source, inventory.filter((p) => !(p.timestamp === 10 && p.labels.operation === "Write"))]
  ]) {
    const result = accountCadvisorDiskSnapshots(input, native);
    assert.ok(result.gaps.length > 0);
    assert.ok(result.samples.some((p) => p.labels.device === "/dev/sdd"));
    assert.ok(!result.samples.some((p) => p.labels.device === "total"));
  }
});
test("native identities never merge colliding anonymous devices or foreign physical owners", () => {
  const { source, inventory } = fixture();
  const collision = inventory
    .filter((p) => p.labels.device === "")
    .map((p) => ({ ...p, labels: { ...p.labels, minor: "2" } }));
  assert.ok(accountCadvisorDiskSnapshots(source, [...inventory, ...collision]).gaps.length);
  assert.ok(
    accountCadvisorDiskSnapshots(
      source,
      inventory.map((p) => ({ ...p, labels: { ...p.labels, id: "/docker/foreign" } }))
    ).gaps.length
  );
});
test("source epochs and genuine counter resets remain distinct from a new device contribution", () => {
  const { source, inventory } = fixture();
  const changed = source.map((p) => ({
    ...p,
    labels: { ...p.labels, accounting_epoch: p.timestamp < 10 ? "before" : "after" }
  }));
  const result = accountCadvisorDiskSnapshots(changed, inventory);
  assert.notEqual(
    result.samples[1].labels.accounting_epoch,
    result.samples[2].labels.accounting_epoch
  );
});

test("complete native snapshots include every one of more than64 device identities", () => {
  const source: MetricSample[] = [],
    inventory: MetricSample[] = [];
  for (const t of [0, 5])
    for (let d = 0; d < 71; d++) {
      const device = "/dev/test" + d,
        value = 10 + t;
      source.push(point("container_fs_reads_bytes_total", t, value, { device }));
      for (const operation of ["Read", "Write"])
        inventory.push(
          point("container_blkio_device_usage_total", t, operation === "Read" ? value : 0, {
            device,
            major: "8",
            minor: String(d),
            operation
          })
        );
    }
  const result = accountCadvisorDiskSnapshots(source, inventory);
  assert.deepEqual(
    result.samples.map((p) => p.value),
    [710, 1065]
  );
  assert.deepEqual(
    result.frames.map((f) => f.expectedDeviceCount),
    [71, 71]
  );
  assert.deepEqual(result.gaps, []);
});

import { buildResourceSummaryRows } from "../../packages/metrics/src/measurement-summary";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { summaryRun } from "../helpers/summary";
import { RunCoordinator } from "../../apps/control-plane/src/runs/coordinator";

async function summaryCase(profile: boolean, input?: MetricSample[], native?: MetricSample[]) {
  const data = fixture(),
    samples = (input ?? data.source).map((p) => ({
      ...p,
      labels: { ...p.labels, service: "database" }
    })),
    inventory = (native ?? data.inventory).map((p) => ({
      ...p,
      labels: { ...p.labels, service: "database" }
    }));
  const run = summaryRun("owned");
  if (profile)
    run.environmentSnapshot = {
      sourceCadences: { cadvisorDiskAccountingProfile: "cadvisor-complete-disk-frame.v1" }
    };
  const rows = [];
  for await (const row of buildResourceSummaryRows(
    new MemoryPrometheusClient([...samples, ...inventory]),
    {
      run,
      memberships: [
        {
          group: "database",
          service: "database",
          physicalId: id,
          epoch: "birth",
          activeIntervals: [{ start: 0, end: 15 }],
          sourceJob: "parkbench-run-owned-cadvisor",
          sourceStepSeconds: 5
        }
      ],
      expectedMembers: [{ group: "database", service: "database" }],
      sourceStepSeconds: 5,
      cadvisorHousekeepingSeconds: 1,
      queries: [],
      window: {
        start: new Date(0).toISOString(),
        end: new Date(15000).toISOString(),
        durationSeconds: 15,
        state: "completed"
      }
    }
  ))
    if (row.definitionId === "disk.read.bytes" && row.group === "database") rows.push(row);
  assert.equal(rows.length, 1);
  return rows[0];
}
test("new-profile summaries account native snapshot totals while unmarked historical accounting stays partial", async () => {
  const old = await summaryCase(false),
    current = await summaryCase(true);
  assert.equal(old.statistics.total!.value, 25);
  assert.equal(old.statistics.total!.status, "partial");
  assert.equal(current.statistics.total!.value, 125);
  assert.equal(current.coverage.missingSeconds, 0);
  assert.equal(current.coverage.observedAcquisitions, old.coverage.observedAcquisitions);
  assert.equal(current.coverage.observedAcquisitions, 4);
  assert.equal(current.coverage.expectedAcquisitions, 4);
  assert.notEqual(current.statistics.total!.status, "partial");
  assert.ok(
    current.sourceReferences.some((s) => s.metric === "container_blkio_device_usage_total")
  );
  for (const native of [[], fixture().inventory.filter((p) => p.timestamp !== 0)]) {
    const result = await summaryCase(true, undefined, native);
    assert.ok(["partial", "unavailable"].includes(result.statistics.total!.status));
  }
  const missing = fixture().source.filter((p) => p.timestamp !== 0);
  assert.ok(
    ["partial", "unavailable"].includes((await summaryCase(true, missing)).statistics.total!.status)
  );
});
test("required disk verification adopts proved frames and refuses missing companion inventory", async () => {
  const { source, inventory } = fixture(),
    run = summaryRun("owned");
  run.environmentSnapshot = {
    sourceCadences: { cadvisorDiskAccountingProfile: "cadvisor-complete-disk-frame.v1" }
  };
  run.phaseBoundaries = {
    measurement: { startedAt: new Date(0).toISOString(), finishedAt: new Date(15000).toISOString() }
  };
  const all = [
    "container_fs_reads_bytes_total",
    "container_fs_writes_bytes_total",
    "container_fs_reads_total",
    "container_fs_writes_total"
  ].flatMap((metric) =>
    source.map((p) => ({
      ...p,
      metricName: metric,
      value: metric.includes("writes") ? 0 : p.value,
      labels: { ...p.labels, service: "database" }
    }))
  );
  const native = inventory.map((p) => ({ ...p, labels: { ...p.labels, service: "database" } }));
  const collect = async (evidence: MetricSample[]) =>
    (
      await (RunCoordinator.prototype as any).collectDiskIoCompleteness.call(
        {
          diagnostics: new Map(),
          options: {
            phaseScale: 1,
            observerSamplingIntervalSeconds: 5,
            cadvisorHousekeepingSeconds: 1
          },
          prometheus: new MemoryPrometheusClient([...all, ...evidence])
        },
        run,
        15,
        { resources: [{ name: "database", type: "container" }] }
      )
    ).filter((c: any) => c.observerId.startsWith("disk-io-cadvisor-"));
  const result = await collect(native);
  assert.equal(result.length, 4);
  assert.ok(
    result.every((c: any) => c.coverage.missingSeconds === 0 && c.diagnostics.length === 0)
  );
  assert.ok((await collect([])).every((c: any) => c.diagnostics.length > 0));
});

test("an unproved first frame remains partial even when bounded edge estimation covers its duration", async () => {
  const data = fixture(),
    source = data.source.filter((p) => p.labels.device === "/dev/sdd" && p.timestamp !== 0),
    inventory = data.inventory.filter((p) => p.labels.device === "/dev/sdd");
  const row = await summaryCase(true, source, inventory);
  assert.equal(row.coverage.missingSeconds, 0);
  assert.ok(row.coverage.estimatedEdgeSeconds > 0);
  assert.equal(row.statistics.total!.status, "partial");
  assert.ok(row.statistics.total!.reasons.includes("source_unavailable"));
  assert.ok(row.statistics.total!.value !== null);
});
test("a device reset cannot be masked by the first contribution of another device", () => {
  const data = fixture(),
    source = data.source
      .filter((p) => !(p.timestamp === 10 && p.labels.device === ""))
      .map((p) => (p.timestamp === 15 && p.labels.device === "/dev/sdd" ? { ...p, value: 3 } : p)),
    inventory = data.inventory
      .filter((p) => !(p.timestamp === 10 && p.labels.device === ""))
      .map((p) =>
        p.timestamp === 15 && p.labels.device === "/dev/sdd" && p.labels.operation === "Read"
          ? { ...p, value: 3 }
          : p
      );
  const result = accountCadvisorDiskSnapshots(source, inventory);
  assert.equal(result.samples[2].value, 20);
  assert.equal(result.samples[3].value, 113);
  assert.notEqual(
    result.samples[2].labels.accounting_epoch,
    result.samples[3].labels.accounting_epoch
  );
  assert.deepEqual(result.gaps, []);
});

import { withQueryEvidence } from "../../packages/metrics/src/query-evidence";
test("snapshot evidence distinguishes all real source readings from derived frames without retaining values", () => {
  const { source, inventory } = fixture(),
    events: any[] = [];
  withQueryEvidence(
    {
      requestedStartMs: 0,
      requestedEndMs: 15000,
      scrapeCadenceMs: 5000,
      recordStatistics: (event: any) => events.push(event)
    } as any,
    () => accountCadvisorDiskSnapshots(source, inventory)
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].storedObservations, 6);
  assert.deepEqual(events[0].scope.definitionIds, ["disk.read.bytes"]);
  assert.equal(events[0].scope.group, "pas");
  assert.deepEqual(events[0].scope.dimensions, { direction: "read" });
  assert.equal(events[0].counts.rawSourceObservations, 6);
  assert.equal(events[0].counts.expectedNativeDeviceObservations, 6);
  assert.equal(events[0].counts.derivedCgroupFrames, 4);
  assert.ok(!Object.hasOwn(events[0], "observations"));
  assert.ok(!Object.hasOwn(events[0], "value"));
});

import { cadvisorDiskSnapshotAcquisitionCounts } from "../../packages/metrics/src/cadvisor-disk-snapshots";
test("source acquisition counts retain every static device and independently scheduled readings after native birth", () => {
  const data = fixture(),
    members = [{ physicalId: id, activeIntervals: [{ start: 0, end: 15 }] }];
  assert.deepEqual(
    cadvisorDiskSnapshotAcquisitionCounts(
      data.inventory,
      data.source,
      members,
      { start: 0, end: 15 },
      5
    ),
    { expected: 4, observed: 4 }
  );
  const named = data.source.filter((p) => p.labels.device === "/dev/sdd"),
    inventory = data.inventory.filter((p) => p.labels.device === "/dev/sdd");
  assert.deepEqual(
    cadvisorDiskSnapshotAcquisitionCounts(inventory, named, members, { start: 0, end: 15 }, 5),
    { expected: 3, observed: 3 }
  );
  assert.deepEqual(
    cadvisorDiskSnapshotAcquisitionCounts(
      inventory.filter((p) => p.timestamp !== 5),
      named.filter((p) => p.timestamp !== 5),
      members,
      { start: 0, end: 15 },
      5
    ),
    { expected: 3, observed: 2 }
  );
  const otherNamed = named.map((p) => ({ ...p, labels: { ...p.labels, device: "/dev/second" } })),
    otherInventory = inventory.map((p) => ({
      ...p,
      labels: { ...p.labels, device: "/dev/second", minor: "49" }
    }));
  assert.deepEqual(
    cadvisorDiskSnapshotAcquisitionCounts(
      [...inventory, ...otherInventory],
      [...named, ...otherNamed],
      members,
      { start: 0, end: 15 },
      5
    ),
    { expected: 6, observed: 6 }
  );
});

import { calculateSummaryRow } from "../../packages/metrics/src/measurement-summary";
import { RESOURCE_SUMMARY_CATALOG } from "../../packages/metrics/src/summary-catalog";
test("source evidence preserves the distinct additive-total and shared-average coverage contracts", () => {
  const definition = RESOURCE_SUMMARY_CATALOG.find(
    (d) => d.definitionId === "disk.read.bytes" && d.group === "database"
  )!;
  const series = ["first", "second"].map((physicalId) => ({
    physicalId,
    cadenceSeconds: 5,
    observations: [0, 5, 10].map((timestamp) => ({ timestamp, value: timestamp }))
  }));
  const row = calculateSummaryRow(
    definition,
    { direction: "read" },
    series,
    { start: 0, end: 10 },
    { acquisitions: { expected: 4, observed: 4 } }
  );
  assert.equal(row.statistics.total!.value, 20);
  assert.equal(row.coverage.coverageModel, "shared_member_intersection");
  assert.equal(row.statistics.total!.coverage.coverageModel, "constituent_additive");
  assert.equal(row.statistics.total!.coverage.supportedContributors, 2);
  assert.equal(row.statistics.total!.coverage.observedAcquisitions, 4);
});

test("unused fallback scrape jobs cannot change authoritative native device availability counts", () => {
  const data = fixture(),
    members = [{ physicalId: id, activeIntervals: [{ start: 0, end: 15 }] }];
  const foreign = data.inventory
    .filter((p) => p.labels.device === "")
    .map((p) => ({ ...p, timestamp: 0, labels: { ...p.labels, job: "cadvisor" } }));
  assert.deepEqual(
    cadvisorDiskSnapshotAcquisitionCounts(
      [...data.inventory, ...foreign],
      data.source,
      members,
      { start: 0, end: 15 },
      5
    ),
    { expected: 4, observed: 4 }
  );
});

test("reused display labels cannot join distinct native device identities across frames", () => {
  const data = fixture(),
    source = data.source.filter((p) => p.labels.device === "/dev/sdd"),
    inventory = data.inventory
      .filter((p) => p.labels.device === "/dev/sdd")
      .map((p) => (p.timestamp >= 10 ? { ...p, labels: { ...p.labels, minor: "49" } } : p));
  const result = accountCadvisorDiskSnapshots(source, inventory);
  assert.notEqual(
    result.samples[1].labels.accounting_epoch,
    result.samples[2].labels.accounting_epoch
  );
  assert.deepEqual(result.gaps, []);
});
test("resolving a display label leaves an unchanged major-minor identity in its original epoch", () => {
  const data = fixture(),
    source = data.source
      .filter((p) => p.labels.device === "/dev/sdd")
      .map((p) =>
        p.timestamp >= 10 ? { ...p, labels: { ...p.labels, device: "/dev/resolved" } } : p
      ),
    inventory = data.inventory
      .filter((p) => p.labels.device === "/dev/sdd")
      .map((p) =>
        p.timestamp >= 10 ? { ...p, labels: { ...p.labels, device: "/dev/resolved" } } : p
      );
  const result = accountCadvisorDiskSnapshots(source, inventory);
  assert.equal(
    result.samples[1].labels.accounting_epoch,
    result.samples[2].labels.accounting_epoch
  );
  assert.deepEqual(result.gaps, []);
});
