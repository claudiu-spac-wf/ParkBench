import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accountResourceSamples } from "../../packages/metrics/src/resource-accounting";
const s = (metric: string, value: number, labels: any = {}, timestamp = 1): any => ({
  metricName: metric,
  value,
  timestamp,
  type: metric.endsWith("_total") ? "counter" : "gauge",
  source: "cadvisor",
  labels: {
    id: "/docker/abc",
    run_id: "r",
    service: "database",
    job: "parkbench-run-owned-cadvisor",
    ...labels
  }
});
describe("physical resource accounting", () => {
  it("uses total CPU once, otherwise preserves separate cores", () => {
    const cpu = "container_cpu_usage_seconds_total";
    assert.equal(
      accountResourceSamples([
        s(cpu, 10, { cpu: "total" }),
        s(cpu, 4, { cpu: "0" }),
        s(cpu, 6, { cpu: "1" })
      ]).samples.length,
      1
    );
    assert.equal(
      accountResourceSamples([s(cpu, 4, { cpu: "0" }), s(cpu, 6, { cpu: "1" })]).samples.length,
      2
    );
  });
  it("deduplicates jobs and equal copies and exposes conflicting observations as gaps", () => {
    const m = "container_memory_working_set_bytes";
    assert.equal(
      accountResourceSamples([s(m, 100), s(m, 100), s(m, 100, { job: "other" })]).samples.length,
      1
    );
    const r = accountResourceSamples([s(m, 100), s(m, 200)]);
    assert.equal(r.samples.length, 0);
    assert.equal(r.gaps[0].reason, "conflicting_observation");
  });
  it("retains devices/interfaces and excludes loopback and aggregate copies", () => {
    const fs = "container_fs_reads_bytes_total",
      net = "container_network_receive_bytes_total";
    assert.equal(
      accountResourceSamples([
        s(fs, 10, { device: "total" }),
        s(fs, 4, { device: "a" }),
        s(fs, 6, { device: "b" })
      ]).samples.length,
      1
    );
    assert.equal(
      accountResourceSamples([s(fs, 4, { device: "a" }), s(fs, 6, { device: "b" })]).samples.length,
      2
    );
    const r = accountResourceSamples([
      s(net, 0, { interface: "lo" }),
      s(net, 10, { interface: "eth0" }),
      s(net, 20, { interface: "eth1" })
    ]);
    assert.equal(r.samples.length, 2);
  });
  it("never treats an unresolved disk device as an aggregate that removes healthy named devices", () => {
    for (const metric of [
      "container_fs_reads_bytes_total",
      "container_fs_writes_bytes_total",
      "container_fs_reads_total",
      "container_fs_writes_total"
    ]) {
      const named = s(metric, 123, { device: "/dev/sdd" });
      const unresolved = s(metric, 7);
      const result = accountResourceSamples([named, unresolved]);
      assert.equal(
        result.samples.length,
        2,
        `${metric}: source gives two device counters, not a total plus a leaf`
      );
      assert.deepEqual(
        result.samples.map((point) => point.value).sort((a, b) => a - b),
        [7, 123]
      );
      assert.ok(result.samples.some((point) => point.labels.device === "/dev/sdd"));
      assert.equal(result.gaps.length, 0);
    }
    const metric = "container_fs_reads_bytes_total";
    const many = Array.from({ length: 70 }, (_, i) => s(metric, i, { device: `disk-${i}` }));
    assert.equal(accountResourceSamples([...many, s(metric, 71)]).samples.length, 71);
  });
  it("normalizes empty and omitted device label copies while keeping unknown-device conflicts local", () => {
    const metric = "container_fs_reads_bytes_total";
    const equal = accountResourceSamples([
      s(metric, 7),
      s(metric, 7, { device: "" }),
      s(metric, 123, { device: "/dev/sdd" })
    ]);
    assert.equal(equal.samples.length, 2);
    const conflict = accountResourceSamples([
      s(metric, 7),
      s(metric, 8, { device: "" }),
      s(metric, 123, { device: "/dev/sdd" })
    ]);
    assert.equal(conflict.gaps.length, 1);
    assert.deepEqual(
      conflict.samples.map((point) => point.value),
      [123]
    );
  });
  it("keeps epochs and never interleaves secondary cumulative streams into authoritative intervals", () => {
    const cpu = "container_cpu_usage_seconds_total";
    const r = accountResourceSamples([
      s(cpu, 10, { cpu: "total" }, 1),
      s(cpu, 11, { cpu: "total" }, 2),
      s(cpu, 500, { cpu: "total", job: "old" }, 1.5),
      s(cpu, 501, { cpu: "total", job: "old" }, 2.5)
    ]);
    assert.deepEqual(
      r.samples.map((x) => x.value),
      [10, 11]
    );
    const epochs = accountResourceSamples([s(cpu, 10, { epoch: "a" }), s(cpu, 1, { epoch: "b" })]);
    assert.equal(epochs.samples.length, 2);
  });
});

import { resolveRequestedRunId } from "../../packages/metrics/src/discovery";
import { resolveResourceMembership } from "../../packages/metrics/src/resource-membership";
import {
  expectedResourceMembers,
  missingResourceMembers
} from "../../packages/metrics/src/resource-membership";
import { buildResourceSummaryRows } from "../../packages/metrics/src/measurement-summary";
import { MemoryPrometheusClient } from "../../packages/metrics/src/prometheus-client";
import { summaryRun } from "../helpers/summary";

it("uses the pinned cAdvisor jitter age at edges while preserving observed counts and real gaps", async () => {
  // v0.55.1 schedules a 1s base interval with up to another 1s of jitter.
  // The real control's 6.334s tail is within 5s scrape + 2s source age.
  const times = Array.from({ length: 35 }, (_, i) => 3.666 + 5 * i);
  const points = times.flatMap((t) => [
    s("container_cpu_usage_seconds_total", 2 * t, { cpu: "total" }, t),
    s("container_memory_working_set_bytes", 64, {}, t),
    s("container_fs_reads_bytes_total", 3 * t, { device: "/dev/sdd" }, t)
  ]);
  const rows = async (samples: any[], end = 180, missingMember = false) => {
    const values = [];
    for await (const row of buildResourceSummaryRows(new MemoryPrometheusClient(samples), {
      run: summaryRun("r"),
      memberships: ["abc", ...(missingMember ? ["missing"] : [])].map((id) => ({
        group: "database",
        service: "database",
        physicalId: "/docker/" + id,
        epoch: "birth",
        activeIntervals: [{ start: 0, end }],
        sourceJob: "parkbench-run-owned-cadvisor",
        sourceStepSeconds: 5
      })),
      expectedMembers: [{ group: "database", service: "database" }],
      queries: [],
      sourceStepSeconds: 5,
      cadvisorHousekeepingSeconds: 1,
      window: {
        start: new Date(0).toISOString(),
        end: new Date(end * 1000).toISOString(),
        durationSeconds: end,
        state: "completed"
      }
    }))
      if (
        row.group === "database" &&
        ["cpu.usage", "memory.used", "disk.read.bytes"].includes(row.definitionId)
      )
        values.push(row);
    return values;
  };
  const complete = await rows(points);
  assert.equal(complete.length, 3);
  for (const row of complete) {
    assert.equal(row.coverage.missingSeconds, 0);
    assert.equal(row.coverage.expectedAcquisitions, 36);
    assert.equal(row.coverage.observedAcquisitions, 35);
    assert.ok(Math.abs(row.coverage.observedSeconds - 170) < 1e-8);
    assert.ok(Math.abs(row.coverage.estimatedEdgeSeconds - 10) < 1e-8);
  }
  assert.ok(
    Math.abs(
      complete.find((r) => r.definitionId === "cpu.usage")!.statistics.average.value! - 200
    ) < 1e-8
  );
  assert.ok(
    Math.abs(
      complete.find((r) => r.definitionId === "disk.read.bytes")!.statistics.total!.value! - 540
    ) < 1e-8
  );
  assert.equal(
    complete.find((r) => r.definitionId === "memory.used")!.statistics.average.value,
    64
  );
  for (const row of await rows(points.filter((p) => p.timestamp !== times[15])))
    assert.ok(row.coverage.missingSeconds >= 9.999);
  for (const row of await rows(points, 181)) assert.ok(row.coverage.missingSeconds > 7);
  for (const row of await rows(points, 180, true)) assert.equal(row.coverage.missingSeconds, 180);
});

it("saved disk totals retain the complete named device alongside a late unresolved device without filling its gap", async () => {
  const metric = "container_fs_reads_bytes_total";
  const points = [0, 5, 10, 15, 20].map((t) => s(metric, 2 * t, { device: "/dev/sdd" }, t));
  points.push(...[10, 15, 20].map((t) => s(metric, 100 + t - 10, {}, t)));
  const rows = [];
  for await (const row of buildResourceSummaryRows(new MemoryPrometheusClient(points), {
    run: summaryRun("r"),
    memberships: [
      {
        group: "database",
        service: "database",
        physicalId: "/docker/abc",
        epoch: "birth",
        activeIntervals: [{ start: 0, end: 20 }],
        sourceJob: "parkbench-run-owned-cadvisor",
        sourceStepSeconds: 5
      }
    ],
    expectedMembers: [{ group: "database", service: "database" }],
    queries: [],
    sourceStepSeconds: 5,
    window: {
      start: new Date(0).toISOString(),
      end: new Date(20000).toISOString(),
      durationSeconds: 20,
      state: "completed"
    }
  }))
    if (row.group === "database" && row.definitionId === "disk.read.bytes") rows.push(row);
  assert.equal(rows.length, 1);
  // Forty actual bytes from the complete device plus ten observed bytes from
  // the late device; its initial counter value100 is not a measured delta.
  assert.equal(rows[0].statistics.total?.value, 50);
  assert.equal(rows[0].statistics.total?.status, "partial");
  assert.ok(rows[0].coverage.missingSeconds > 0);
});

it("retains an unresolved configured replica as missing even when its CPU samples exist", async () => {
  const run = {
    ...summaryRun("r"),
    environmentSnapshot: { scenario: { target: { pasReplicas: 2 } } }
  };
  const resources = ["pas-1", "pas-2"].map((resourceId) => ({
    resourceType: "container",
    resourceId
  }));
  const owned = (replica: string) => ({
    service: replica,
    id: "/docker/" + replica,
    container_label_parkbench_managed: "true",
    container_label_parkbench_run_id: "r",
    container_label_com_docker_compose_service: replica
  });
  const start = [0, 1, 2, 3, 4].map((t) =>
    s("container_start_time_seconds", -10, owned("pas-1"), t)
  );
  const memberships = resolveResourceMembership(start, "r", 0, 4, 1, resources, true);
  const expectedMembers = expectedResourceMembers(run, resources);
  assert.ok(
    missingResourceMembers(expectedMembers, memberships).some((m) => m.replica === "pas-2")
  );
  assert.equal(
    memberships.some((m) => m.replica === "pas-2"),
    false
  );
  const samples = ["pas-1", "pas-2"].flatMap((replica) =>
    [0, 1, 2, 3, 4].map((t) =>
      s("container_cpu_usage_seconds_total", t, { ...owned(replica), cpu: "total" }, t)
    )
  );
  const rows = [];
  for await (const row of buildResourceSummaryRows(new MemoryPrometheusClient(samples), {
    run,
    memberships,
    expectedMembers,
    queries: [],
    sourceStepSeconds: 1,
    window: {
      start: new Date(0).toISOString(),
      end: new Date(4000).toISOString(),
      durationSeconds: 4,
      state: "completed"
    }
  }))
    if (row.group === "pas" && row.definitionId === "cpu.usage") rows.push(row);
  assert.equal(rows.length, 3);
  const group = rows.find((r) => !r.dimensions.replica)!;
  assert.equal(group.statistics.average.value, null);
  assert.equal(group.statistics.total?.value, 4);
  assert.equal(group.statistics.total?.status, "partial");
  assert.ok(group.coverage.reasons.includes("required_member_missing"));
  const missing = rows.find((r) => r.dimensions.replica === "pas-2")!;
  assert.equal(missing.statistics.average.value, null);
  assert.ok(missing.coverage.reasons.includes("required_member_missing"));
});

it("bounds a verified logical replica replacement with a new physical ID without double counting", async () => {
  const owned = (id: string) => ({
    id,
    service: "pas-1",
    container_label_parkbench_managed: "true",
    container_label_parkbench_run_id: "r",
    container_label_com_docker_compose_service: "pas-1"
  });
  const resources = [{ resourceType: "container", resourceId: "pas-1" }];
  const starts = [
    s("container_start_time_seconds", -10, owned("/docker/old"), 0),
    s("container_start_time_seconds", -10, owned("/docker/old"), 1),
    ...[2, 3, 4].map((t) => s("container_start_time_seconds", 2, owned("/docker/new"), t))
  ];
  const memberships = resolveResourceMembership(starts, "r", 0, 4, 1, resources, true);
  assert.deepEqual(
    memberships.map((m) => m.activeIntervals),
    [[{ start: 0, end: 2 }], [{ start: 2, end: 4 }]]
  );
  const run = summaryRun("r");
  const samples = [0, 1, 2]
    .flatMap((t) => [
      s("container_cpu_usage_seconds_total", 100 + t, { ...owned("/docker/old"), cpu: "total" }, t),
      s("container_memory_working_set_bytes", 1000, owned("/docker/old"), t)
    ])
    .concat(
      [2, 3, 4].flatMap((t) => [
        s(
          "container_cpu_usage_seconds_total",
          500 + t - 2,
          { ...owned("/docker/new"), cpu: "total" },
          t
        ),
        s("container_memory_working_set_bytes", 1000, owned("/docker/new"), t)
      ])
    );
  const rows = [];
  for await (const row of buildResourceSummaryRows(new MemoryPrometheusClient(samples), {
    run,
    memberships,
    queries: [],
    sourceStepSeconds: 1,
    expectedMembers: [{ group: "pas", service: "pas-1", replica: "pas-1" }],
    window: {
      start: new Date(0).toISOString(),
      end: new Date(4000).toISOString(),
      durationSeconds: 4,
      state: "completed"
    }
  }))
    if (row.group === "pas" && ["cpu.usage", "memory.used"].includes(row.definitionId))
      rows.push(row);
  for (const row of rows) {
    assert.equal(row.statistics.average.value, row.definitionId === "cpu.usage" ? 100 : 1000);
    assert.equal(row.coverage.missingSeconds, 0);
    if (row.definitionId === "cpu.usage") assert.equal(row.statistics.total?.value, 4);
  }
  // Fresh old observations after the new birth are real concurrency, not proof of replacement.
  const concurrent = resolveResourceMembership(
    [...starts, s("container_start_time_seconds", -10, owned("/docker/old"), 3)],
    "r",
    0,
    4,
    1,
    resources,
    true
  );
  assert.equal(concurrent.find((m) => m.physicalId === "/docker/old")?.activeIntervals[0].end, 4);
  const unknown = resolveResourceMembership(
    starts.map((s) => ({ ...s, metricName: "container_memory_working_set_bytes" })),
    "r",
    0,
    4,
    1,
    resources
  );
  assert.equal(unknown.find((m) => m.physicalId === "/docker/old")?.activeIntervals[0].end, 4);
});
it("resolves readable/legacy IDs and rejects unknown explicit IDs", () => {
  const lookup = (id: string) => ["readable-run-1", "run_old"].includes(id);
  for (const id of ["readable-run-1", "run_old"])
    assert.equal(
      resolveRequestedRunId(id, lookup, () => "active"),
      id
    );
  assert.throws(() => resolveRequestedRunId("missing", lookup, () => "active"), /run_not_found/);
});
it("uses owned leaf resources and excludes loadgen/observers from DB/PAS", () => {
  const m = "container_memory_working_set_bytes";
  const members = resolveResourceMembership(
    [
      s(m, 1, { id: "/docker/abc" }),
      s(m, 9, { id: "/docker" }),
      s(m, 1, { id: "/docker/load", service: "loadgen" }),
      s(m, 1, { id: "/docker/obs", service: "db-observer" })
    ],
    "r",
    0,
    10,
    1,
    [{ resourceType: "container", resourceId: "abc" }]
  );
  assert.equal(members.length, 1);
  assert.equal(members[0].group, "database");
});
it("uses a secondary whole continuous segment only when it is disjoint from authoritative support", () => {
  const metric = "container_cpu_usage_seconds_total",
    input = [
      s(metric, 0, { cpu: "total" }, 0),
      s(metric, 1, { cpu: "total" }, 1),
      s(metric, 10, { cpu: "total" }, 10),
      s(metric, 11, { cpu: "total" }, 11),
      s(metric, 500, { cpu: "total", job: "cadvisor", service: undefined }, 3),
      s(metric, 501, { cpu: "total", job: "cadvisor", service: undefined }, 4)
    ];
  const result = accountResourceSamples(input, { cadenceSeconds: 1 });
  assert.deepEqual(
    result.samples.map((s) => s.timestamp),
    [0, 1, 3, 4, 10, 11]
  );
  assert.notEqual(
    result.samples[1].labels.accounting_epoch,
    result.samples[2].labels.accounting_epoch
  );
  const overlap = accountResourceSamples(
    [
      ...input,
      s(metric, 100, { cpu: "total", job: "legacy" }, 0.5),
      s(metric, 101, { cpu: "total", job: "legacy" }, 1.5)
    ],
    { cadenceSeconds: 1 }
  );
  assert.equal(
    overlap.samples.some((s) => s.labels.job === "legacy"),
    false
  );
});
it("uses actual start-time values as epochs, truncates replacements and leaves historical freshness unknown", () => {
  const metric = "container_start_time_seconds";
  const input = [
    s(metric, -10, {}, 0),
    s(metric, -10, {}, 1),
    s(metric, 1.5, {}, 2),
    s(metric, 1.5, {}, 3),
    s(metric, 1.5, {}, 7)
  ];
  const members = resolveResourceMembership(input, "r", 0, 10, 1, [], true);
  assert.deepEqual(
    members.map((m) => m.epoch),
    ["-10", "1.5"]
  );
  assert.deepEqual(members[0].activeIntervals, [{ start: 0, end: 2 }]);
  assert.deepEqual(members[1].activeIntervals, [{ start: 2, end: 8 }]);
  assert.equal(members[0].freshness?.kind, "uncached_scrape");
  assert.equal(resolveResourceMembership(input, "r", 0, 10, 1)[0].freshness, undefined);
});
it("permits a bounded first scrape tail for a container born before measurement and keeps missed scrapes inside its lifetime", () => {
  const members = resolveResourceMembership(
    [
      s("container_start_time_seconds", -10, {}, 0.5),
      s("container_start_time_seconds", -10, {}, 5)
    ],
    "r",
    0,
    10,
    1,
    [{ resourceType: "container", resourceId: "abc" }],
    true
  );
  assert.deepEqual(members[0].activeIntervals, [{ start: 0, end: 10 }]);
});
it("excludes parent cgroups from both platform membership and raw accounting even without a run inventory", () => {
  const parent = s("container_memory_working_set_bytes", 200, {
    id: "/docker",
    run_id: undefined,
    container_label_com_docker_compose_project: "parkbench-platform"
  });
  const child = s("container_memory_working_set_bytes", 100, {
    id: "/docker/abc",
    run_id: undefined,
    container_label_com_docker_compose_project: "parkbench-platform"
  });
  assert.deepEqual(
    accountResourceSamples([parent, child]).samples.map((s) => s.value),
    [100]
  );
  assert.deepEqual(
    resolveResourceMembership([parent, child], "r", 0, 10, 1).map((m) => m.physicalId),
    ["/docker/abc"]
  );
});

it("matches logical Compose resource inventory to verified run-owned physical containers", () => {
  const sample: any = {
    metricName: "container_start_time_seconds",
    type: "gauge" as const,
    source: "cadvisor",
    timestamp: 1,
    value: 0,
    labels: {
      id: "/docker/actual-container-hash",
      service: "pas-2",
      run_id: "readable-run",
      container_label_parkbench_run_id: "readable-run",
      container_label_parkbench_managed: "true",
      container_label_com_docker_compose_service: "pas-2",
      job: "parkbench-run-owned-cadvisor"
    }
  };
  const resources = [{ resourceType: "container", resourceId: "pas-2" }];
  const members = resolveResourceMembership([sample], "readable-run", 0, 5, 1, resources);
  assert.equal(members.length, 1);
  assert.equal(members[0].replica, "pas-2");
  assert.equal(members[0].physicalId, "/docker/actual-container-hash");
  assert.equal(members[0].activeIntervals[0].end, 5);
  assert.equal(
    resolveResourceMembership(
      [{ ...sample, labels: { ...sample.labels, container_label_parkbench_managed: "false" } }],
      "readable-run",
      0,
      5,
      1,
      resources
    ).length,
    0
  );
});
