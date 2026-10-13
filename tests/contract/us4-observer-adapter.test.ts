import { describe, it } from "node:test";
import assert from "node:assert";
import { assertObserverKind, validateBuiltinObserverDeclaration, validateOpenEdgeDatabaseCommand } from "../../packages/observers/src";
import { validateScenario } from "../../packages/contracts/src/validator";
import fs from "node:fs";
import path from "node:path";
describe("observer adapter contract", () => {
  it("accepts a v2 observer without a metric selector and rejects an authored v2 selector", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/simplify-run-workflow/scenarios/scenario-v2.json"), "utf8"));
    assert.doesNotThrow(() => validateScenario(fixture));
    fixture.observers[0].metrics = ["parkbench_old_metric"];
    assert.throws(() => validateScenario(fixture));
    fixture.schemaVersion = "scenario.v1";
    assert.doesNotThrow(() => validateScenario(fixture));
  });
  it("accepts versioned observer kinds", () => {
    assert.doesNotThrow(() => assertObserverKind("openedge_db_v1"));
    assert.throws(() => assertObserverKind("unknown"));
  });

  it("accepts the packaged compiled observer procedure and rejects other names", () => {
    const declaration: any = {
      id: "openedge-db",
      kind: "openedge_db_v1",
      metrics: ["_DbStatus"],
      samplingIntervalSeconds: 1,
      configuration: {
        observerExecutable: "parkbench-openedge-db-observer",
        observerProcedure: "/app/openedge/observers/db/parkbench-db-observer.r"
      }
    };
    assert.doesNotThrow(() => validateBuiltinObserverDeclaration(declaration));
    declaration.configuration.observerProcedure = "/app/openedge/observers/db/unapproved.r";
    assert.throws(
      () => validateBuiltinObserverDeclaration(declaration),
      /observer_procedure_not_approved:openedge-db/
    );
  });
  it("requires the OpenEdge database observer to remain read-only", () => {
    assert.throws(
      () =>
        validateOpenEdgeDatabaseCommand({
          executable: "parkbench-openedge-db-observer",
          procedure: "/app/openedge/observers/db/parkbench-db-observer.p",
          readOnly: false
        }),
      /openedge_db_observer_read_only_required/
    );
  });
});

it("readable native approval remains finite and uses existing command budgets", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "packages/observers/src/openedge-db/adapter.ts"), "utf8");
  assert.ok(source.includes("prepare-run-db-observer"));
  assert.match(source, /10_?000|10000/);
  assert.match(source, /5_?000|5000/);
});
