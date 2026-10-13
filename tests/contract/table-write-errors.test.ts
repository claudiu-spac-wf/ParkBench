import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv/dist/2020";
import { writeModule } from "../helpers/table-write";
const validate = new Ajv({ strict: false }).compile(
  JSON.parse(
    fs.readFileSync("packages/contracts/src/schemas/table-write-input-v1.schema.json", "utf8")
  )
);
describe("table-write invalid input and error mapping", () => {
  it("rejects malformed/nonobject JSON and invalid operational shapes", async () => {
    const load = Function("name", "return import(name)");
    const { invalidInputs } = await load(
      pathToFileURL(path.resolve("tests/fixtures/table-write-workloads/invalid-inputs.mjs")).href
    );
    for (const [id, text] of invalidInputs) {
      let input;
      try {
        input = JSON.parse(text);
      } catch {
        assert.equal(id, "malformed");
        continue;
      }
      const nativeSemantic =
        /^(?:primary|foreign-|qualified-|lob-in-|ordinary-in-)/.test(id) ||
        (id.startsWith("WhereClause-") &&
          typeof input?.WhereClause === "string" &&
          input.WhereClause.trim());
      if (!nativeSemantic) assert.equal(validate(input), false, id);
    }
  });
  it("maps failures through the existing HTTP schema and permits ignored create-only extras", async () => {
    const { validateWriteScenario } = await writeModule("validate-write-workloads");
    const reviewed = JSON.parse(
      fs.readFileSync("tests/fixtures/table-write-workloads/scenario.example.json", "utf8")
    );
    const input = reviewed.workload.operations[0].bodyTemplate.input;
    input.FieldsList = null;
    input.WhereClause = { ignored: true };
    assert.doesNotThrow(() => validateWriteScenario(reviewed));
    assert.equal(validate({ Operation: "create", Limit: 0 }), true);
    assert.equal(
      validate({ Operation: "update", Limit: 1, WhereClause: "FALSE", FieldsList: ["JobTitle"] }),
      true
    );
    const handler = fs.readFileSync("openedge/runner/ParkBenchWorkHandler.cls", "utf8");
    for (const code of ["workload_failed", "database_schema_invalid", "workload_timeout"])
      assert.ok(handler.includes(code));
  });
});
