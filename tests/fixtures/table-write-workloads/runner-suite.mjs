import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { repositoryRoot } from "../../../scripts/openedge/generate-write-workloads.mjs";
import {
  assertTargetOnly,
  assertPreserved,
  assertRelationships,
  assertSnapshot
} from "./assertions.mjs";
const hash = (source) => crypto.createHash("sha256").update(source).digest("hex");
export async function run({ fixture, options, inventory, report }) {
  fixture.compileDrivers(["prepare", "verify"]);
  fixture.prepareEmpty({ count: 100 });
  const staged = path.join(fixture.root, "Workloads/Write/Fixture");
  fs.cpSync(path.join(repositoryRoot, "tests/fixtures/table-write-workloads/runner"), staged, {
    recursive: true
  });
  const readinessSource = fs
    .readFileSync(path.join(fixture.root, "Workloads/Write/Account.p"), "utf8")
    .replace(
      "pbIgnored = pbLoadInventory().",
      'pbIgnored = pbLoadInventory().\n  pbIgnored = pbRequirement("table", "WriteFixtureMissingTable", "", "").'
    );
  fs.writeFileSync(path.join(staged, "schema-failure.p"), readinessSource);
  for (const name of ["Generic", "ParkBench"])
    fs.cpSync(
      path.join(repositoryRoot, "openedge/workloads/Workloads", name),
      path.join(fixture.root, "Workloads", name),
      { recursive: true, filter: (file) => !file.endsWith(".r") }
    );
  fs.cpSync(
    path.join(repositoryRoot, "tests/fixtures/openedge/workloads/Workloads/Fixture"),
    path.join(fixture.root, "Workloads/Fixture"),
    { recursive: true, filter: (file) => !file.endsWith(".r") }
  );
  const sources = [];
  for (const subfolder of ["Write/Fixture", "Fixture", "Generic", "ParkBench"])
    for (const filename of fs
      .readdirSync(path.join(fixture.root, "Workloads", subfolder))
      .filter((n) => n.endsWith(".p")))
      sources.push("/validation/Workloads/" + subfolder + "/" + filename);
  fixture.compileSources(sources);
  const originalHandler = fs.readFileSync(
    path.join(repositoryRoot, "openedge/runner/ParkBenchWorkHandler.cls"),
    "utf8"
  );
  report.handlerHash = hash(originalHandler);
  report.temporaryFixtures = sources;
  const table = inventory.tables.find((t) => t.name === "CustomerNote");
  async function outcome(id, proc, status, code, { persistent = false, elapsed = false } = {}) {
    const before = fixture.snapshotAll();
    const response = await fixture.requestProcedure(
      proc,
      { marker: "parkbench" },
      { timeoutMs: 75000 }
    );
    assert.equal(response.status, status, id + ":" + JSON.stringify(response.body));
    if (code) assert.equal(response.body.error, code);
    const after = fixture.snapshotAll();
    if (persistent) {
      assertTargetOnly(before, after, "CustomerNote");
      assertPreserved(before.CustomerNote, after.CustomerNote, table, {
        selectedIds: [1],
        fields: ["Summary"],
        lobs: ["NoteText"]
      });
      assert.notEqual(after.CustomerNote.rows[0].Summary, before.CustomerNote.rows[0].Summary);
      assert.notEqual(
        after.CustomerNote.rows[0].NoteText.sha256,
        before.CustomerNote.rows[0].NoteText.sha256
      );
      assert.deepEqual(Object.keys(response.body).sort(), [
        "elapsedMs",
        "ok",
        "procName",
        "requestId"
      ]);
    } else assert.deepEqual(after, before);
    if (elapsed) assert.ok(response.body.elapsedMs >= 60000);
    const entry = {
      id,
      ok: true,
      status,
      code,
      committed: persistent,
      elapsedMs: response.body.elapsedMs
    };
    report.cases.push(entry);
    console.log("write_runner_case:" + id);
  }
  // The real production handler and its unmodified sixty-second STOP path.
  report.pas = await fixture.startPas();
  for (const [name, input] of [
    ["Account", { Operation: "create", Limit: 1, WhereClause: "", FieldsList: [], LobFields: [] }],
    [
      "Customer",
      {
        Operation: "update",
        Limit: 1,
        WhereClause: "CustomerId = 1",
        FieldsList: ["Email", "UpdatedAt"],
        LobFields: []
      }
    ],
    [
      "CustomerDocument",
      {
        Operation: "update",
        Limit: 1,
        WhereClause: "CustomerDocumentId = 1",
        FieldsList: ["FileSizeBytes", "UpdatedAt"],
        LobFields: ["Content"]
      }
    ],
    [
      "StatementDocument",
      {
        Operation: "update",
        Limit: 1,
        WhereClause: "StatementDocumentId = 1",
        FieldsList: [],
        LobFields: ["StatementXml"]
      }
    ]
  ]) {
    const before = fixture.snapshotAll();
    const response = await fixture.request(name, input);
    assert.equal(
      response.status,
      200,
      "operator walkthrough " + name + ":" + JSON.stringify(response.body)
    );
    const after = fixture.snapshotAll();
    const descriptor = inventory.tables.find((t) => t.name === name);
    assertTargetOnly(before, after, name);
    assertSnapshot(after[name], descriptor);
    assertRelationships(after, inventory);
    if (input.Operation === "create") {
      assert.equal(after[name].count - before[name].count, 1);
      assert.deepEqual(
        after[name].rows.filter((r) => r[descriptor.primaryField] <= 100),
        before[name].rows
      );
    } else {
      assertPreserved(before[name], after[name], descriptor, {
        selectedIds: [1],
        fields: input.FieldsList,
        lobs: input.LobFields
      });
      for (const lob of input.LobFields) {
        assert.equal(
          after[name].rows[0][lob].bytes,
          descriptor.fields.find((f) => f.name === lob).lob.defaultBytes
        );
        assert.notEqual(after[name].rows[0][lob].sha256, before[name].rows[0][lob].sha256);
      }
    }
    report.cases.push({ id: "operator-walkthrough-" + name, ok: true, status: 200, input });
  }
  await outcome("persistent-success", "Workloads/Write/Fixture/persistent.p", 200, undefined, {
    persistent: true
  });
  await outcome("write-then-error", "Workloads/Write/Fixture/error.p", 500, "workload_failed");
  const stopStarted = Date.now();
  await outcome(
    "real-60-second-StopAfter",
    "Workloads/Write/Fixture/stop-after.p",
    408,
    "workload_timeout"
  );
  assert.ok(Date.now() - stopStarted >= 59000, "unmodified real STOP-AFTER elapsed duration");
  const readonly = fixture.snapshotAll();
  const schema = await fixture.request("Account", { mode: "validate" });
  assert.equal(schema.status, 200);
  assert.deepEqual(fixture.snapshotAll(), readonly);
  report.cases.push({ id: "schema-readiness", ok: true, status: 200 });
  const incompatible = await fixture.requestProcedure("Workloads/Write/Fixture/schema-failure.p", {
    mode: "validate"
  });
  assert.equal(incompatible.status, 500);
  assert.equal(incompatible.body.error, "database_schema_invalid");
  assert.deepEqual(fixture.snapshotAll(), readonly);
  report.cases.push({
    id: "incompatible-read-only-schema-probe",
    ok: true,
    status: 500,
    error: incompatible.body.error
  });
  const invalid = await fixture.request("Employee", {
    Operation: "update",
    Limit: 1,
    WhereClause: "TRUE",
    FieldsList: ["EmployeeId"]
  });
  assert.equal(invalid.status, 500);
  assert.equal(invalid.body.error, "workload_failed");
  assert.deepEqual(fixture.snapshotAll(), readonly);
  report.cases.push({ id: "native-validation-mapping", ok: true, status: 500 });
  const key = { name: "id", value: 1, sequence: 1 };
  for (const op of ["reference-point", "selective", "range", "audit-write-cycle"]) {
    const before = fixture.snapshotAll();
    const response = await fixture.requestProcedure("Workloads/ParkBench/bank_mix.p", {
      mode: "run",
      op,
      key
    });
    assert.equal(response.status, 200, op + ":" + JSON.stringify(response.body));
    const after = fixture.snapshotAll();
    for (const name of Object.keys(before)) assert.deepEqual(after[name].rows, before[name].rows);
    report.cases.push({ id: "existing-bank-mix-" + op, ok: true, status: 200 });
  }
  const beforeGenericRead = fixture.snapshotAll();
  const read = await fixture.requestProcedure("Workloads/Generic/arbitrary_reads.p", {
    mode: "run",
    TableName: "CustomerNote",
    WhereClause: "CustomerNoteId = 1",
    Limit: 1,
    FieldsList: ["Summary"],
    LobFields: ["NoteText"]
  });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(fixture.snapshotAll(), beforeGenericRead);
  await outcome("existing-read-fixture", "Workloads/Fixture/success.p", 200);
  report.cases.push({ id: "existing-generic-read", ok: true, status: 200 });
  fixture.stopPas();
  // Substitute only the test copy's post-RUN deadline threshold. Workload code
  // has no timer reset or failure input, and the transaction remains real.
  fixture.handlerTransform = (source) =>
    source.replace("IF ETIME >= 60000 THEN DO:", "IF ETIME >= 0 THEN DO:");
  report.explicitVerdictHandlerHash = hash(fixture.handlerTransform(originalHandler));
  await fixture.startPas();
  await outcome(
    "explicit-post-RUN-deadline-verdict",
    "Workloads/Write/Fixture/deadline.p",
    408,
    "workload_timeout"
  );
  fixture.stopPas();
  // Delay response preparation after a genuine successful commit; advance the
  // test-only observed clock so no postcommit timeout can be hidden by speed.
  fixture.handlerTransform = (source) =>
    source.replace(
      "elapsedMs = MAXIMUM(0, ETIME).",
      'elapsedMs = MAXIMUM(0, ETIME).\n            IF procName = "Workloads/Write/Fixture/delayed.p" THEN DO:\n                PAUSE 1 NO-MESSAGE.\n                elapsedMs = 60001.\n            END.'
    );
  report.delayedResponseHandlerHash = hash(fixture.handlerTransform(originalHandler));
  await fixture.startPas();
  await outcome("committed-delayed-response", "Workloads/Write/Fixture/delayed.p", 200, undefined, {
    persistent: true,
    elapsed: true
  });
  return report.cases;
}
