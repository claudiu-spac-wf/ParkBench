import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixtureCollector, withNativeFixture, assertEquivalentOutputs, sourceNames, ObserverFixtures, MetadataFixture } from "../helpers/openedge-observer-equivalence";
import { parseOpenEdgeDbObserverOutput, parseOpenEdgeDbParameterCaptureOutput } from "../../packages/observers/src/openedge-db/adapter";

it("native frozen inputs preserve both contracts, metadata, ordering, capabilities and parameter bounds", {
  skip: !process.env.PARKBENCH_RUN_OPENEDGE_TESTS, timeout: 180_000
}, () => {
  const root = process.cwd();
  const load = (name: string) => JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/openedge/observer-equivalence", name), "utf8"));
  const fixtures: ObserverFixtures = load("sources.json");
  const metadata: MetadataFixture = load("metadata-boundaries.json");
  const original = fs.readFileSync(path.join(root, "openedge/observers/db/parkbench-db-observer.p"), "utf8");
  const readable = fs.readFileSync(path.join(root, "openedge/observers/db/parkbench-db-observer-v2.p"), "utf8");
  withNativeFixture(session => {
    const compare = (data: ObserverFixtures, mode = "", missing: string[] = [], meta = metadata) => {
      const a = session.run(fixtureCollector(original, "original", data, meta, missing), mode);
      const b = session.run(fixtureCollector(readable, "v2", data, meta, missing), mode);
      assertEquivalentOutputs(a, b);
      return { raw: b, payload: JSON.parse(b) };
    };
    const normal = compare(fixtures);
    assert.equal(normal.payload.snapshot._DbStatus[0]["_DbStatus-BiSize"], 1004);
    assert.deepEqual(Object.keys(normal.payload.snapshot), [...sourceNames]);
    assert.deepEqual(normal.payload.labels.tables, metadata.expectedTableLabels);
    assert.deepEqual(normal.payload.labels.indexes, metadata.expectedIndexLabels);
    assert.deepEqual(normal.payload.snapshot._ActBuffer.map((r: any) => r.pool), ["primary", "alternate"]);
    assert.deepEqual(normal.payload.snapshot._Checkpoint.map((r: any) => r["_Checkpoint-Number"]), [1, 5, 9]);
    assert.ok(normal.payload.snapshot._IndexStat.some((r: any) => r.index === "other"));
    assert.ok(!normal.payload.snapshot._TableStat.some((r: any) => r.table === "other"));
    parseOpenEdgeDbObserverOutput(normal.raw);
    const full = compare(fixtures, "parameter-capture");
    assert.equal(full.payload.rows.length, 9);
    assert.equal(normal.payload.snapshot._DbParams.length, 8); // seven names plus repeated -B
    parseOpenEdgeDbParameterCaptureOutput(full.raw);
    for (const name of sourceNames) {
      const empty = structuredClone(fixtures); empty.sources[name].rows = [];
      const e = compare(empty).payload;
      if (name === "_DbStatus") assert.equal(e.fixtureError, "openedge_db_status_missing");
      else { assert.deepEqual(e.snapshot[name], []); assert.ok(!e.unavailableSources.includes(name)); }
      const absent = structuredClone(fixtures); absent.sources[name].present = false;
      const a = compare(absent).payload;
      if (name === "_DbStatus") assert.equal(a.fixtureError, "openedge_db_status_missing");
      else assert.ok(a.unavailableSources.includes(name));
    }
    compare(fixtures, "", ["_Buffer-Deferred", "_TableStat-id", "_IndexStat-id", "_DbStatus-ZeroStatsDate-TZ"]);
    const unknown = structuredClone(fixtures);
    unknown.sources._ActSummary.rows[0]["_Summary-Commits"] = null;
    unknown.sources._Logging.rows[0]["_Logging-BiIO"] = null;
    compare(unknown);
    const row = (name: string, value: string | null, flag: boolean | null = true) => ({
      "_DbParams-Name": name, "_DbParams-Value": value, "_DbParams-dtype": 1,
      "_DbParams-Is-Default": flag, "_DbParams-Is-Modifiable": null
    });
    const params = (rows: any[], missing: string[] = []) => {
      const data = structuredClone(fixtures); data.sources._DbParams.rows = rows;
      return compare(data, "parameter-capture", missing);
    };
    assert.equal(params([]).payload.status, "complete");
    const unavailable = structuredClone(fixtures); unavailable.sources._DbParams.present = false;
    assert.equal(compare(unavailable, "parameter-capture").payload.reason, "dbparams_source_unavailable");
    assert.equal(params([row("", "1")]).payload.reason, "dbparams_name_unavailable");
    assert.equal(params([row("x".repeat(129), "1")]).payload.reason, "dbparams_name_limit_exceeded");
    assert.equal(params([row("x".repeat(128), "1")]).payload.status, "complete");
    assert.equal(params([row("-B", "1")], ["_DbParams-Name"]).payload.reason, "dbparams_name_unavailable");
    assert.equal(params([row("-B", "1")], ["_DbParams-Is-Default"]).payload.reason, "dbparams_default_flag_unavailable:-B");
    assert.equal(params([row("-B", "x".repeat(8192))]).payload.status, "complete");
    assert.equal(params([row("-B", "x".repeat(8193))]).payload.reason, "dbparams_metric_value_limit_exceeded:-B");
    assert.equal(params([row("-B", "x".repeat(8193), null)]).payload.reason, "dbparams_default_flag_unavailable:-B");
    assert.equal(params([row("-B", null)], ["_DbParams-Value", "_DbParams-dtype", "_DbParams-Is-Modifiable"]).payload.rows[0].rawValue, null);
    assert.equal(params(Array.from({ length: 1025 }, (_, i) => row("p" + i, "1"))).payload.reason, "dbparams_row_limit_exceeded");
    const large = params(Array.from({ length: 100 }, (_, i) => row("p" + i, "x".repeat(22000))));
    assert.match(large.payload.reason, /^dbparams_response_limit_exceeded:/);
    assert.ok(large.raw.length > 30000); // emitJson's multiple chunks still form one JSON document.
    compare(fixtures, "", [], { tables: [], indexes: [] });
  });
});
