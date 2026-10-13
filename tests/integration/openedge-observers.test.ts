import { describe, it } from "node:test";
import assert from "node:assert";
import {
  OpenEdgeDatabaseObserver,
  commandDatabaseObserver,
  OpenEdgePasObserver,
  ObserverRegistry,
  parseOpenEdgeVstOutput,
  PasManagementClient
} from "../../packages/observers/src";
import { validateOpenEdgeDatabaseCommand } from "../../packages/observers/src/openedge-db/adapter";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commandDatabaseObserverV2,
  readOpenEdgeDbObserverPayloadV2
} from "../../packages/observers/src/openedge-db/adapter";
import { addAvailableTableSample, completeOpenEdgeDbPayload } from "../helpers/openedge-db-v2";
import { DB_METRIC_ALLOWLIST } from "../../packages/observers/src/openedge-db/allowlist";
describe("OpenEdge observer adapters", () => {
  it("normalizes read-only database and PAS samples", async () => {
    const db = new OpenEdgeDatabaseObserver(async () => 1);
    const pas = new OpenEdgePasObserver(async () => ({ servletRequests: 2 }), [1, 2]);
    const context: any = {
      runId: "r",
      experimentId: "e",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    };
    assert.equal((await db.sample(context))[0].source, "openedge-vst:_DbStatus");
    const pasSamples = await pas.sample(context);
    assert.deepEqual([...new Set(pasSamples.map((sample) => sample.labels.service))].sort(), [
      "pas-1",
      "pas-2"
    ]);
    const registry = new ObserverRegistry();
    registry.register(db);
    assert.deepEqual(registry.list(), ["openedge_db_v1"]);
  });

  it("executes the supplied read-only procedure and preserves typed numeric output", async () => {
    const observer = commandDatabaseObserver(["_DbStatus"], {
      executable: process.execPath,
      procedure: "-e",
      allowNonProcedure: true,
      args: [
        'process.stdout.write(JSON.stringify({metrics:[{name:"_DbStatus",type:"counter",value:7,source:"openedge-vst:_DbStatus"}]}))'
      ]
    });
    assert.equal(await observer.ready(), true);
    const [sample] = await observer.sample({
      runId: "r",
      experimentId: "e",
      variantId: "v",
      repetition: 1,
      phase: "measurement"
    });
    assert.equal(sample.value, 7);
    assert.equal(sample.type, "counter");
    assert.equal(sample.source, "openedge-vst:_DbStatus");
    assert.equal(parseOpenEdgeVstOutput('{"dbStatus":"7"}').dbStatus.value, 7);
    assert.throws(() => parseOpenEdgeVstOutput('{"dbStatus":"ready"}'), /non_numeric/);
  });

  it("rejects a database observer configured for writable execution", () => {
    assert.throws(
      () =>
        validateOpenEdgeDatabaseCommand({
          executable: "parkbench-openedge-db-observer",
          procedure: "/app/openedge/observers/db/parkbench-db-observer-v2.p",
          readOnly: false
        }),
      /openedge_db_observer_read_only_required/
    );
  });

  it("reads one complete v2 response per scrape and retains pool, object, and availability series", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-openedge-v2-"));
    const payload = completeOpenEdgeDbPayload();
    addAvailableTableSample(payload, "Customer", 8);
    const countFile = path.join(root, "calls");
    const serializedPayload = JSON.stringify(payload);
    try {
      const [result] = await Promise.all([
        commandDatabaseObserverV2({
          executable: process.execPath,
          procedure: "-e",
          allowNonProcedure: true,
          args: [
            `require("node:fs").appendFileSync(${JSON.stringify(countFile)}, "x"); process.stdout.write(${JSON.stringify(serializedPayload)})`
          ]
        }).sample({
          runId: "run-integration",
          experimentId: "experiment-integration",
          variantId: "baseline",
          repetition: 1,
          phase: "measurement"
        })
      ]);
      assert.equal(fs.readFileSync(countFile, "utf8"), "x");
      assert.ok(result.some((sample) => sample.labels.pool === "primary"));
      assert.ok(result.some((sample) => sample.labels.pool === "alternate"));
      assert.ok(result.some((sample) => sample.labels.table === "Customer"));
      assert.ok(
        result.some((sample) => sample.metricName === "parkbench_openedge_db_metric_available")
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the canonical observer source and forbids detailed lock-row polling", () => {
    const canonicalPath = path.join(process.cwd(), "openedge/observers/db/parkbench-db-observer-v2.p");
    const buildScript = fs.readFileSync("scripts/openedge/build-images.mjs", "utf8");
    const observerDockerfile = fs.readFileSync("docker/openedge-observer/Dockerfile", "utf8");
    const source = fs.readFileSync(canonicalPath, "utf8");
    assert.ok(buildScript.includes("openedge/observers/db/parkbench-db-observer-v2.p"));
    assert.match(
      buildScript,
      /compileObserverProcedure\(contexts\.observer, dbImage\.reference, options\.databaseName\)/
    );
    assert.match(observerDockerfile, /COPY parkbench-db-observer-v2\.r /);
    assert.match(
      observerDockerfile,
      /PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE=.*parkbench-db-observer-v2\.r/
    );
    assert.match(source, /protocolVersion/);
    assert.match(source, /_ActBuffer/);
    assert.match(source, /_TableStat/);
    assert.match(source, /_IndexStat/);
    assert.doesNotMatch(source, /FOR EACH\s+_Lock|FIND\s+FIRST\s+_Lock/i);
    assert.equal(DB_METRIC_ALLOWLIST.has("_Lock"), false);
  });

  it("authenticates PAS management requests from a credential reference", async () => {
    const previous = process.env.PARKBENCH_CREDENTIAL_PAS_READONLY;
    process.env.PARKBENCH_CREDENTIAL_PAS_READONLY = "runtime-secret";
    const server = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, "Bearer runtime-secret");
      if (request.url !== "/health")
        assert.equal(
          request.url,
          "/oemanager/applications/oepas1/webapps/parkbench/transports/web/metrics"
        );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requests: 3 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const client = new PasManagementClient(
        `http://127.0.0.1:${port}`,
        1000,
        "credential:pas-readonly"
      );
      assert.equal(await client.health(), true);
      assert.deepEqual(await client.getMetrics(), { requests: 3 });
    } finally {
      if (previous === undefined) delete process.env.PARKBENCH_CREDENTIAL_PAS_READONLY;
      else process.env.PARKBENCH_CREDENTIAL_PAS_READONLY = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves an explicitly formatted Basic credential", async () => {
    const previous = process.env.PARKBENCH_CREDENTIAL_PAS_BASIC;
    process.env.PARKBENCH_CREDENTIAL_PAS_BASIC = "Basic dG9tY2F0OnRvbWNhdA==";
    const server = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, "Basic dG9tY2F0OnRvbWNhdA==");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requests: 1 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const client = new PasManagementClient(
        `http://127.0.0.1:${port}`,
        1000,
        "credential:pas-basic"
      );
      assert.deepEqual(await client.getMetrics(), { requests: 1 });
    } finally {
      if (previous === undefined) delete process.env.PARKBENCH_CREDENTIAL_PAS_BASIC;
      else process.env.PARKBENCH_CREDENTIAL_PAS_BASIC = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("normalizes the nested OpenEdge Manager metrics result", async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          result: {
            servletRequests: "4",
            postRequests: "2",
            avgABLProcessingTime: "4.5",
            startTime: "not-a-number",
            ignored: "text"
          }
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const client = new PasManagementClient(`http://127.0.0.1:${port}`);
      assert.deepEqual(await client.getMetrics(), {
        servletRequests: 4,
        postRequests: 2,
        avgABLProcessingTime: 4.5
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import test from "node:test";
import {
  ObserverCollector,
  HttpMetricsObserver,
  observerLabels
} from "../../packages/observers/src";
import { PrometheusMetricBuffer } from "../../packages/metrics/src";

test("legacy selector does not filter new valid metrics and a malformed sibling is reported", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.end("ok");
      return;
    }
    response.end(
      'parkbench_metric_a 1\nparkbench_metric_b{workload="one"} 2\nparkbench_metric_c 3\nmalformed D\n'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const context = {
    runId: "run-legacy",
    experimentId: "exp-legacy",
    variantId: "cell-0",
    repetition: 1,
    phase: "measurement"
  };
  const sink = new PrometheusMetricBuffer();
  const collector = new ObserverCollector(
    [
      {
        id: "legacy",
        kind: "core",
        required: true,
        samplingIntervalSeconds: 1,
        metrics: ["parkbench_metric_a"]
      }
    ],
    context,
    {
      create: () =>
        new HttpMetricsObserver("legacy", "core", `http://127.0.0.1:${port}`, "/metrics", 1000, [
          "parkbench_metric_a"
        ])
    },
    sink
  );
  try {
    await collector.ready(context);
    const [result] = await collector.collectPhase(context, 0);
    assert.equal(result.observed, 1);
    assert.deepEqual(
      sink
        .samples()
        .filter((sample) => sample.metricName.startsWith("parkbench_metric_"))
        .map((sample) => sample.metricName)
        .sort(),
      ["parkbench_metric_a", "parkbench_metric_b", "parkbench_metric_c"]
    );
    assert.equal(
      result.diagnostics.some((item: any) => item.code === "invalid_observer_sample_dropped"),
      true
    );
    assert.equal(
      sink.samples().find((sample) => sample.metricName === "parkbench_metric_b")?.labels.workload,
      "one"
    );
    assert.equal(
      sink.samples().find((sample) => sample.metricName === "parkbench_metric_b")?.labels.run_id,
      context.runId
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
