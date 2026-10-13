export * from "./openedge-observers.test";
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../../apps/control-plane/src/server";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { PrometheusMetricBuffer, MemoryPrometheusClient } from "../../packages/metrics/src";
import { ObserverCollector, observerLabels } from "../../packages/observers/src";
import { PrometheusParseError, parsePrometheusText } from "../../packages/observers/src";

describe("observer Prometheus path", () => {
  it("keeps available database siblings ready when another declared measurement is unavailable", async () => {
    const sink = new PrometheusMetricBuffer();
    const context = {
      runId: "run-openedge-gaps",
      experimentId: "exp-openedge-gaps",
      variantId: "baseline",
      repetition: 1,
      phase: "measurement"
    };
    const collector = new ObserverCollector(
      [
        {
          id: "openedge-db",
          kind: "openedge_db_v1",
          required: true,
          samplingIntervalSeconds: 1,
          metrics: [
            "parkbench_openedge_db_table_operations_total",
            "parkbench_openedge_db_bi_bytes_written_total",
            "parkbench_openedge_db_metric_available"
          ]
        }
      ],
      context,
      {
        create(declaration) {
          return {
            id: declaration.id,
            kind: declaration.kind,
            async ready() {
              return true;
            },
            async sample(sampleContext) {
              const labels = observerLabels(sampleContext, "observer", "database");
              return [
                {
                  metricName: "parkbench_openedge_db_table_operations_total",
                  type: "counter",
                  labels: {
                    ...labels,
                    table: "Customer",
                    operation: "read",
                    database_epoch: "a".repeat(64)
                  },
                  timestamp: Date.now() / 1000,
                  value: 4,
                  source: "_TableStat"
                },
                {
                  metricName: "parkbench_openedge_db_metric_available",
                  type: "gauge",
                  labels: {
                    ...labels,
                    family: "table_activity",
                    measurement: "table_operations_total",
                    reason: "available",
                    table: "Customer",
                    operation: "read"
                  },
                  timestamp: Date.now() / 1000,
                  value: 1,
                  source: "_TableStat"
                },
                {
                  metricName: "parkbench_openedge_db_metric_available",
                  type: "gauge",
                  labels: {
                    ...labels,
                    family: "bi",
                    measurement: "bi_bytes_written_total",
                    reason: "field_missing"
                  },
                  timestamp: Date.now() / 1000,
                  value: 0,
                  source: "_ActBILog"
                }
              ];
            }
          };
        }
      },
      sink
    );
    await collector.ready(context);
    const [result] = await collector.collectPhase(context, 0);
    assert.equal(result.observed, 1);
    assert.equal(
      result.diagnostics.some((diagnostic: any) => diagnostic.code === "declared_metric_missing"),
      false
    );
    assert.ok(
      sink
        .samples()
        .some((sample) => sample.metricName === "parkbench_openedge_db_table_operations_total")
    );
    assert.equal(
      sink
        .samples()
        .some((sample) => sample.metricName === "parkbench_openedge_db_bi_bytes_written_total"),
      false
    );
  });

  it("serves runtime health, scrape, completeness, gap, and success series over HTTP", async () => {
    const buffer = new PrometheusMetricBuffer();
    const collector = new ObserverCollector(
      [
        {
          id: "custom-observer",
          kind: "custom_v1",
          required: true,
          samplingIntervalSeconds: 1,
          metrics: ["parkbench_custom_probe"]
        }
      ],
      {
        runId: "run-observer",
        experimentId: "exp-observer",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      {
        create(declaration, context) {
          return {
            id: declaration.id,
            kind: declaration.kind,
            async ready() {
              return true;
            },
            async sample(context) {
              return [
                {
                  metricName: "parkbench_custom_probe",
                  labels: observerLabels(context, "observer", declaration.id),
                  timestamp: Date.now() / 1000,
                  value: 1,
                  source: "custom-runtime"
                }
              ];
            }
          };
        }
      },
      buffer
    );
    await collector.ready({} as any);
    await collector.collectPhase(
      {
        runId: "run-observer",
        experimentId: "exp-observer",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      0
    );
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-observer-http-")),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, prometheus: new MemoryPrometheusClient(), observerMetrics: buffer }
    );
    const app = buildServer(platform);
    const response: any = await app.inject({
      method: "GET",
      url: "/internal/observer-metrics"
    });
    assert.equal(response.statusCode, 200);
    for (const metric of [
      "parkbench_observer_health",
      "parkbench_observer_scrapes_total",
      "parkbench_observer_scrape_failures_total",
      "parkbench_observer_incomplete",
      "parkbench_observer_longest_gap_seconds",
      "parkbench_observer_last_success_timestamp_seconds"
    ])
      assert.match(response.body, new RegExp(metric));
    assert.match(response.body, /run_id="run-observer"/);
    assert.match(response.body, /source="observer-runtime"/);
    await app.close();
  });

  it("uses declared duration and cadence for expected slots and records real gaps", async () => {
    const collector = new ObserverCollector(
      [
        {
          id: "cadenced",
          kind: "custom_v1",
          required: true,
          samplingIntervalSeconds: 0.001,
          metrics: ["parkbench_custom_probe"]
        }
      ],
      {
        runId: "run-cadence",
        experimentId: "exp-cadence",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      {
        create(declaration, context) {
          return {
            id: declaration.id,
            kind: declaration.kind,
            async ready() {
              return true;
            },
            async sample(context) {
              return [
                {
                  metricName: "parkbench_custom_probe",
                  labels: observerLabels(context, "observer", declaration.id),
                  timestamp: Date.now() / 1000,
                  value: 1,
                  source: "custom-runtime"
                }
              ];
            }
          };
        }
      }
    );
    await collector.ready({} as any);
    const [count] = await collector.collectPhase(
      {
        runId: "run-cadence",
        experimentId: "exp-cadence",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      2,
      0.01
    );
    assert.equal(count.expected, 20);
    assert.ok(count.observed >= 1);
    assert.ok(count.observed <= count.expected);
    assert.ok((count.lastSuccessAt ?? "").endsWith("Z"));

    const gapCollector = new ObserverCollector(
      [
        {
          id: "failing",
          kind: "custom_v1",
          required: true,
          samplingIntervalSeconds: 1,
          metrics: ["parkbench_custom_probe"]
        }
      ],
      {
        runId: "run-gap",
        experimentId: "exp-gap",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      {
        create(declaration) {
          return {
            id: declaration.id,
            kind: declaration.kind,
            async ready() {
              return true;
            },
            async sample() {
              throw new Error("observer_down");
            }
          };
        }
      }
    );
    await gapCollector.ready({} as any);
    const [gap] = await gapCollector.collectPhase(
      {
        runId: "run-gap",
        experimentId: "exp-gap",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      0.02
    );
    assert.ok((gap.longestGapSeconds ?? 0) > 0);
    assert.equal(gap.lastSuccessAt, undefined);
  });

  it("keeps scrape starts on the configured cadence when each scrape takes time", async () => {
    const context = {
      runId: "run-fixed-cadence",
      experimentId: "exp-fixed-cadence",
      variantId: "baseline",
      repetition: 1,
      phase: "measurement"
    };
    const collector = new ObserverCollector(
      [
        {
          id: "cadenced",
          kind: "custom_v1",
          required: true,
          samplingIntervalSeconds: 0.1,
          metrics: ["parkbench_custom_probe"]
        }
      ],
      context,
      {
        create(declaration) {
          return {
            id: declaration.id,
            kind: declaration.kind,
            async ready() {
              return true;
            },
            async sample(sampleContext) {
              await new Promise((resolve) => setTimeout(resolve, 60));
              return [
                {
                  metricName: "parkbench_custom_probe",
                  labels: observerLabels(sampleContext, "observer", declaration.id),
                  timestamp: Date.now() / 1000,
                  value: 1,
                  source: "custom-runtime"
                }
              ];
            }
          };
        }
      }
    );

    await collector.ready(context);
    const [result] = await collector.collectPhase(context, 0.3);

    assert.equal(result.expected, 3);
    assert.ok((result as any).attempts >= 5);
  });

  it("keeps valid observer samples when a malformed sibling is dropped", async () => {
    const sink = new PrometheusMetricBuffer();
    const collector = new ObserverCollector(
      [
        {
          id: "strict",
          kind: "custom_v1",
          required: true,
          samplingIntervalSeconds: 1,
          metrics: ["parkbench_custom_probe"]
        }
      ],
      {
        runId: "run-strict",
        experimentId: "exp-strict",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      {
        create(declaration, context) {
          return {
            id: declaration.id,
            kind: declaration.kind,
            async ready() {
              return true;
            },
            async sample(context) {
              return [
                {
                  metricName: "parkbench_custom_probe",
                  labels: observerLabels(context, "observer", declaration.id),
                  timestamp: Date.now() / 1000,
                  value: 1,
                  source: "custom-runtime"
                },
                {
                  metricName: "parkbench_untrusted_probe",
                  labels: {
                    ...observerLabels(context, "observer", declaration.id),
                    run_id: "run-other"
                  },
                  timestamp: Date.now() / 1000,
                  value: Number.NaN,
                  source: "custom-runtime"
                }
              ];
            }
          };
        }
      },
      sink
    );
    await collector.ready({} as any);
    const [count] = await collector.collectPhase(
      {
        runId: "run-strict",
        experimentId: "exp-strict",
        variantId: "baseline",
        repetition: 1,
        phase: "measurement"
      },
      0
    );
    assert.equal(count.observed, 1);
    assert.equal(
      sink.samples().some((sample) => sample.metricName === "parkbench_custom_probe"),
      true
    );
    assert.equal(
      count.diagnostics.some(
        (diagnostic: any) => diagnostic.code === "invalid_observer_sample_dropped"
      ),
      true
    );
  });

  it("accepts generic labels and rejects malformed Prometheus input with bounded diagnostics", () => {
    const context: any = {
      runId: "run-strict",
      experimentId: "exp-strict",
      variantId: "baseline",
      repetition: 1,
      phase: "measurement"
    };
    assert.throws(
      () =>
        parsePrometheusText(
          'parkbench_probe{user="private"} 1\nnot prometheus\nparkbench_probe NaN',
          context,
          "strict"
        ),
      (error: unknown) =>
        error instanceof PrometheusParseError &&
        error.diagnostics.length === 2 &&
        error.diagnostics.every((diagnostic) => diagnostic.line > 0)
    );
  });
});

it("scraped native sources keep health telemetry without controller native republication", async () => {
  for (const component of ["pas", "db"])
    for (const native of [true, false]) {
      const recorded: any[] = [];
      const collector = new ObserverCollector(
        [
          {
            id: "pas",
            kind: component === "pas" ? "openedge_pas_v1" : "openedge_db_v1",
            required: true,
            samplingIntervalSeconds: 1,
            configuration: { ...(native ? { authoritativePublisher: "endpoint" } : {}) }
          }
        ] as any,
        { runId: "r", experimentId: "e", variantId: "v", repetition: 1, phase: "measurement" },
        {
          create: () => ({
            id: "pas",
            kind: component === "pas" ? "openedge_pas_v1" : "openedge_db_v1",
            ready: async () => true,
            sample: async () => [
              {
                metricName: `parkbench_openedge_${component}_requests_total`,
                type: "counter",
                labels: {
                  run_id: "r",
                  experiment_id: "e",
                  variant_id: "v",
                  repetition: "1",
                  component: "pas",
                  service: "pas-1",
                  phase: "measurement",
                  replica: "pas-1"
                },
                timestamp: 1,
                value: 10,
                source: "native"
              }
            ]
          })
        },
        { append: (s) => recorded.push(...s) }
      );
      const results = await collector.collectPhase(
        { runId: "r", experimentId: "e", variantId: "v", repetition: 1, phase: "measurement" },
        0
      );
      assert.equal(results[0].observed, 1);
      assert.equal(
        recorded.some((x) => x.metricName === `parkbench_openedge_${component}_requests_total`),
        !native
      );
      assert.ok(recorded.some((x) => x.metricName === "parkbench_observer_health"));
    }
});
