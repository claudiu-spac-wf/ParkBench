import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveDashboardTimeRange } from "../../apps/control-plane/src/comparisons/dashboard-context-service";

describe("dashboard run time range", () => {
  it("uses the full completed run interval", () => {
    assert.deepEqual(
      deriveDashboardTimeRange([
        {
          startedAt: "2026-09-26T08:00:00.000Z",
          finishedAt: "2026-09-26T08:01:00.000Z"
        }
      ]),
      { from: "2026-09-26T08:00:00.000Z", to: "2026-09-26T08:01:00.000Z" }
    );
  });

  it("spans every selected run and keeps the end live while any run is active", () => {
    assert.deepEqual(
      deriveDashboardTimeRange([
        { startedAt: "2026-09-26T08:00:00.000Z", finishedAt: "2026-09-26T08:01:00.000Z" },
        { startedAt: "2026-09-26T08:02:00.000Z" }
      ]),
      { from: "2026-09-26T08:00:00.000Z", to: "now" }
    );
  });

  it("uses phase boundaries when a run has no top-level timestamps", () => {
    assert.deepEqual(
      deriveDashboardTimeRange([
        {
          phaseBoundaries: {
            warmup: {
              startedAt: "2026-09-26T08:00:00.000Z",
              finishedAt: "2026-09-26T08:00:10.000Z"
            },
            measurement: {
              startedAt: "2026-09-26T08:00:10.000Z",
              finishedAt: "2026-09-26T08:00:40.000Z"
            }
          }
        }
      ]),
      { from: "2026-09-26T08:00:00.000Z", to: "now" }
    );
  });
});

import windows from "../fixtures/benchmark-readiness/run-windows.json";
import {syntheticSeries} from "../../apps/control-plane/src/grafana/synthetic-series";
import {ALIGNED_ANCHOR_MS} from "../../apps/control-plane/src/grafana/alignment";
it("tests full explicit instant windows with touched edges and an actual active end",()=>{
 const timelines=windows.cases.map(c=>({runId:c.id,startedAt:c.start,endedAt:c.end??undefined,phases:[]}));
 const rows=syntheticSeries({metric:"parkbench_run_window",mode:"clock",timelines,start:9999,end:9999,step:0,windowStart:windows.window[0],windowEnd:windows.window[1],now:windows.now});
 assert.deepEqual(rows.map(r=>r.metric.run_id),windows.cases.filter(c=>c.expected).map(c=>c.id));
 assert.equal(rows.find(r=>r.metric.run_id==="active")?.metric.end_ms,"2500");
});
it("aligns overlapping lifetimes while keeping real jump bounds and excluded metadata",()=>{
 const rows=syntheticSeries({metric:"parkbench_run_window",mode:"aligned",timelines:[{runId:"a",startedAt:5000,endedAt:5160,measurementStart:5030,phases:[]},{runId:"no-anchor",startedAt:5000,endedAt:5160,phases:[]}],start:ALIGNED_ANCHOR_MS,end:ALIGNED_ANCHOR_MS,windowStart:ALIGNED_ANCHOR_MS-30,windowEnd:ALIGNED_ANCHOR_MS+130,step:0});
 assert.equal(rows.length,2);assert.equal(rows[0].metric.start_ms,"5000");assert.equal(rows[1].metric.excluded,"true");
});
