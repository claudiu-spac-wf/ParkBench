import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixtureCollector, withNativeFixture, ObserverFixtures, MetadataFixture, assertEquivalentOutputs } from "../helpers/openedge-observer-equivalence";

it("native caches retain startup inventory and refresh names on each invocation", {
  skip: !process.env.PARKBENCH_RUN_OPENEDGE_TESTS, timeout: 90_000
}, () => {
  const root = process.cwd();
  const fixtures: ObserverFixtures = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/openedge/observer-equivalence/sources.json"), "utf8"));
  const metadata: MetadataFixture & { lifecycle: any } = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/openedge/observer-equivalence/metadata-boundaries.json"), "utf8"));
  const readable = fs.readFileSync(path.join(root, "openedge/observers/db/parkbench-db-observer-v2.p"), "utf8");
  const original = fs.readFileSync(path.join(root, "openedge/observers/db/parkbench-db-observer.p"), "utf8");
  withNativeFixture(session => {
    const first = session.run(fixtureCollector(readable, "v2", fixtures, metadata));
    const changed = structuredClone(metadata);
    changed.tables[0].tableName = metadata.lifecycle.renamedTable;
    changed.indexes[0].indexName = metadata.lifecycle.renamedIndex;
    const second = session.run(fixtureCollector(readable, "v2", fixtures, changed));
    assertEquivalentOutputs(session.run(fixtureCollector(original, "original", fixtures, changed)), second);
    assert.ok(JSON.parse(second).labels.tables.includes(metadata.lifecycle.renamedTable));
    assert.ok(!JSON.parse(first).labels.tables.includes(metadata.lifecycle.renamedTable));
    const afterStartup = fixtureCollector(readable, "v2", fixtures, metadata).replace("RUN loadLabelSets.",
      `FOR EACH fixtureFile: fixtureFile.tableName = "ChangedAfterStartup". END.\nEMPTY TEMP-TABLE fixtureIndex.\nRUN loadLabelSets.`);
    assertEquivalentOutputs(first, session.run(afterStartup));
    const empty: MetadataFixture = { tables: [], indexes: [] };
    const blank = JSON.parse(session.run(fixtureCollector(readable, "v2", fixtures, empty)));
    assert.deepEqual(blank.labels, { tables: [], indexes: [] });
    for (const mode of ["", "parameter-capture"]) {
      const partial = fixtureCollector(readable, "v2", fixtures, metadata).replace("      RELEASE ttFile.",
        '      RELEASE ttFile.\n      RETURN ERROR "openedge_db_metadata_initialization_failed".');
      const result = JSON.parse(session.run(partial, mode));
      assert.deepEqual(result, { fixtureError: "openedge_db_metadata_initialization_failed" });
    }
  });
});

it("native raw preparation isolates concurrent invocations and rejects stale compilation", {
  skip: !process.env.PARKBENCH_RUN_OPENEDGE_TESTS, timeout: 90_000
}, () => {
  const root = process.cwd();
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  withNativeFixture(session => {
    session.install(read("openedge/observers/db/parkbench-db-observer-v2.p"), "/app/openedge/observers/db/parkbench-db-observer-v2.p");
    const bootstrap = read("openedge/observers/db/prepare-run-db-observer.p");
    for (const mode of ["", "parameter-capture"]) {
      const result = JSON.parse(session.run(bootstrap, mode));
      assert.equal(result.protocolVersion || result.contractVersion, mode ? "openedge-db-parameter-capture.v1" : 3);
    }
    session.install(bootstrap, "/tmp/feature017/bootstrap.p");
    session.inspect(["/bin/sh", "-ec", `cd /tmp/feature017
      /psc/dlc/bin/prodb fixture2 empty >/dev/null 2>&1
      TERM=xterm /psc/dlc/bin/_progres -b -1 -db fixture -T /tmp/feature017 -p bootstrap.p >first.json &
      first=$!
      TERM=xterm /psc/dlc/bin/_progres -b -1 -db fixture2 -T /tmp/feature017 -p bootstrap.p -param parameter-capture >second.json &
      second=$!
      wait "$first"
      wait "$second"`]);
    assert.equal(JSON.parse(session.inspect(["cat", "/tmp/feature017/first.json"])).protocolVersion, 3);
    assert.equal(JSON.parse(session.inspect(["cat", "/tmp/feature017/second.json"])).contractVersion, "openedge-db-parameter-capture.v1");
    session.install("This fails compilation.", "/app/openedge/observers/db/parkbench-db-observer-v2.p");
    assert.equal(JSON.parse(session.run(bootstrap)).fixtureError, "openedge_db_observer_compile_failed");
    assert.equal(session.inspect(["find", "/tmp/feature017", "-name", "parkbench-db-observer-*"]).trim(), "");
  });
});
