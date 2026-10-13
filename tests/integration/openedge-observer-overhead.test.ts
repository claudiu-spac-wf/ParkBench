import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetricSample } from "../../packages/contracts/src/metrics";
import {
  assertObserverOverheadPair,
  buildObserverOverheadEvidence,
  ObserverOverheadPairEvidence
} from "../../apps/control-plane/src/runs/observer-overhead";

describe("OpenEdge observer overhead evidence", () => {
  it("accepts only otherwise-identical observer-off and observer-on evidence", () => {
    const off: ObserverOverheadPairEvidence = {
      deterministicLoadSeed: 2020,
      inputs: {
        databaseImage: "db:12.8.11",
        pasImage: "pas:12.8.11",
        observerImage: "observer:12.8.11"
      },
      effectiveConfiguration: {
        values: { "database.metricsEnabled": false, "workload.seed": 2020 }
      }
    };
    const on: ObserverOverheadPairEvidence = {
      ...off,
      effectiveConfiguration: {
        values: { "database.metricsEnabled": true, "workload.seed": 2020 }
      }
    };

    assert.doesNotThrow(() => assertObserverOverheadPair(off, on));
    assert.doesNotThrow(() =>
      assertObserverOverheadPair(off, {
        ...on,
        inputs: { ...on.inputs, databaseImage: "another-db:12.8.11" }
      })
    );
  });

  it("recognizes native endpoint telemetry after Prometheus assigns the database service label", () => {
    const evidence = buildObserverOverheadEvidence({
      mode: "observer_on",
      pairedRunId: "off",
      sharedLoadSeed: 1,
      samples: [
        sample("parkbench_observer_collection_duration_seconds", 0.25, {
          service: "database",
          kind: "openedge_db_v1",
          phase: "measurement"
        }),
        sample("parkbench_observer_collection_duration_seconds", 9, {
          service: "pas",
          kind: "openedge_pas_v1",
          phase: "measurement"
        })
      ],
      workload: {
        requests: 1,
        successes: 1,
        failures: 0,
        timeoutCount: 0,
        timeoutMs: 60000,
        timeoutObservations: []
      }
    });
    assert.equal(evidence.collectorDurationSeconds.samples, 1);
    assert.equal(evidence.collectorDurationSeconds.mean, 0.25);
  });

  it("captures collection duration, observer resources, throughput, and latency without a ceiling", () => {
    const samples: MetricSample[] = [
      sample("parkbench_observer_collection_duration_seconds", 0.2, {
        service: "openedge-db",
        phase: "measurement"
      }),
      sample("parkbench_observer_collection_duration_seconds", 0.4, {
        service: "openedge-db",
        phase: "measurement"
      }),
      sample("container_cpu_usage_seconds_total", 2, {
        service: "db-observer",
        phase: "measurement",
        id: "/observer",
        cpu: "total"
      }),
      sample("container_cpu_usage_seconds_total", 3.5, {
        service: "db-observer",
        phase: "measurement",
        id: "/observer",
        cpu: "total"
      }),
      sample("container_memory_working_set_bytes", 100, {
        service: "db-observer",
        phase: "measurement"
      })
    ];
    const evidence = buildObserverOverheadEvidence({
      mode: "observer_on",
      pairedRunId: "run-off",
      sharedLoadSeed: 2020,
      samples,
      workload: {
        requests: 8,
        successes: 8,
        failures: 0,
        timeoutCount: 0,
        timeoutMs: 60000,
        timeoutObservations: [],
        throughputPerSecond: 4,
        latencySeconds: { p50: 0.1, p95: 0.2, p99: 0.25 }
      }
    });

    assert.equal(evidence.collectorDurationSeconds.samples, 2);
    assert.ok(Math.abs(evidence.collectorDurationSeconds.mean - 0.3) < 1e-10);
    assert.equal(evidence.collectorDurationSeconds.p95, 0.4);
    assert.equal(evidence.observerResources.cpuCoreSeconds, 1.5);
    assert.equal(evidence.observerResources.peakMemoryBytes, 100);
    assert.equal(evidence.workload.throughputPerSecond, 4);
    assert.deepEqual(evidence.workload.latencySeconds, { p50: 0.1, p95: 0.2, p99: 0.25 });
  });
});

function sample(metricName: string, value: number, labels: Record<string, string>): MetricSample {
  return {
    metricName,
    type: metricName.endsWith("_total") ? "counter" : "gauge",
    labels: {
      experiment_id: "exp-on",
      run_id: "run-on",
      variant_id: "observer-on",
      repetition: "1",
      component: "db-observer",
      service: "db-observer",
      phase: "measurement",
      ...labels
    },
    timestamp: value + 100,
    value,
    source: "fixture"
  };
}
