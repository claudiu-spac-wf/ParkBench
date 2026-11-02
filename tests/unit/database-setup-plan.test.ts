import assert from "node:assert/strict";
import test from "node:test";
import { builtinSetup } from "../fixtures/database-setup/fixtures";
import { validateDatabaseSetup } from "../../packages/contracts/src/database-setup";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("attempt plan freezes reviewed settings and generates ordered literal utility arguments", async () => {
  const modulePath = "../../apps/control-plane/src/database-setup/compile-plan";
  let compile: any;
  try {
    compile = require(modulePath).compileDatabaseSetup;
  } catch {
    compile = () => ({ manifest: { sequence: undefined }, files: {} });
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-plan-"));
  try {
    const setup = validateDatabaseSetup(builtinSetup);
    const plan = await compile({
      runId: "run-1",
      attemptId: "attempt-1",
      setup,
      runtimeDirectory: root,
      databaseName: "testdb",
      image: "test/db:1"
    });
    assert.deepEqual(plan.manifest.sequence, setup);
    assert.equal(plan.manifest.databaseDirectory, "/psc/wrk/testdb");
    const input = plan.manifest.paths.input;
    assert.match(
      fs.readFileSync(path.join(input, "steps/0001/0001/argv.sh"), "utf8"),
      /'testdb' '-C' 'tablereorg' 'PUB.Customer' 'useindex' 'CustNum'/
    );
    assert.match(
      fs.readFileSync(path.join(input, "steps/0002/0001/argv.sh"), "utf8"),
      /'-C' 'idxbuild'/
    );
    setup.steps.reverse();
    assert.notDeepEqual(plan.manifest.sequence, setup);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
