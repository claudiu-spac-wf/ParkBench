import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { persistRunEvidence } from "../../apps/control-plane/src/runs/evidence";
import { RunEvidence, RUN_EVIDENCE_CONTRACT_VERSION } from "../../packages/contracts/src";
import { DockerComposeOrchestrator } from "../../packages/compose-runner/src/orchestrator";
import { artifactRecord } from "../../apps/control-plane/src/artifacts/manifest";

const emptyMetricEvidence = () => ({
  sampleCount: 0,
  metricNames: [],
  sources: [],
  summaries: [],
  completeness: []
});

describe("run-evidence.v2 contract", () => {
  it("contains provenance, lower-bound timeout evidence, export ordering, and ownership", () => {
    const evidence: RunEvidence = {
      contractVersion: RUN_EVIDENCE_CONTRACT_VERSION,
      runId: "run-evidence",
      experimentId: "exp-evidence",
      variantId: "baseline",
      scenario: { id: "parkbench-bank-mix", version: "1.0.0" },
      inputs: {
        databaseImage: "db:fixture@sha256:" + "1".repeat(64),
        pasImage: "pas:fixture@sha256:" + "2".repeat(64),
        observerImage: "observer:fixture@sha256:" + "3".repeat(64),
        imageStage: "final",
        parkBenchReady: true
      },
      effectiveConfiguration: {
        values: {},
        adapterVersion: "parameters.v1"
      },
      deterministicLoadSeed: 2020,
      hostDocker: {
        architecture: "x86_64",
        engine: {
          reachable: true,
          contextName: "desktop-linux",
          serverVersion: "29.8.1",
          operatingSystem: "linux",
          architecture: "amd64"
        },
        hostEnvironment: {
          contractVersion: "host-environment.v1",
          path: "host-environment.json",
          rootSetting: "PARKBENCH_HOST_DATA_ROOT",
          capturedAt: "2026-09-23T10:00:00.000Z",
          host: {
            osId: "ubuntu",
            osRelease: "26.04.1 LTS",
            codename: "resolute",
            kernel: "7.0.0-generic",
            architecture: "x86_64"
          },
          toolchain: {
            node: "24.21.0",
            npm: "11.19.0",
            dockerClient: "29.8.1",
            compose: "5.5.1",
            compilerAdapterVersion: null
          },
          engine: {
            reachable: true,
            contextName: "desktop-linux",
            serverVersion: "29.8.1",
            operatingSystem: "linux",
            architecture: "amd64"
          }
        }
      },
      imageIdentity: {
        database: {
          configuredReference: "db:fixture",
          identityStrength: "tag"
        },
        pas: {
          configuredReference: "pas:fixture@sha256:" + "2".repeat(64),
          identityStrength: "tag"
        }
      },
      phaseBoundaries: { measurement: { startedAt: new Date(0).toISOString() } },
      workload: {
        selectedProcedure: "Workloads/Read/mixed_table_large_reads.p",
        requests: 1,
        successes: 0,
        failures: 1,
        timeoutCount: 1,
        timeoutMs: 60000,
        timeoutObservations: [{ elapsedMs: 60000, latencyObservation: "lower_bound" }]
      },
      observers: {
        health: {},
        completeness: {},
        diskIo: { container: emptyMetricEvidence(), host: emptyMetricEvidence() },
        files: emptyMetricEvidence()
      },
      metrics: {
        contractVersion: "run-metrics-reference.v1",
        source: "prometheus",
        queries: ['{run_id="run-evidence"}', '{container_label_parkbench_run_id="run-evidence"}'],
        runWindow: { start: new Date(0).toISOString(), end: new Date(1000).toISOString() },
        measurementState: "completed",
        measurementWindow: { start: new Date(200).toISOString(), end: new Date(800).toISOString() },
        stepSeconds: 15,
        sampleCount: 3,
        sources: ["loadgen"],
        labelKeys: ["run_id"]
      },
      cleanup: {
        startedAt: new Date(2000).toISOString(),
        status: "COMPLETE",
        ownedResources: ["container"],
        ownershipVerified: true
      }
    };
    assert.equal(evidence.contractVersion, "run-evidence.v2");
    assert.equal(evidence.metrics?.source, "prometheus");
    assert.ok(
      Date.parse(evidence.metrics!.runWindow.end) < Date.parse(evidence.cleanup.startedAt!)
    );
    assert.equal(evidence.workload.timeoutObservations[0].latencyObservation, "lower_bound");
    assert.equal(evidence.cleanup.ownershipVerified, true);
    assert.equal(evidence.imageIdentity?.database.identityStrength, "tag");
    assert.equal(evidence.hostDocker.hostEnvironment?.contractVersion, "host-environment.v1");
    assert.ok(Date.parse(evidence.hostDocker.hostEnvironment?.capturedAt ?? ""));
    assert.equal(evidence.hostDocker.hostEnvironment?.engine.architecture, "amd64");
    assert.equal(evidence.hostDocker.hostEnvironment?.engine.contextName, "desktop-linux");
  });

  it("records the observed Docker Engine and sanitized host profile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-host-docker-metadata-"));
    const hostRoot = path.join(root, "host-data");
    const mountedRoot = path.join(root, "container-data");
    fs.mkdirSync(hostRoot, { recursive: true });
    fs.mkdirSync(mountedRoot, { recursive: true });
    const profile = {
      contractVersion: "host-environment.v1",
      capturedAt: "2026-09-23T10:00:00.000Z",
      host: {
        osId: "ubuntu",
        osRelease: "26.04.1 LTS",
        codename: "resolute",
        kernel: "7.0.0-generic",
        architecture: "x86_64"
      },
      toolchain: {
        node: "24.21.0",
        npm: "11.19.0",
        dockerClient: "29.8.1",
        compose: "5.5.1",
        compilerAdapterVersion: null
      },
      engine: {
        reachable: true,
        contextName: "desktop-linux",
        serverVersion: "29.8.1",
        operatingSystem: "linux",
        architecture: "amd64"
      },
      checks: []
    };
    const profileContents = `${JSON.stringify(profile)}\n`;
    fs.writeFileSync(path.join(mountedRoot, "host-environment.json"), profileContents, {
      mode: 0o600
    });
    const docker = path.join(root, "docker-fixture");
    fs.writeFileSync(
      docker,
      '#!/bin/sh\nif [ "$1" = "version" ]; then echo \'{"Client":{"Version":"29.8.1"}}\'; exit 0; fi\nif [ "$1" = "info" ]; then echo "30.0.1|linux|x86_64"; exit 0; fi\nexit 2\n',
      { mode: 0o755 }
    );
    const previousDataRoot = process.env.PARKBENCH_HOST_DATA_ROOT;
    const previousContainerPathRoot = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    const previousRepositoryRoot = process.env.PARKBENCH_REPOSITORY_ROOT;
    process.env.PARKBENCH_HOST_DATA_ROOT = hostRoot;
    process.env.PARKBENCH_CONTAINER_PATH_ROOT = mountedRoot;
    process.env.PARKBENCH_REPOSITORY_ROOT = root;
    try {
      const metadata = await new DockerComposeOrchestrator(root, docker).metadata();
      const hostEnvironment = metadata.hostEnvironment as any;
      assert.equal((metadata.engine as any).serverVersion, "30.0.1");
      assert.equal((metadata.engine as any).operatingSystem, "linux");
      assert.equal((metadata.engine as any).architecture, "amd64");
      assert.equal(hostEnvironment.contractVersion, "host-environment.v1");
      assert.equal(hostEnvironment.path, "host-environment.json");
      assert.equal(hostEnvironment.engine.contextName, null);
      assert.equal("sha256" in hostEnvironment, false);
      assert.equal(JSON.stringify(hostEnvironment).includes(root), false);
    } finally {
      if (previousDataRoot === undefined) delete process.env.PARKBENCH_HOST_DATA_ROOT;
      else process.env.PARKBENCH_HOST_DATA_ROOT = previousDataRoot;
      if (previousContainerPathRoot === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
      else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previousContainerPathRoot;
      if (previousRepositoryRoot === undefined) delete process.env.PARKBENCH_REPOSITORY_ROOT;
      else process.env.PARKBENCH_REPOSITORY_ROOT = previousRepositoryRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists host/container disk I/O and file summaries from run measurements", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-run-evidence-"));
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    await platform.startupRecovery;
    const run: any = {
      id: "run-metric-evidence",
      experimentId: "exp-metric-evidence",
      variantId: "baseline",
      repetition: 1,
      state: "SUCCEEDED",
      measurementValidity: "VALID",
      composeProject: "parkbench-run-metric-evidence",
      resourceNamespace: {},
      cleanupStatus: "COMPLETE",
      environmentSnapshot: {
        scenario: {
          id: "parkbench-bank-mix",
          version: "1.0.0",
          workload: { operations: [{ method: "POST", path: "/work" }] }
        },
        inputs: { databaseImage: "parkbench-openedge-db:12.8.11" },
        hostDocker: {
          docker: "fixture",
          hostEnvironment: {
            contractVersion: "host-environment.v1",
            path: "host-environment.json",
            rootSetting: "PARKBENCH_HOST_DATA_ROOT",
            capturedAt: "2026-09-23T10:00:00.000Z",
            host: {
              osId: "ubuntu",
              osRelease: "26.04.1 LTS",
              codename: "resolute",
              kernel: "7.0.0-generic",
              architecture: "x86_64"
            },
            toolchain: {
              node: "24.21.0",
              npm: "11.19.0",
              dockerClient: "29.8.1",
              compose: "5.5.1",
              compilerAdapterVersion: null
            },
            engine: {
              reachable: true,
              contextName: "desktop-linux",
              serverVersion: "29.8.1",
              operatingSystem: "linux",
              architecture: "amd64"
            },
            privateSentinel: "private-value-must-not-be-copied"
          }
        }
      },
      imageSnapshots: {
        database: {
          configuredReference: "db:fixture",
          reference: "db:fixture",
          identityStrength: "tag"
        },
        pas: {
          configuredReference: "pas:fixture",
          reference: "pas:fixture",
          identityStrength: "tag"
        }
      },
      summary: {
        summaries: [
          metricSummary("parkbench_container_disk_read_bytes_total", "database"),
          metricSummary("parkbench_host_disk_write_bytes_total", "node-exporter"),
          metricSummary("parkbench_file_size_bytes", "file-sampler")
        ]
      },
      completeness: {
        complete: true,
        requiredGaps: [],
        optionalWarnings: [],
        evidence: [
          { observerId: "disk-io-cadvisor:database", phase: "measurement" },
          { observerId: "disk-io-node-exporter:host", phase: "measurement" },
          { observerId: "files", phase: "measurement" }
        ]
      }
    };
    platform.repositories.saveRun(run);

    const openEdgeLabels = {
      experiment_id: run.experimentId,
      run_id: run.id,
      variant_id: run.variantId,
      repetition: "1",
      component: "database",
      service: "database",
      phase: "measurement"
    };
    const openEdgeSamples = [
      {
        metricName: "parkbench_openedge_db_metric_available",
        type: "gauge",
        labels: {
          ...openEdgeLabels,
          family: "buffer_pool",
          measurement: "buffer_pool_active_buffers",
          reason: "available"
        },
        timestamp: 1,
        value: 1,
        source: "_ActBuffer"
      },
      {
        metricName: "parkbench_openedge_db_metric_available",
        type: "gauge",
        labels: {
          ...openEdgeLabels,
          family: "buffer_pool",
          measurement: "buffer_pool_configured_buffers",
          reason: "alternate_pool_disabled",
          pool: "alternate"
        },
        timestamp: 1,
        value: 0,
        source: "effective_run_configuration"
      },
      {
        metricName: "parkbench_openedge_db_buffer_pool_logical_reads_total",
        type: "counter",
        labels: { ...openEdgeLabels, pool: "primary", database_epoch: "a".repeat(64) },
        timestamp: 1,
        value: 42,
        source: "_ActBuffer"
      }
    ];
    // Run series stay in Prometheus; the finalizer passes the measurement-window samples in.
    (run.environmentSnapshot as any).metrics = {
      contractVersion: "run-metrics-reference.v1",
      source: "prometheus",
      queries: [`{run_id="${run.id}"}`, `{container_label_parkbench_run_id="${run.id}"}`],
      runWindow: { start: new Date(0).toISOString(), end: new Date(1000).toISOString() },
      measurementState: "completed",
      measurementWindow: { start: new Date(0).toISOString(), end: new Date(1000).toISOString() },
      stepSeconds: 15,
      sampleCount: openEdgeSamples.length,
      sources: ["_ActBuffer", "effective_run_configuration"],
      labelKeys: ["run_id", "database_epoch"]
    };

    const loadgenSummary = platform.storage.write(
      `${run.id}/loadgen-summary.json`,
      JSON.stringify({
        contractVersion: "loadgen.v1",
        requests: { completed: 3, errors: 0 },
        phaseResults: { measurement: { requests: 3, failures: 0 } }
      })
    );
    platform.repositories.saveArtifact(
      artifactRecord(run.id, "load_summary", loadgenSummary, "json")
    );
    const metricsSummary = platform.storage.write(
      `${run.id}/summary.json`,
      JSON.stringify({ contractVersion: "metrics.v1", summaries: run.summary.summaries })
    );
    platform.repositories.saveArtifact(
      artifactRecord(run.id, "load_summary", metricsSummary, "json")
    );

    const evidence = persistRunEvidence(
      run,
      platform.storage,
      platform.repositories,
      openEdgeSamples as any
    );
    assert.equal(evidence.observers.diskIo.container.sampleCount, 3);
    assert.deepEqual(evidence.observers.diskIo.container.metricNames, [
      "parkbench_container_disk_read_bytes_total"
    ]);
    assert.equal(
      evidence.observers.diskIo.container.completeness[0].observerId,
      "disk-io-cadvisor:database"
    );
    assert.equal(evidence.observers.diskIo.host.sources[0], "node-exporter:block-device");
    assert.equal(
      evidence.observers.diskIo.host.completeness[0].observerId,
      "disk-io-node-exporter:host"
    );
    assert.equal(evidence.observers.files.sampleCount, 3);
    assert.deepEqual(evidence.observers.files.metricNames, ["parkbench_file_size_bytes"]);
    assert.equal(evidence.observers.files.completeness[0].observerId, "files");
    assert.equal(evidence.workload.requests, 3);
    assert.equal(evidence.openedgeDb?.protocolVersion, 3);
    assert.equal(evidence.openedgeDb?.productPatch, "12.8.11");
    assert.equal(evidence.openedgeDb?.sourceImageReference, "parkbench-openedge-db:12.8.11");
    assert.ok(
      evidence.openedgeDb?.families
        .find((family) => family.name === "buffer_pool")
        ?.sources.includes("_ActBuffer")
    );
    assert.ok(
      evidence.openedgeDb?.measurementSources.some(
        (source) =>
          source.measurement === "buffer_pool_logical_reads_total" &&
          source.sourceFields.includes("_ActBuffer._Buffer-LogicRds")
      )
    );
    assert.equal(evidence.openedgeDb?.availability.length, 2);
    assert.equal(evidence.openedgeDb?.availability[1].availability, "not_configured");
    assert.deepEqual(evidence.openedgeDb?.databaseEpochs, ["a".repeat(64)]);
    assert.equal(evidence.openedgeDb?.samples.length, 3);
    assert.equal(evidence.metrics?.source, "prometheus");
    assert.equal(evidence.metrics?.stepSeconds, 15);
    assert.equal(evidence.openedgeDb?.sampleCount, 3);
    assert.equal(evidence.openedgeDb?.samplesTruncated, false);
    assert.equal(evidence.openedgeDb?.availabilityTruncated, false);
    assert.deepEqual(evidence.openedgeDb?.metricNames, ["buffer_pool_logical_reads_total"]);
    assert.equal(evidence.hostDocker.docker, "fixture");
    assert.equal(evidence.hostDocker.hostEnvironment?.contractVersion, "host-environment.v1");
    assert.equal((evidence.hostDocker.hostEnvironment as any).privateSentinel, undefined);
    assert.equal(
      JSON.stringify(evidence.hostDocker).includes("private-value-must-not-be-copied"),
      false
    );
    assert.equal(evidence.imageIdentity?.database.identityStrength, "tag");
    assert.equal(evidence.imageIdentity?.pas.configuredReference, "pas:fixture");
    platform.close();
  });
});

function metricSummary(metricName: string, service: string) {
  return {
    runId: "run-metric-evidence",
    metricName,
    labels: {
      experiment_id: "exp-metric-evidence",
      run_id: "run-metric-evidence",
      variant_id: "baseline",
      repetition: "1",
      component: service === "node-exporter" ? "host" : "container",
      service,
      phase: "measurement"
    },
    phase: "measurement",
    count: 3,
    observedSamples: 3,
    expectedSamples: 3,
    completeness: 1,
    prometheusQuery: ""
  } as any;
}
