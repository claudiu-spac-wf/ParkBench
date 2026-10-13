import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGrafanaRoutes } from "../../../apps/control-plane/src/grafana";
import { ALIGNED_ANCHOR_MS } from "../../../apps/control-plane/src/grafana/alignment";
import {
  RunTimeline,
  RunTimelineSource
} from "../../../apps/control-plane/src/grafana/run-timeline";
import { resolveOpen } from "../../../apps/control-plane/src/grafana/open-redirect";

const t0 = Date.UTC(2026, 8, 29, 10, 0, 0);
const timeline = (runId: string, offset: number, measured = true): RunTimeline => ({
  runId,
  startedAt: t0 + offset,
  endedAt: t0 + offset + 60_000,
  measurementStart: measured ? t0 + offset + 10_000 : undefined,
  phases: measured
    ? [
        { phase: "warmup", start: t0 + offset, end: t0 + offset + 10_000 },
        { phase: "measurement", start: t0 + offset + 10_000, end: t0 + offset + 40_000 },
        { phase: "cooldown", start: t0 + offset + 40_000, end: t0 + offset + 60_000 }
      ]
    : [{ phase: "warmup", start: t0 + offset }]
});
const runs: Record<string, RunTimeline> = {
  run_a: timeline("run_a", 0),
  run_b: timeline("run_b", 3_600_000),
  run_c: timeline("run_c", 7_200_000, false)
};
const store: RunTimelineSource = {
  get: (id) => runs[id],
  list: () => Object.values(runs).sort((a, b) => b.startedAt! - a.startedAt!)
};

interface Call {
  path: string;
  params: URLSearchParams;
}

function harness(options: { prometheusDown?: boolean; failRun?: string } = {}) {
  const calls: Call[] = [];
  const logs: any[] = [];
  const fakeFetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const params = new URLSearchParams(init?.body ? String(init.body) : url.search);
    calls.push({ path: url.pathname, params });
    if (options.prometheusDown) throw new Error("connect ECONNREFUSED");
    if (url.pathname === "/-/ready") return new Response("ok", { status: 200 });
    if (options.failRun && params.get("query")?.includes(options.failRun))
      return new Response(
        JSON.stringify({ status: "error", errorType: "execution", error: "boom" }),
        { status: 422 }
      );
    if (url.pathname.endsWith("/query_range")) {
      const start = Number(params.get("start"));
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { run_id: "x" },
                values: [
                  [start, "1"],
                  [start + 5, "2"]
                ]
              }
            ]
          }
        })
      );
    }
    if (url.pathname.endsWith("/query")) {
      const time = Number(params.get("time"));
      return new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [{ metric: {}, value: [time, "1"] }] }
        })
      );
    }
    return new Response(
      JSON.stringify({
        status: "success",
        data: url.pathname.endsWith("/labels") ? ["job"] : ["up"]
      })
    );
  }) as typeof fetch;
  const app = Fastify();
  registerGrafanaRoutes(app, {
    prometheusUrl: "http://prometheus:9090",
    grafanaUrl: "http://127.0.0.1:13001",
    timelines: store,
    fetch: fakeFetch,
    log: (line) => logs.push(JSON.parse(line)),
    now: () => t0 + 10_000_000
  });
  return { app, calls, logs };
}

const form = (values: Record<string, string>) => ({
  method: "POST" as const,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: new URLSearchParams(values).toString()
});

describe("grafana-runs-datasource.v1 query API", () => {
  it("rejects queries whose selectors are not all run-scoped", async () => {
    const { app, calls, logs } = harness();
    for (const [query, error] of [
      ["up", "run_matcher_required"],
      ['up or foo{run_id="a"}', "run_matcher_required"],
      ['foo{run_id="a"} + on() group_left bar', "run_matcher_required"],
      ['foo{run_id=~".+"}', "run_matcher_required"],
      ['foo{run_id="run_a"} + foo{run_id="run_b"}', "run_matcher_mismatch"]
    ]) {
      const response = await app.inject({
        url: "/api/v1/grafana/prom/api/v1/query",
        ...form({ query })
      });
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual(
        response.json(),
        { status: "error", errorType: "bad_data", error: error },
        query
      );
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(
      new Set(logs.map((l) => l.errorClass)),
      new Set(["run_matcher_required", "run_matcher_mismatch"])
    );
    assert.ok(
      logs.every(
        (l) =>
          l.requestId && l.endpoint && typeof l.durationMs === "number" && l.outcome === "error"
      )
    );
  });

  it("passes a single-run query through unchanged in clock mode", async () => {
    const { app, calls } = harness();
    const query = 'sum(rate(foo_total{run_id=~"run_a"}[1m]))';
    const start = String((t0 + 5_000) / 1000);
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query_range",
      ...form({ query, start, end: String((t0 + 60_000) / 1000), step: "5" })
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.get("query"), query);
    assert.equal(calls[0].params.get("start"), start);
  });

  it("accepts Grafana's health check and forwards build info", async () => {
    const { app, calls } = harness();
    assert.equal(
      (await app.inject({ url: "/api/v1/grafana/prom/api/v1/query", ...form({ query: "1+1" }) }))
        .statusCode,
      200
    );
    assert.equal(
      (await app.inject({ url: "/api/v1/grafana/prom/api/v1/status/buildinfo" })).statusCode,
      200
    );
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/api/v1/query", "/api/v1/status/buildinfo"]
    );
  });

  it("answers synthetic label values from the run store without Prometheus", async () => {
    const { app, calls } = harness();
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/label/run_id/values?match[]=parkbench_run_window"
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, ["run_c", "run_b", "run_a"]);
    const series = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/series?match[]=parkbench_run_window"
    });
    assert.equal(series.json().data.length, 3);
    assert.equal(calls.length, 0);
  });

  it("never forwards write or admin endpoints", async () => {
    const { app, calls } = harness();
    for (const url of [
      "/api/v1/grafana/prom/api/v1/admin/tsdb/delete_series",
      "/api/v1/grafana/prom/api/v1/write",
      "/api/v1/grafana/prom/-/quit"
    ]) {
      const response = await app.inject({ url, method: "POST" });
      assert.equal(response.statusCode, 404, url);
    }
    assert.equal(calls.length, 0);
  });

  it("reports health, and 503 when Prometheus is down", async () => {
    assert.equal((await harness().app.inject({ url: "/api/v1/grafana/health" })).statusCode, 200);
    const down = await harness({ prometheusDown: true }).app.inject({
      url: "/api/v1/grafana/health"
    });
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().prometheus, "unavailable");
    const { app, logs } = harness({ prometheusDown: true });
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query",
      ...form({ query: 'foo{run_id="run_a"}' })
    });
    assert.equal(response.statusCode, 503);
    assert.equal(logs.at(-1).errorClass, "upstream_error");
  });
});

describe("grafana-runs-datasource.v1 aligned mode", () => {
  const start = (ALIGNED_ANCHOR_MS - 10_000) / 1000;
  const end = (ALIGNED_ANCHOR_MS + 50_000) / 1000;

  it("narrows and shifts each run onto the elapsed axis", async () => {
    const { app, calls } = harness();
    const query = 'sum by (run_id) (rate(foo_total{run_id=~"(run_a|run_b)"}[1m]))';
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query_range",
      ...form({ query, start: String(start), end: String(end), step: "5" })
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      calls.map((c) => c.params.get("query")),
      [
        'sum by (run_id) (rate(foo_total{run_id="run_a"}[1m]))',
        'sum by (run_id) (rate(foo_total{run_id="run_b"}[1m]))'
      ]
    );
    const shiftA = runs.run_a.measurementStart! - ALIGNED_ANCHOR_MS;
    assert.equal(Number(calls[0].params.get("start")), start + shiftA / 1000);
    assert.equal(calls[0].params.get("step"), "5");
    const result = response.json().data.result;
    assert.equal(result.length, 2);
    assert.equal(result[0].values[0][0], start);
  });

  it("excludes runs without a measurement phase and reports them", async () => {
    const { app, calls } = harness();
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query_range",
      ...form({
        query: 'foo{run_id=~"run_a|run_c"}',
        start: String(start),
        end: String(end),
        step: "5"
      })
    });
    assert.equal(response.json().data.result.length, 1);
    assert.equal(calls.length, 1);
    const excluded = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query",
      ...form({
        query: 'parkbench_run_alignment_excluded{run_id=~"run_a|run_c"}',
        time: String(end)
      })
    });
    assert.deepEqual(
      excluded.json().data.result.map((r: any) => r.metric.run_id),
      ["run_c"]
    );
  });

  it("fails the whole request when one run's query fails", async () => {
    const { app } = harness({ failRun: "run_b" });
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query_range",
      ...form({
        query: 'foo{run_id=~"run_a|run_b"}',
        start: String(start),
        end: String(end),
        step: "5"
      })
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().status, "error");
  });

  it("returns only a mode-mismatch notice when the range doesn't match the runs (R9)", async () => {
    const { app, calls, logs } = harness();
    const clockStart = String(t0 / 1000);
    const clockEnd = String((t0 + 60_000) / 1000);
    const data = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query_range",
      ...form({ query: 'foo{run_id=~"run_a|run_b"}', start: clockStart, end: clockEnd, step: "5" })
    });
    assert.deepEqual(data.json().data.result, []);
    assert.equal(calls.length, 0);
    assert.equal(logs.at(-1).errorClass, "mode_mismatch");
    const notice = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query",
      ...form({ query: 'parkbench_run_mode_mismatch{run_id=~"run_a|run_b"}', time: clockEnd })
    });
    assert.deepEqual(
      notice.json().data.result.map((r: any) => r.metric.expected),
      ["aligned"]
    );
    const reverse = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query",
      ...form({ query: 'parkbench_run_mode_mismatch{run_id="run_a"}', time: String(end) })
    });
    assert.deepEqual(
      reverse.json().data.result.map((r: any) => r.metric.expected),
      ["clock"]
    );
  });

  it("serves phase boundaries on the elapsed axis", async () => {
    const { app } = harness();
    const response = await app.inject({
      url: "/api/v1/grafana/prom/api/v1/query_range",
      ...form({
        query: 'parkbench_run_phase_boundary{run_id=~"run_a|run_b"}',
        start: String(start),
        end: String(end),
        step: "5"
      })
    });
    const measurement = response
      .json()
      .data.result.filter(
        (r: any) => r.metric.phase === "measurement" && r.metric.edge === "start"
      );
    assert.deepEqual(
      measurement.map((r: any) => r.values[0][0]),
      [ALIGNED_ANCHOR_MS / 1000, ALIGNED_ANCHOR_MS / 1000]
    );
  });
});

describe("grafana-runs-datasource.v1 redirect (§2)", () => {
  const deps = {
    grafanaUrl: "http://127.0.0.1:13001",
    timelines: store,
    now: () => t0 + 10_000_000
  };
  const open = (query: string) => resolveOpen(new URLSearchParams(query), deps);
  const location = (query: string) => {
    const result = open(query);
    assert.equal(result.status, 302, query);
    return new URL((result as any).location);
  };

  it("opens run-scoped dashboards in clock or aligned mode", () => {
    const one = location("dashboard=parkbench-run-summary&run_id=run_a");
    assert.equal(one.pathname, "/d/parkbench-run-summary");
    assert.deepEqual(one.searchParams.getAll("var-run_id"), ["run_a"]);
    assert.equal(one.searchParams.get("from"), String(t0));
    assert.equal(one.searchParams.get("to"), String(t0 + 60_000));
    const two = location("dashboard=parkbench-db-resources&var-run_id=run_a&var-run_id=run_b");
    assert.deepEqual(two.searchParams.getAll("var-run_id"), ["run_a", "run_b"]);
    assert.equal(two.searchParams.get("from"), String(ALIGNED_ANCHOR_MS - 10_000));
    assert.equal(two.searchParams.get("to"), String(ALIGNED_ANCHOR_MS + 50_000));
    assert.deepEqual(open("dashboard=parkbench-run-resources"), {
      status: 400,
      error: "run_required"
    });
  });

  it("keeps the range when the mode is unchanged and recalculates it otherwise", () => {
    const kept = location(
      `dashboard=parkbench-run-summary&var-run_id=run_a&from=${t0 + 1000}&to=${t0 + 2000}`
    );
    assert.equal(kept.searchParams.get("from"), String(t0 + 1000));
    const recalculated = location(
      `dashboard=parkbench-run-summary&var-run_id=run_a&var-run_id=run_b&from=${t0 + 1000}&to=${t0 + 2000}`
    );
    assert.equal(recalculated.searchParams.get("from"), String(ALIGNED_ANCHOR_MS - 10_000));
    const reset = location(
      `dashboard=parkbench-run-summary&var-run_id=run_a&from=${t0 + 1000}&to=${t0 + 2000}&reset=1`
    );
    assert.equal(reset.searchParams.get("from"), String(t0));
  });

  it("sets the Host/Platform picker only for exactly one run", () => {
    const one = location("dashboard=parkbench-host-resources&var-run_id=run_b");
    assert.equal(one.searchParams.get("var-picker_run"), "run_b");
    assert.equal(one.searchParams.get("from"), String(t0 + 3_600_000));
    const two = location(
      `dashboard=parkbench-platform-resources&var-run_id=run_a&var-run_id=run_b&from=${ALIGNED_ANCHOR_MS - 10_000}&to=${ALIGNED_ANCHOR_MS + 50_000}`
    );
    assert.equal(two.searchParams.get("var-picker_run"), null);
    assert.equal(
      two.searchParams.get("from"),
      String(t0),
      "an aligned range is converted to clock time"
    );
    const picked = location("dashboard=parkbench-run-summary&var-picker_run=run_a");
    assert.deepEqual(picked.searchParams.getAll("var-run_id"), ["run_a"]);
  });

  it("maps retired UIDs and rejects unknown dashboards", () => {
    assert.equal(
      location("dashboard=parkbench-database-resources&run_id=run_a").pathname,
      "/d/parkbench-db-resources"
    );
    assert.deepEqual(open("dashboard=nope"), { status: 404, error: "dashboard_not_found" });
  });

  it("serves the redirect over HTTP", async () => {
    const response = await harness().app.inject({
      url: "/api/v1/grafana/open?dashboard=parkbench-run-summary&run_id=run_a"
    });
    assert.equal(response.statusCode, 302);
    assert.match(
      String(response.headers.location),
      /^http:\/\/127\.0\.0\.1:13001\/d\/parkbench-run-summary\?/
    );
  });
});

it('run metadata overlaps the full explicit instant window even when Prometheus is offline',async()=>{
 const {app,calls}=harness({prometheusDown:true});
 try {
  const query=`parkbench_run_window{window_start="${t0}",window_end="${t0+60000}"}`;
  const response=await app.inject({url:'/api/v1/grafana/prom/api/v1/query',...form({query,time:String((t0+10000000)/1000)})});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json().data.result.map((r:any)=>r.metric.run_id),['run_a']);
  assert.equal(response.json().data.result[0].metric.start_ms,String(t0));
  assert.equal(calls.length,0);
 }finally{await app.close();}
});
it('text notices return explicit healthy, mismatch, excluded and empty-selection states without upstream requests',async()=>{
 const {app,calls}=harness({prometheusDown:true});
 const request=async(ids:string,kind:string,start:number,end:number)=>app.inject({url:'/api/v1/grafana/prom/api/v1/query',...form({query:`parkbench_run_notice_text{run_id=~"${ids}",kind="${kind}",window_start="${start}",window_end="${end}"}`,time:String(end/1000)})});
 try {
  const healthy=await request('run_a','time_range',t0,t0+60000);
  assert.equal(healthy.statusCode,200);assert.match(healthy.json().data.result[0].metric.message,/matches/);assert.equal(healthy.json().data.result[0].metric.active,'false');
  const mismatch=await request('run_a','time_range',ALIGNED_ANCHOR_MS,ALIGNED_ANCHOR_MS+60000);
  assert.equal(mismatch.statusCode,200);assert.match(mismatch.json().data.result[0].metric.message,/Reset/);
  const excluded=await request('run_a|run_c','excluded_runs',ALIGNED_ANCHOR_MS,ALIGNED_ANCHOR_MS+60000);
  assert.equal(excluded.statusCode,200);assert.match(excluded.json().data.result[0].metric.message,/run_c/);
  const empty=await request('','time_range',t0,t0+60000);assert.equal(empty.statusCode,200);assert.match(empty.json().data.result[0].metric.message,/Choose runs/);
  for(const [ids,kind,start,end] of [['unknown','time_range',t0,t0+60000],['run_a','bad',t0,t0+60000],['run_a','time_range',t0+60000,t0],['run_a','time_range',t0,t0+32*86400000]] as const){
   const response=await request(ids,kind,start,end);assert.ok(response.statusCode>=400,JSON.stringify([ids,kind,start,end]));
  }
  assert.equal(calls.length,0);
 }finally{await app.close();}
});
