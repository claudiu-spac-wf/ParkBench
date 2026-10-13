import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parameterPlan } from "../../packages/compose-runner/src/parameters";

describe("parameter plan database name", () => {
  it("uses the selected seed's database name for the database and the PAS connection", () => {
    const plan = parameterPlan({}, { databaseName: "parkbench" });
    assert.equal(plan.databaseEnvironment.DB_NAME, "parkbench");
    assert.equal(
      plan.pasEnvironment.PARKBENCH_PAS_DB_CONNECTION,
      "-db parkbench -H database -S 20931"
    );
    assert.doesNotMatch(JSON.stringify(plan), /sports/i);
    assert.equal(
      parameterPlan({}, { databaseName: "tenant_db" }).databaseEnvironment.DB_NAME,
      "tenant_db"
    );
  });

  it("defaults to parkbench and rejects unsafe names", () => {
    assert.equal(parameterPlan({}).databaseEnvironment.DB_NAME, "parkbench");
    assert.throws(
      () => parameterPlan({}, { databaseName: "bad name; rm" }),
      /database_name_invalid/
    );
  });
});
