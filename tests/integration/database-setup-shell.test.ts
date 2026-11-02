import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeSetupHarness } from "../fixtures/database-setup/native-harness";
import { compileDatabaseSetup } from "../../apps/control-plane/src/database-setup/compile-plan";
import { validateDatabaseSetup } from "../../packages/contracts/src/database-setup";

const helpers = path.resolve("docker/openedge-db/setup");
test("offline batches run every setting in order and stop after the first native failure", () => {
  const h = nativeSetupHarness();
  try {
    const plan = compileDatabaseSetup({
      runId: "run-1",
      attemptId: "attempt-1",
      setup: validateDatabaseSetup({
        contractVersion: "database-setup.v1",
        steps: [
          {
            id: "compact",
            definitionId: "idxcompact",
            optionSets: [
              { id: "a", index: "PUB.Customer.CustNum" },
              { id: "b", index: "PUB.Customer.CustNum", mode: "unusedblocks" }
            ]
          }
        ]
      }),
      runtimeDirectory: h.root,
      databaseName: "testdb",
      image: "fixture:1"
    });
    const env = {
      ...h.env,
      PARKBENCH_SETUP_INPUT: plan.manifest.paths.input,
      PARKBENCH_SETUP_OUTPUT: plan.manifest.paths.output,
      PARKBENCH_SETUP_CONTROL: plan.manifest.paths.control,
      PARKBENCH_SETUP_HELPERS: helpers,
      DB_NAME: "testdb",
      PARKBENCH_RUN_ID: "run-1",
      PARKBENCH_SETUP_ATTEMPT_ID: "attempt-1",
      PARKBENCH_SETUP_NO_RELEASE_WAIT: "fixture"
    };
    const result = spawnSync("sh", [path.join(helpers, "run-setup.sh"), "execute"], {
      env,
      cwd: h.database,
      encoding: "utf8",
      timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    const events = h.events().filter((e) => e.command === "proutil");
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].args, [
      "testdb",
      "-C",
      "idxcompact",
      "PUB.Customer.CustNum",
      "-cpinternal",
      "UTF-8"
    ]);
    assert(events[1].args.includes("unusedblocks"));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(plan.manifest.paths.output, "status.json"), "utf8"))
        .state,
      "SUCCEEDED"
    );
    h.write("failure", 7);
    const failed = spawnSync("sh", [path.join(helpers, "run-setup.sh"), "execute"], {
      env,
      cwd: h.database,
      encoding: "utf8",
      timeout: 15000
    });
    assert.equal(failed.status, 7, failed.stderr);
    assert.equal(h.events().filter((e) => e.command === "proutil").length, 3);
  } finally {
    h.close();
  }
});
test("replay fence refuses the same attempt before preparation changes", () => {
  const h = nativeSetupHarness();
  try {
    const env = {
      ...h.env,
      PARKBENCH_SETUP_INPUT: h.root,
      PARKBENCH_SETUP_OUTPUT: h.output,
      PARKBENCH_SETUP_CONTROL: h.control,
      PARKBENCH_SETUP_HELPERS: helpers,
      PARKBENCH_RUN_ID: "r",
      PARKBENCH_SETUP_ATTEMPT_ID: "a"
    };
    fs.writeFileSync(
      path.join(h.root, "identity.sh"),
      "setup_run_id='r'\nsetup_attempt_id='a'\nsetup_step_count=0\n"
    );
    const first = spawnSync("sh", [path.join(helpers, "run-setup.sh"), "claim"], {
      env,
      encoding: "utf8"
    });
    assert.equal(first.status, 0, first.stderr);
    const replay = spawnSync("sh", [path.join(helpers, "run-setup.sh"), "claim"], {
      env,
      encoding: "utf8"
    });
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /database_setup_replay_refused/);
    assert.equal(h.events().length, 0);
  } finally {
    h.close();
  }
});

test("TABLEREORG shares one temporary broker across sets, repeats cycles and confirms delayed shutdown", () => {
  const h = nativeSetupHarness();
  try {
    h.write("shutdown-delay", 120);
    const setup = validateDatabaseSetup({
      contractVersion: "database-setup.v1",
      steps: ["first", "second"].map((id) => ({
        id,
        definitionId: "tablereorg",
        optionSets: [
          { id: "a", table: "PUB.Customer", useIndex: "CustNum" },
          { id: "b", table: "PUB.Order", useIndex: "OrderNum" }
        ]
      }))
    });
    const plan = compileDatabaseSetup({
      runId: "r",
      attemptId: "a",
      setup,
      runtimeDirectory: h.root,
      databaseName: "testdb",
      image: "fixture:1"
    });
    const env = {
      ...h.env,
      PARKBENCH_SETUP_INPUT: plan.manifest.paths.input,
      PARKBENCH_SETUP_OUTPUT: plan.manifest.paths.output,
      PARKBENCH_SETUP_CONTROL: plan.manifest.paths.control,
      PARKBENCH_SETUP_HELPERS: helpers,
      DB_NAME: "testdb",
      PARKBENCH_RUN_ID: "r",
      PARKBENCH_SETUP_ATTEMPT_ID: "a"
    };
    const result = spawnSync("sh", [path.join(helpers, "run-setup.sh"), "execute"], {
      env,
      cwd: h.database,
      encoding: "utf8",
      timeout: 25000
    });
    assert.equal(result.status, 0, result.stderr);
    const events = h.events();
    assert.equal(events.filter((e) => e.command === "proserve").length, 2);
    assert.equal(events.filter((e) => e.command === "proshut").length, 2);
    const utility = events.filter((e) => e.command === "proutil" && e.args.includes("tablereorg"));
    assert.equal(utility.length, 4);
    assert.equal(fs.readFileSync(path.join(h.control, "busy"), "utf8"), "0");
    assert(fs.existsSync(path.join(plan.manifest.paths.output, "steps/0002/shutdown.confirmed")));
  } finally {
    h.close();
  }
});
test("failure in set two preserves its native exit and never executes set three", () => {
  const h = nativeSetupHarness();
  try {
    h.write("fail-at", 2);
    const setup = validateDatabaseSetup({
      contractVersion: "database-setup.v1",
      steps: [
        {
          id: "build",
          definitionId: "idxbuild",
          optionSets: ["first", "second", "third"].map((id) => ({ id, scope: "all" }))
        }
      ]
    });
    const plan = compileDatabaseSetup({
      runId: "r",
      attemptId: "a",
      setup,
      runtimeDirectory: h.root,
      databaseName: "testdb",
      image: "fixture:1"
    });
    const env = {
      ...h.env,
      PARKBENCH_SETUP_INPUT: plan.manifest.paths.input,
      PARKBENCH_SETUP_OUTPUT: plan.manifest.paths.output,
      PARKBENCH_SETUP_CONTROL: plan.manifest.paths.control,
      PARKBENCH_SETUP_HELPERS: helpers,
      DB_NAME: "testdb",
      PARKBENCH_RUN_ID: "r",
      PARKBENCH_SETUP_ATTEMPT_ID: "a"
    };
    const result = spawnSync("sh", [path.join(helpers, "run-setup.sh"), "execute"], {
      env,
      cwd: h.database,
      encoding: "utf8",
      timeout: 15000
    });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(h.events().filter((e) => e.command === "proutil").length, 2);
    assert(!fs.existsSync(path.join(plan.manifest.paths.output, "steps/0001/0003.json")));
  } finally {
    h.close();
  }
});
