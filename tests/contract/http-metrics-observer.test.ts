import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HttpMetricsObserver,
  parsePrometheusText
} from "../../packages/observers/src/http-observer";
import { ObserverCollector } from "../../packages/observers/src/collector";

describe("HTTP metrics observer readiness", () => {
  it("accepts database startup snapshot labels during readiness and sampling", async () => {
    const originalFetch = globalThis.fetch;
    const metrics = [
      'parkbench_openedge_db_metric_available{measurement="logical_reads_total",reason="available",source="_ActSummary"} 1',
      'parkbench_openedge_db_parameter_snapshot_status{database_name="parkbench",state="partial"} 1',
      'parkbench_openedge_db_parameter_snapshot_info{database_name="parkbench",parameter="-B",display_value="1000",value_status="recorded"} 1'
    ].join("\n");
    const responses = [new Response("ok"), new Response(metrics), new Response(metrics)];
    globalThis.fetch = async () => responses.shift()!;
    try {
      const observer = new HttpMetricsObserver(
        "openedge-db",
        "openedge_db_v1",
        "http://observer:9100",
        "/metrics",
        1000,
        ["parkbench_openedge_db_metric_available"]
      );
      assert.equal(await observer.ready(), true);
      const samples = await observer.sample({
        runId: "run-1",
        experimentId: "exp-1",
        variantId: "v1",
        repetition: 1,
        phase: "measurement"
      });
      assert.ok(
        samples.some((sample) => sample.metricName === "parkbench_openedge_db_metric_available")
      );
      const parsed = parsePrometheusText(
        metrics,
        {
          runId: "run-1",
          experimentId: "exp-1",
          variantId: "v1",
          repetition: 1,
          phase: "measurement"
        },
        "openedge-db"
      );
      assert.equal(
        parsed.find(
          (sample) => sample.metricName === "parkbench_openedge_db_parameter_snapshot_info"
        )?.labels.display_value,
        "1000"
      );
      assert.doesNotThrow(() =>
        parsePrometheusText(
          'parkbench_file_size_bytes{display_value="1000"} 1',
          {
            runId: "run-1",
            experimentId: "exp-1",
            variantId: "v1",
            repetition: 1,
            phase: "measurement"
          },
          "files"
        )
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses a quoted parameter value containing a brace and escaped punctuation", () => {
    const context = {
      runId: "run-1",
      experimentId: "exp-1",
      variantId: "v1",
      repetition: 1,
      phase: "measurement"
    };
    const line =
      'parkbench_openedge_db_parameter_snapshot_info{database_name="parkbench",parameter="-text",display_value="a}b\\\"c\\nd",value_status="recorded"} 1';
    const [sample] = parsePrometheusText(line, context, "openedge-db");
    assert.equal(sample.labels.display_value, 'a}b"c\nd');
  });

  it("accepts observer collection telemetry labels", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("ok", { status: 200 }),
      new Response(
        [
          'parkbench_observer_collection_duration_seconds{kind="file_sampler_v1",outcome="success"} 0.001',
          "parkbench_file_size_bytes 24"
        ].join("\n"),
        { status: 200 }
      )
    ];
    globalThis.fetch = async () => responses.shift()!;
    try {
      const observer = new HttpMetricsObserver(
        "files",
        "file_sampler_v1",
        "http://observer:9100",
        "/metrics",
        1000,
        ["parkbench_file_size_bytes"]
      );
      assert.equal(await observer.ready(), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains bounded collection telemetry alongside the declared metric set", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("ok", { status: 200 }),
      new Response(
        [
          'parkbench_observer_collection_duration_seconds{kind="openedge_db_v1",outcome="success"} 0.25',
          'parkbench_openedge_db_metric_available{measurement="logical_reads_total",reason="available",source="_ActSummary"} 1',
          "parkbench_file_size_bytes 24"
        ].join("\n"),
        { status: 200 }
      ),
      new Response(
        [
          'parkbench_observer_collection_duration_seconds{kind="openedge_db_v1",outcome="success"} 0.25',
          'parkbench_openedge_db_metric_available{measurement="logical_reads_total",reason="available",source="_ActSummary"} 1',
          "parkbench_file_size_bytes 24"
        ].join("\n"),
        { status: 200 }
      )
    ];
    globalThis.fetch = async () => responses.shift()!;
    try {
      const observer = new HttpMetricsObserver(
        "openedge-db",
        "openedge_db_v1",
        "http://observer:9100",
        "/metrics",
        1000,
        ["parkbench_openedge_db_metric_available"]
      );
      await observer.ready();
      const samples = await observer.sample({
        runId: "run-1",
        experimentId: "exp-1",
        variantId: "observer-on",
        repetition: 1,
        phase: "measurement"
      });
      const duration = samples.find(
        (sample) => sample.metricName === "parkbench_observer_collection_duration_seconds"
      );
      assert.equal(duration?.value, 0.25);
      assert.equal(duration?.labels.run_id, "run-1");
      assert.equal(duration?.labels.phase, "measurement");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts observer samples when collection telemetry has bounded kind and outcome labels", async () => {
    const originalFetch = globalThis.fetch;
    const metrics = [
      'parkbench_observer_collection_duration_seconds{kind="file_sampler_v1",outcome="success"} 0.001',
      'parkbench_observer_collection_outcomes_total{kind="file_sampler_v1",outcome="success"} 1',
      "parkbench_file_size_bytes 24"
    ].join("\n");
    const responses = [
      new Response("ok", { status: 200 }),
      new Response(metrics, { status: 200 }),
      new Response(metrics, { status: 200 })
    ];
    globalThis.fetch = async () => responses.shift()!;
    try {
      const context = {
        runId: "run-1",
        experimentId: "exp-1",
        variantId: "observer-on",
        repetition: 1,
        phase: "measurement"
      };
      const declaration = {
        id: "files",
        kind: "file_sampler_v1",
        required: true,
        samplingIntervalSeconds: 1,
        metrics: ["parkbench_file_size_bytes"],
        configuration: { metricsUrl: "http://observer:9100" }
      };
      const observer = new HttpMetricsObserver(
        declaration.id,
        declaration.kind,
        declaration.configuration.metricsUrl,
        "/metrics",
        1000,
        declaration.metrics
      );
      const collector = new ObserverCollector([declaration], context, {
        create: () => observer
      });

      await collector.ready(context);
      const [result] = await collector.collectPhase(context, 0, 0);

      assert.equal(result.observed, 1, JSON.stringify(result));
      assert.deepEqual(result.diagnostics, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts OpenEdge measurements explicitly marked unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("ok", { status: 200 }),
      new Response(
        [
          'parkbench_openedge_db_configured_buffers{source="vst"} 3000',
          'parkbench_openedge_db_metric_available{measurement="logical_reads_total",reason="not_supported",source="vst"} 0'
        ].join("\n"),
        { status: 200 }
      )
    ];
    globalThis.fetch = async () => responses.shift()!;
    try {
      const observer = new HttpMetricsObserver(
        "openedge-db",
        "openedge_db_v1",
        "http://observer:9100",
        "/metrics",
        1000,
        ["parkbench_openedge_db_configured_buffers", "parkbench_openedge_db_logical_reads_total"]
      );
      assert.equal(await observer.ready(), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports an absent OpenEdge measurement without an availability marker", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response("ok", { status: 200 }),
      new Response('parkbench_openedge_db_configured_buffers{source="vst"} 3000', {
        status: 200
      })
    ];
    globalThis.fetch = async () => responses.shift()!;
    try {
      const observer = new HttpMetricsObserver(
        "openedge-db",
        "openedge_db_v1",
        "http://observer:9100",
        "/metrics",
        1000,
        ["parkbench_openedge_db_configured_buffers", "parkbench_openedge_db_logical_reads_total"]
      );
      assert.equal(await observer.ready(), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

it("preserves native counter/gauge declarations and repeated cached capture timestamps", () => {
  const context = {
    runId: "r",
    experimentId: "e",
    variantId: "v",
    repetition: 1,
    phase: "measurement" as const
  };
  const text =
    '# TYPE parkbench_openedge_pas_requests_total counter\nparkbench_openedge_pas_requests_total{replica="pas-2"} 10 100000\n# TYPE active_session_count gauge\nactive_session_count 5 100000\n# TYPE fixture_hist histogram\nfixture_hist_count 4 100000\n';
  const first = parsePrometheusText(text, context, "pas-2"),
    cached = parsePrometheusText(text, context, "pas-2");
  assert.deepEqual(cached, first);
  assert.equal(first[0].type, "counter");
  assert.equal(first[0].timestamp, 100);
  assert.equal(first[0].labels.replica, "pas-2");
  assert.equal(first[1].type, "gauge");
  assert.equal(first[2].type, "histogram");
});
