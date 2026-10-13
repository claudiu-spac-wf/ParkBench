import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALIGNED_ANCHOR_MS,
  alignedRange,
  clockRange,
  modeMismatch
} from "../../../apps/control-plane/src/grafana/alignment";
import { timelineFromRun } from "../../../apps/control-plane/src/grafana/run-timeline";
import { syntheticSeries } from "../../../apps/control-plane/src/grafana/synthetic-series";

const t0 = Date.UTC(2026, 8, 29, 10, 0, 0);
const iso = (offsetSeconds: number) => new Date(t0 + offsetSeconds * 1000).toISOString();

function run(
  id: string,
  startOffset: number,
  warmup: number,
  measurement: number,
  cooldown: number,
  finished = true
) {
  const s = startOffset;
  return timelineFromRun({
    id,
    startedAt: iso(s),
    finishedAt: finished ? iso(s + warmup + measurement + cooldown) : undefined,
    phaseBoundaries: {
      warmup: { startedAt: iso(s), finishedAt: iso(s + warmup) },
      measurement: { startedAt: iso(s + warmup), finishedAt: iso(s + warmup + measurement) },
      ...(finished
        ? {
            cooldown: {
              startedAt: iso(s + warmup + measurement),
              finishedAt: iso(s + warmup + measurement + cooldown)
            }
          }
        : {})
    }
  });
}

describe("default ranges (FR-016a)", () => {
  it("uses the full run span in clock mode", () => {
    const a = run("a", 0, 10, 30, 5);
    assert.deepEqual(clockRange([a]), { from: t0, to: t0 + 45_000 });
  });

  it("uses the earliest warmup and latest end on the aligned axis", () => {
    const a = run("a", 0, 10, 30, 5);
    const b = run("b", 3600, 20, 40, 5);
    assert.deepEqual(alignedRange([a, b]), {
      from: ALIGNED_ANCHOR_MS - 20_000,
      to: ALIGNED_ANCHOR_MS + 45_000
    });
  });

  it("runs a run still in progress up to now", () => {
    const a = run("a", 0, 10, 30, 5, false);
    assert.equal(clockRange([a], t0 + 25_000)!.to, t0 + 25_000);
  });
});

describe("mode mismatch (contract R9)", () => {
  it("detects clock ranges in aligned mode and the reverse", () => {
    assert.equal(modeMismatch("aligned", t0, t0 + 60_000), "aligned");
    assert.equal(modeMismatch("clock", ALIGNED_ANCHOR_MS, ALIGNED_ANCHOR_MS + 60_000), "clock");
    assert.equal(
      modeMismatch("aligned", ALIGNED_ANCHOR_MS - 10_000, ALIGNED_ANCHOR_MS + 60_000),
      undefined
    );
    assert.equal(modeMismatch("clock", t0, t0 + 60_000), undefined);
  });
});

describe("synthetic series", () => {
  it("places phase boundaries on the aligned axis, measurement start at the anchor", () => {
    const a = run("a", 0, 10, 30, 5);
    const series = syntheticSeries({
      metric: "parkbench_run_phase_boundary",
      timelines: [a],
      mode: "aligned",
      start: ALIGNED_ANCHOR_MS - 60_000,
      end: ALIGNED_ANCHOR_MS + 60_000,
      step: 5_000
    });
    const measurementStart = series.find(
      (s) => s.metric.phase === "measurement" && s.metric.edge === "start"
    );
    assert.equal(measurementStart!.points[0][0], ALIGNED_ANCHOR_MS);
    const warmupStart = series.find(
      (s) => s.metric.phase === "warmup" && s.metric.edge === "start"
    );
    assert.equal(warmupStart!.points[0][0], ALIGNED_ANCHOR_MS - 10_000);
  });

  it("only emits reached boundaries", () => {
    const a = run("a", 0, 10, 30, 5, false);
    const series = syntheticSeries({
      metric: "parkbench_run_phase_boundary",
      timelines: [a],
      mode: "clock",
      start: t0 - 1000,
      end: t0 + 3600_000,
      step: 1000,
      now: t0 + 20_000
    });
    assert.deepEqual(series.map((s) => `${s.metric.phase}:${s.metric.edge}`).sort(), [
      "measurement:start",
      "warmup:end",
      "warmup:start"
    ]);
  });

  it("lists runs overlapping the range with start and end labels", () => {
    const a = run("a", 0, 10, 30, 5);
    const b = run("b", 7200, 10, 30, 5);
    const series = syntheticSeries({
      metric: "parkbench_run_window",
      timelines: [a, b],
      mode: "clock",
      start: t0 - 1000,
      end: t0 + 600_000,
      step: 0
    });
    assert.deepEqual(
      series.map((s) => s.metric.run_id),
      ["a"]
    );
    assert.equal(series[0].metric.start_ms, String(t0));
    assert.equal(series[0].metric.end_ms, String(t0 + 45_000));
  });
});
