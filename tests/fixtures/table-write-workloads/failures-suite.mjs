import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { invalidInputs, validNoops } from "./invalid-inputs.mjs";
import { fixtureData } from "./fixture-data.mjs";
import { assertNoop, readWitness } from "./assertions.mjs";

const rowsEqual = (before, after) => {
  assert.deepEqual(Object.keys(before).sort(), Object.keys(after).sort());
  for (const name of Object.keys(before))
    assert.deepEqual(after[name].rows, before[name].rows, name + ":rolled back records/LOBs");
};
export async function run({ fixture, options, inventory, report }) {
  fixture.compileDrivers(["prepare", "verify", "verify-failure", "hold-lock"]);
  fixture.prepareEmpty({ count: 100 });
  fixture.enableWitness(inventory.tables.map((t) => t.name));
  const recordCase = (entry) => {
    report.cases.push(entry);
    console.log("write_failure_case:" + entry.id);
  };
  for (const [id, text] of invalidInputs) {
    if (options.case && options.case !== id) continue;
    const before = fixture.snapshotAll();
    fixture.resetWitness();
    const result = fixture.invokeFailure("Employee", text);
    const after = fixture.snapshotAll();
    assert.equal(result.ok, false, id);
    assert.ok(result.error, id + ":visible diagnostic");
    assertNoop(before, after, readWitness(fs.readFileSync(fixture.witnessPath, "utf8")));
    recordCase({ id, ok: true, outcome: "invalid-input", diagnostic: result.error });
  }
  for (const [id, input] of validNoops) {
    if (options.case && options.case !== id) continue;
    const before = fixture.snapshotAll();
    fixture.resetWitness();
    const result = fixture.invokeFailure("Employee", JSON.stringify(input));
    assert.equal(result.ok, true, id + ":" + result.error);
    assertNoop(
      before,
      fixture.snapshotAll(),
      readWitness(fs.readFileSync(fixture.witnessPath, "utf8"))
    );
    recordCase({ id, ok: true, outcome: "validated-noop" });
  }
  // Stage hooks only in the disposable compiled copy; production source and
  // public workload inputs have no failure-injection mechanism.
  async function patched(id, file, transform, input, diagnostic, { stop = false } = {}) {
    if (options.case && options.case !== id) return;
    const filename = path.join(fixture.root, "Workloads/Write", file);
    const source = fs.readFileSync(filename, "utf8");
    const patchedSource = transform(source);
    assert.notEqual(patchedSource, source, id + ":hook inserted");
    try {
      fs.writeFileSync(filename, patchedSource);
      fixture.compile(["Employee"]);
      const before = fixture.snapshotAll();
      fixture.resetWitness();
      const result = fixture.invokeFailure("Employee", JSON.stringify(input));
      const after = fixture.snapshotAll();
      assert.equal(result.ok, false, id);
      if (stop) assert.equal(result.stop, true);
      else assert.match(result.error, diagnostic, id);
      const trace = readWitness(fs.readFileSync(fixture.witnessPath, "utf8"));
      assert.ok(
        trace.some(
          (w) =>
            w.kind === "ordinary" &&
            w.id === String(input.Operation === "create" ? before.Employee.sequence + 1 : 1)
        ),
        id + ":earlier ordinary write"
      );
      assert.ok(
        trace.some((w) => w.kind === "lob" && w.field === "Photo"),
        id + ":earlier real LOB write"
      );
      rowsEqual(before, after);
      recordCase({
        id,
        ok: true,
        outcome: "rollback-after-ordinary-and-lob",
        diagnostic: result.error,
        stop: Boolean(result.stop),
        witnessedAssignments: trace.length
      });
    } finally {
      fs.writeFileSync(filename, source);
      fixture.compile(["Employee"]);
    }
  }
  const create = { Operation: "create", Limit: 2, LobFields: ["Photo"] };
  const update = {
    Operation: "update",
    Limit: 2,
    WhereClause: "EmployeeId <= 2",
    FieldsList: ["JobTitle"],
    LobFields: ["Photo"]
  };
  await patched(
    "later-create-error",
    "write-create.i",
    (s) =>
      s.replace(
        "  pbTarget:BUFFER-RELEASE().",
        '  IF pbRowNumber = 2 THEN UNDO, THROW NEW Progress.Lang.AppError("write_fixture_later_error", 0).\n  pbTarget:BUFFER-RELEASE().'
      ),
    create,
    /write_fixture_later_error/
  );
  await patched(
    "later-update-error",
    "write-update.i",
    (s) =>
      s.replace(
        "  ASSIGN pbResult = pbTarget:BUFFER-VALIDATE()",
        '  IF pbSelected.ordinal = 2 THEN UNDO, THROW NEW Progress.Lang.AppError("write_fixture_later_error", 0).\n  ASSIGN pbResult = pbTarget:BUFFER-VALIDATE()'
      ),
    update,
    /write_fixture_later_error/
  );
  await patched(
    "later-create-stop",
    "write-create.i",
    (s) =>
      s.replace(
        "  pbTarget:BUFFER-RELEASE().",
        "  IF pbRowNumber = 2 THEN STOP.\n  pbTarget:BUFFER-RELEASE()."
      ),
    create,
    /stop/,
    { stop: true }
  );
  const duplicate = fixture.snapshot("Employee").rows[0].EmployeeNumber;
  await patched(
    "later-native-unique-constraint",
    "write-create.i",
    (s) =>
      s.replace(
        "  pbTarget:BUFFER-RELEASE().",
        '  IF pbRowNumber = 2 THEN pbTarget:BUFFER-FIELD("EmployeeNumber"):BUFFER-VALUE = "' +
          duplicate +
          '".\n  pbTarget:BUFFER-RELEASE().'
      ),
    create,
    /unique|duplicate|already|132|constraint/i
  );
  await patched(
    "later-native-lob-error",
    "write-create.i",
    (s) =>
      s.replace(
        "  pbTarget:BUFFER-RELEASE().",
        '  IF pbRowNumber = 2 THEN COPY-LOB FROM FILE "/validation/never-created-payload" TO pbTarget:BUFFER-FIELD("Photo"):BUFFER-VALUE.\n  pbTarget:BUFFER-RELEASE().'
      ),
    create,
    /file|open|find|exist/i
  );
  for (const [id, alteration] of [
    [
      "frozen-identity-replaced",
      "pbTarget:BUFFER-FIELD(pbPrimary):BUFFER-VALUE = pbSelected.primaryId + 1000000."
    ],
    ["frozen-identity-missing", "pbTarget:BUFFER-DELETE()."]
  ])
    await patched(
      id,
      "write-update.i",
      (s) =>
        s.replace(
          "FOR EACH pbSelected BY pbSelected.ordinal:",
          `FOR EACH pbSelected BY pbSelected.ordinal:
  IF pbSelected.ordinal = 2 THEN DO:
    pbTarget:FIND-BY-ROWID(pbSelected.recordRowid, EXCLUSIVE-LOCK, NO-WAIT).
    ${alteration}
    pbTarget:BUFFER-RELEASE().
  END.`
        ),
      update,
      /table_write_conflict:frozen/
    );

  if (!options.case || options.case === "selected-lock-conflict") {
    const before = fixture.snapshotAll();
    fixture.resetWitness();
    const ready = path.join(fixture.root, "lock-ready.json");
    const release = path.join(fixture.root, "lock-release");
    fs.rmSync(ready, { force: true });
    fs.rmSync(release, { force: true });
    fixture.docker([
      "exec",
      "-d",
      "--user",
      "pscadmin",
      "-e",
      "PARKBENCH_WRITE_FIXTURE=1",
      "-e",
      "PROPATH=/psc/dlc/tty,/psc/dlc/tty/OpenEdge.Core.apl",
      fixture.name,
      "/psc/dlc/bin/pro",
      "-T",
      "/psc/wrk",
      "-db",
      fixture.database,
      "-H",
      "127.0.0.1",
      "-S",
      fixture.port,
      "-b",
      "-p",
      "/feature/tests/fixtures/table-write-workloads/abl/hold-lock.p",
      "-param",
      JSON.stringify({
        table: "Employee",
        where: "EmployeeId = 1",
        ready: "/validation/lock-ready.json",
        release: "/validation/lock-release"
      })
    ]);
    try {
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      assert.ok(fs.existsSync(ready), "native lock held before request");
      const result = fixture.invokeFailure("Employee", JSON.stringify(update));
      assert.equal(result.ok, false);
      assert.match(result.error, /table_write_conflict:selected_lock/);
      rowsEqual(before, fixture.snapshotAll());
      assert.deepEqual(readWitness(fs.readFileSync(fixture.witnessPath, "utf8")), []);
      recordCase({
        id: "selected-lock-conflict",
        ok: true,
        outcome: "native-no-wait-conflict",
        diagnostic: result.error
      });
    } finally {
      fs.writeFileSync(release, "release");
    }
  }
  if (!options.case || options.case === "missing-required-parent") {
    fixture.prepareEmpty({ variant: "empty" });
    const before = fixture.snapshotAll();
    const result = fixture.invokeFailure("Employee", JSON.stringify(create));
    assert.equal(result.ok, false);
    assert.match(result.error, /table_write_missing_parent:Branch/);
    rowsEqual(before, fixture.snapshotAll());
    recordCase({ id: "missing-required-parent", ok: true, diagnostic: result.error });
  }
  if (!options.case || options.case.startsWith("exhausted-")) {
    fixture.prepareEmpty({ variant: "exhaustion", count: 100 });
    for (const table of [
      "Currency",
      "Country",
      "AccountType",
      "TransactionType",
      "MerchantCategory",
      "StatementDocument",
      "Transfer"
    ]) {
      const id = "exhausted-" + table;
      if (options.case && options.case !== id) continue;
      const before = fixture.snapshotAll();
      const result = fixture.invokeFailure(
        table,
        JSON.stringify({
          Operation: "create",
          Limit: 1,
          LobFields: table === "StatementDocument" ? ["PdfContent", "StatementXml"] : []
        })
      );
      assert.equal(result.ok, false, id);
      assert.match(result.error, /table_write_exhausted/);
      rowsEqual(before, fixture.snapshotAll());
      recordCase({ id, ok: true, diagnostic: result.error });
    }
  }
  // Small independent fixtures make complete finite composite exhaustion cheap
  // to prove; every retained parent/key comes from independently authored data.
  if (!options.case || options.case === "exhausted-composite") {
    fixture.prepareEmpty({ variant: "empty" });
    const data = fixtureData({ count: 100 });
    data.variant = "exhaustion";
    const needed = new Set([
      "Currency",
      "Country",
      "AccountType",
      "Branch",
      "Customer",
      "Account",
      "AccountHolder"
    ]);
    data.tables = data.tables
      .filter((t) => needed.has(t.name))
      .map((t) => ({ ...t, rows: t.rows.slice(0, 1) }));
    fs.writeFileSync(path.join(fixture.root, "composite-data.json"), JSON.stringify(data));
    fixture.invoke(
      "/feature/tests/fixtures/table-write-workloads/abl/prepare.p",
      {
        command: "populate",
        data: "/validation/composite-data.json",
        report: "/validation/composite-prepared.json"
      },
      "composite-prepared.json"
    );
    const before = fixture.snapshotAll();
    const result = fixture.invokeFailure(
      "AccountHolder",
      JSON.stringify({ Operation: "create", Limit: 1 })
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /table_write_exhausted:unique_tuple/);
    rowsEqual(before, fixture.snapshotAll());
    recordCase({ id: "exhausted-composite", ok: true, diagnostic: result.error });
  }
  if (!report.cases.length) throw new Error("write_native_no_cases_selected");
  return report.cases;
}
