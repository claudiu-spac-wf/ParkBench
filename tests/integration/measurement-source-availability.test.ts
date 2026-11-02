import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
const load = () => import(path.resolve("scripts/diagnostics/measurement-source-availability.mjs"));
const image = "sha256:" + "a".repeat(64),
  physicalId = "/docker/" + "b".repeat(64);
const options = {
  runId: "run-1",
  member: { group: "platform", service: "control-plane", physicalId },
  startMs: 10000,
  endMs: 40000,
  cadenceMs: 5000,
  housekeepingMs: 1000,
  expectedImageId: image,
  sourceProfile: "cadvisor-complete-disk-frame.v1",
  evidenceRef: "fixture-kernel.jsonl"
};
const records = () =>
  Array.from({ length: 8 }, (_, i) => ({
    runId: "run-1",
    service: "control-plane",
    containerId: "b".repeat(64),
    imageId: image,
    state: "COMPLETE",
    kernelOwnerConfirmed: true,
    readStartedAtMs: 9000 + i * 5000,
    readFinishedAtMs: 9100 + i * 5000,
    kernelDevices: [],
    cadvisor: {
      capturedAt: new Date(8950 + i * 5000).toISOString(),
      hasDiskIo: true,
      deviceFamilies: { io_service_bytes: [], io_serviced: [] }
    }
  }));
test("only complete owned kernel and native inventories can prove an empty disk accounting source", async () => {
  const { proveEmptyDiskAccounting } = await load(),
    proof = proveEmptyDiskAccounting(records(), options);
  assert.ok(proof);
  assert.equal(proof.physicalId, physicalId);
  assert.equal(proof.sourceCoverage.missingSeconds, 0);
  assert.equal(proof.reasonCode, "native_disk_accounting_empty");
  for (const change of [
    (r: any[]) => r.splice(2, 3),
    (r: any[]) => {
      r[3].state = "UNAVAILABLE";
    },
    (r: any[]) => {
      r[3].kernelOwnerConfirmed = false;
    },
    (r: any[]) => {
      r[3].containerId = "c".repeat(64);
    },
    (r: any[]) => {
      r[3].imageId = "other";
    },
    (r: any[]) => {
      r[3].kernelDevices = [{ majorMinor: "8:48" }];
    },
    (r: any[]) => {
      r[3].cadvisor.deviceFamilies.io_service_bytes = [{ majorMinor: "8:48" }];
    },
    (r: any[]) => {
      delete r[3].cadvisor.deviceFamilies.io_serviced;
    },
    (r: any[]) => {
      r[3].cadvisor.hasDiskIo = false;
    },
    (r: any[]) => {
      r[3].cadvisor.capturedAt = new Date(0).toISOString();
    }
  ]) {
    const r: any[] = records();
    change(r);
    assert.equal(proveEmptyDiskAccounting(r, options), null);
  }
  const incomplete: any[] = records();
  incomplete.push({
    service: "discovery",
    state: "UNAVAILABLE",
    readStartedAtMs: 20000,
    readFinishedAtMs: 20100
  });
  assert.equal(proveEmptyDiskAccounting(incomplete, options), null);
  incomplete[incomplete.length - 1] = {
    service: "discovery",
    state: "UNAVAILABLE",
    readStartedAtMs: 41000,
    readFinishedAtMs: 41100
  };
  assert.ok(proveEmptyDiskAccounting(incomplete, options));
  assert.equal(proveEmptyDiskAccounting([], options), null);
  assert.equal(proveEmptyDiskAccounting(records(), { ...options, sourceProfile: undefined }), null);
});
test("a scoped availability explanation preserves partial results and never excuses a lost healthy contributor", async () => {
  const { proveEmptyDiskAccounting, explainPlatformDiskLimitation } = await load(),
    proof = proveEmptyDiskAccounting(records(), options);
  const full: any = {
    rowKey: "disk-write-platform",
    definitionId: "disk.write.bytes",
    group: "platform",
    coverage: {
      durationSeconds: 30,
      missingSeconds: 0,
      observedAcquisitions: 12,
      expectedAcquisitions: 12
    },
    statistics: {
      average: { value: 2, status: "complete" },
      p90: { value: 3, status: "complete" },
      p95: { value: 4, status: "complete" },
      total: {
        value: 60,
        status: "complete",
        observedTotal: 50,
        estimatedTotal: 10,
        coverage: { supportedContributors: 2, incompleteContributors: 0 }
      }
    }
  };
  const original: any = structuredClone(full);
  original.coverage = {
    ...full.coverage,
    missingSeconds: 30,
    expectedAcquisitions: 18,
    reasons: ["required_member_missing"]
  };
  for (const k of ["average", "p90", "p95"])
    original.statistics[k] = { value: null, status: "unavailable" };
  original.statistics.total.status = "partial";
  original.statistics.total.coverage = { supportedContributors: 2, incompleteContributors: 1 };
  const before = JSON.stringify(original),
    members = [
      options.member,
      { group: "platform", service: "prometheus", physicalId: "p" },
      { group: "platform", service: "grafana", physicalId: "g" }
    ];
  const result = explainPlatformDiskLimitation(original, full, [proof], members);
  assert.ok(result);
  assert.deepEqual(result.physicalIds, [physicalId]);
  assert.equal(JSON.stringify(original), before);
  const broken = structuredClone(full);
  broken.coverage.missingSeconds = 5;
  assert.equal(explainPlatformDiskLimitation(original, broken, [proof], members), null);
  const wrongTotal = structuredClone(full);
  wrongTotal.statistics.total.value = 61;
  assert.equal(explainPlatformDiskLimitation(original, wrongTotal, [proof], members), null);
  assert.equal(explainPlatformDiskLimitation(original, full, [], members), null);
  assert.equal(
    explainPlatformDiskLimitation(
      { ...original, definitionId: "memory.used" },
      full,
      [proof],
      members
    ),
    null
  );
});

test("availability proof files stay owned and any contradictory stored disk point prevents classification", async (t) => {
  const fs = await import("node:fs/promises"),
    os = await import("node:os"),
    root = await fs.mkdtemp(path.join(os.tmpdir(), "parkbench-availability-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { readDiskAvailabilityRecords, auditEmptyPlatformDiskSources } = await load(),
    reference = "kernel.jsonl";
  const rows = records().map((r) => ({ contractVersion: "measurement-device-state.v1", ...r }));
  await fs.writeFile(
    path.join(root, reference),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  assert.equal((await readDiskAvailabilityRecords(root, reference)).length, 8);
  await assert.rejects(
    () => readDiskAvailabilityRecords(root, "../outside.jsonl"),
    /availability_path/
  );
  await fs.symlink(path.join(root, reference), path.join(root, "linked.jsonl"));
  await assert.rejects(
    () => readDiskAvailabilityRecords(root, "linked.jsonl"),
    /availability_path/
  );
  const result = await auditEmptyPlatformDiskSources({
    prom: { queryRawRange: async () => [{ timestamp: 15, value: 99 }] },
    run: {
      id: "run-1",
      environmentSnapshot: {
        sourceCadences: { cadvisorDiskAccountingProfile: "cadvisor-complete-disk-frame.v1" }
      }
    },
    configuration: { deployedRefs: { "control-plane": image } },
    memberships: [options.member],
    options: {
      window: { start: new Date(10000).toISOString(), end: new Date(40000).toISOString() },
      sourceStepSeconds: 5,
      cadvisorHousekeepingSeconds: 1
    },
    rows: [],
    availabilityEvidence: { root, reference }
  });
  assert.deepEqual(result, { proofs: [], limitations: [] });
  await fs.writeFile(
    path.join(root, "oversized.jsonl"),
    JSON.stringify({ contractVersion: "measurement-device-state.v1", padding: "x".repeat(4096) }) +
      "\n"
  );
  await assert.rejects(
    () => readDiskAvailabilityRecords(root, "oversized.jsonl"),
    /availability_event_limit/
  );
});

test("the external device reader retains ownership and availability without raw counters or private configuration", async () => {
  const { captureDeviceState } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-device-state.mjs")
  );
  const cp = "b".repeat(64),
    reader = "c".repeat(64),
    labels = (service: string) => ({
      "com.docker.compose.project": "parkbench-platform",
      "com.docker.compose.service": service
    });
  const containers = [
    {
      Id: cp,
      Image: image,
      Config: { Labels: labels("control-plane"), Env: ["PASSWORD=never-retain-this"] },
      State: { Status: "running", Pid: 77 }
    },
    {
      Id: reader,
      Image: "cadvisor-image",
      Config: { Labels: labels("cadvisor") },
      State: { Status: "running", Pid: 22 }
    }
  ];
  let foreign = false,
    unreadable = false;
  const docker = (args: string[]) => {
    if (args[0] === "ps")
      return args.includes("label=parkbench.run_id=run-1") ? "" : cp + "\n" + reader;
    if (args[0] === "inspect") return JSON.stringify(containers);
    if (args[0] === "exec") {
      if (unreadable) throw Error("PASSWORD=never-retain-this");
      return (
        (foreign ? "PARKBENCH_CGROUP_OWNER_UNCONFIRMED" : "PARKBENCH_CGROUP_OWNER_CONFIRMED") +
        "\n8:48 rbytes=987654321 wbytes=0 rios=1 wios=0 dbytes=0 dios=0"
      );
    }
    throw Error("unexpected command");
  };
  const fetch = async () =>
    new Response(
      JSON.stringify({
        ["/docker/" + cp]: [
          {
            timestamp: new Date().toISOString(),
            has_diskio: true,
            diskio: {
              io_service_bytes: [
                { major: 8, minor: 48, device: "/dev/test", stats: { Read: 987654321, Write: 0 } }
              ],
              io_serviced: [
                { major: 8, minor: 48, device: "/dev/test", stats: { Read: 1, Write: 0 } }
              ]
            }
          }
        ]
      })
    );
  const records = await captureDeviceState("run-1", { docker, fetch });
  assert.equal(records.length, 2, "all declared platform targets are attempted");
  assert.equal(records[0].state, "COMPLETE");
  assert.deepEqual(records[0].kernelDevices[0].nonzeroCounters, ["rbytes", "rios"]);
  assert.ok(!JSON.stringify(records).includes("987654321"));
  assert.ok(!JSON.stringify(records).includes("never-retain-this"));
  foreign = true;
  assert.equal(
    (await captureDeviceState("run-1", { docker, fetch }))[0].state,
    "OWNER_UNCONFIRMED"
  );
  unreadable = true;
  const failed = await captureDeviceState("run-1", { docker, fetch });
  assert.equal(failed[0].state, "UNAVAILABLE");
  assert.equal(failed[0].reasonCode, "read_unavailable");
  assert.ok(!JSON.stringify(failed).includes("never-retain-this"));
  await assert.rejects(
    () => captureDeviceState("../other", { docker, fetch }),
    /device_reader_run_invalid/
  );
  await assert.rejects(
    () => captureDeviceState("run-1", { docker, fetch, cadvisorUrl: "https://external.example" }),
    /device_reader_origin_invalid/
  );
});

test("vanishing container discovery returns bounded unavailable evidence without dumping inspection details", async () => {
  const { captureDeviceState } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-device-state.mjs")
  );
  const docker = (args: string[]) => {
    if (args[0] === "ps") return "a".repeat(64);
    const error: any = new Error("fixture inspection failed");
    error.stdout = JSON.stringify([{ Config: { Env: ["TOKEN=fixture-secret-do-not-retain"] } }]);
    error.stderr = "fixture container disappeared";
    throw error;
  };
  const records = await captureDeviceState("run-1", { docker });
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "UNAVAILABLE");
  assert.equal(records[0].service, "discovery");
  assert.equal(records[0].reasonCode, "container_inventory_unavailable");
  assert.ok(!JSON.stringify(records).includes("fixture-secret"));
  assert.ok(Buffer.byteLength(JSON.stringify(records[0])) <= 4096);
});

test("all platform availability reads progress with two bounded asynchronous workers", async (t) => {
  const { captureDeviceState } = await import(
    path.resolve("scripts/diagnostics/capture-measurement-device-state.mjs")
  );
  const services = ["cadvisor", "control-plane", "grafana", "node-exporter", "prometheus", "web"];
  const containers = services.map((service, index) => ({
    Id: String(index + 1).repeat(64),
    Image: "sha256:" + "a".repeat(64),
    State: { Status: "running", Pid: index + 10 },
    Config: {
      Labels: {
        "com.docker.compose.project": "parkbench-platform",
        "com.docker.compose.service": service
      }
    }
  }));
  let active = 0,
    maximum = 0,
    releaseRemaining = false;
  const started: string[] = [],
    releases: Array<() => void> = [];
  t.after(() => {
    for (const release of releases) release();
  });
  const docker = async (args: string[]) => {
    if (args[0] === "ps")
      return args.includes("label=parkbench.run_id=run-1")
        ? ""
        : containers.map((c) => c.Id).join("\n");
    if (args[0] === "inspect") return JSON.stringify(containers);
    assert.equal(args[0], "exec");
    const id = args.at(-1)!;
    started.push(id);
    active++;
    maximum = Math.max(maximum, active);
    if (!releaseRemaining) await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return "PARKBENCH_CGROUP_OWNER_CONFIRMED\n";
  };
  const fetch = async (url: string) => {
    const id = new URL(url).pathname.split("/").at(-1);
    return new Response(
      JSON.stringify({
        ["/docker/" + id]: [
          {
            timestamp: new Date().toISOString(),
            has_diskio: true,
            diskio: { io_service_bytes: [], io_serviced: [] }
          }
        ]
      })
    );
  };
  const pending = captureDeviceState("run-1", { docker, fetch });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    started,
    containers.slice(0, 2).map((c) => c.Id),
    "two targets start without waiting for either slow read"
  );
  assert.equal(active, 2);
  releases[0]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    started.length,
    3,
    "a completed target admits one next target while its peer remains blocked"
  );
  assert.equal(active, 2);
  releaseRemaining = true;
  for (const release of releases) release();
  const records = await pending;
  assert.equal(maximum, 2, "Docker/native acquisition concurrency remains bounded");
  assert.deepEqual(
    records.map((r: any) => r.service),
    services,
    "stable discovery order despite independent completion"
  );
  assert.ok(records.every((r: any) => r.state === "COMPLETE" && r.kernelOwnerConfirmed));
});
