import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { compileDatabaseSetup } from "../../apps/control-plane/src/database-setup/compile-plan";
test("custom staging preserves source mode and exact empty, whitespace, quoted and multiline suffixes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-custom-stage-"));
  try {
    const scripts = path.join(root, "source");
    fs.mkdirSync(path.join(scripts, "with spaces"), { recursive: true });
    const script = path.join(scripts, "with spaces", "prepare.sh");
    fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@"\n', { mode: 0o644 });
    const inputs = [
      "",
      "   ",
      '"customer group" --mode=fast',
      "one\ntwo\n\n",
      "x | cat; true",
      "\0"
    ];
    const setup: any = {
      contractVersion: "database-setup.v1",
      steps: [
        {
          id: "custom",
          definitionId: "custom",
          scriptRef: "input:scripts/with spaces/prepare.sh",
          optionSets: inputs.map((input, i) => ({ id: `s-${i}`, input }))
        }
      ]
    };
    const plan = compileDatabaseSetup({
      runId: "r",
      attemptId: "a",
      setup,
      runtimeDirectory: root,
      databaseName: "testdb",
      image: "fixture:1",
      scriptsRoot: scripts
    } as any);
    assert.deepEqual(plan.manifest.sequence, setup);
    assert.equal(plan.manifest.scripts.length, 1);
    assert.equal(fs.statSync(script).mode & 0o777, 0o644);
    assert.equal(fs.statSync(plan.manifest.scripts[0].stagedPath).mode & 0o777, 0o755);
    for (let i = 0; i < inputs.length; i++)
      assert(
        fs
          .readFileSync(
            path.join(
              plan.manifest.paths.input,
              `steps/0001/${String(i + 1).padStart(4, "0")}/command.sh`
            ),
            "utf8"
          )
          .endsWith(" " + inputs[i])
      );
    fs.rmSync(script);
    assert.deepEqual(plan.manifest.sequence, setup);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readDatabaseSetupEvidence } from "../../packages/compose-runner/src/database-setup-evidence";
function executableFixture(body: string, inputs: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-custom-runtime-")),
    helpers = path.join(root, "helpers"),
    database = path.join(root, "database"),
    scripts = path.join(root, "source");
  fs.mkdirSync(helpers);
  fs.mkdirSync(database);
  fs.mkdirSync(scripts);
  for (const file of fs.readdirSync(path.resolve("docker/openedge-db/setup")))
    if (file.endsWith(".sh") || file.endsWith(".p"))
      fs.copyFileSync(path.resolve("docker/openedge-db/setup", file), path.join(helpers, file));
  for (const file of fs.readdirSync(helpers)) fs.chmodSync(path.join(helpers, file), 0o755);
  execFileSync("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    path.resolve("docker/openedge-db/setup/custom-supervisor.c"),
    "-o",
    path.join(helpers, "custom-supervisor")
  ]);
  fs.writeFileSync(path.join(scripts, "prepare.sh"), "#!/bin/sh\n" + body, { mode: 0o644 });
  const input = path.join(root, "database-setup/a/input");
  const plan = compileDatabaseSetup({
    runId: "r",
    attemptId: "a",
    setup: {
      contractVersion: "database-setup.v1",
      steps: [
        {
          id: "c",
          definitionId: "custom",
          scriptRef: "input:scripts/prepare.sh",
          optionSets: inputs.map((input, i) => ({ id: `o-${i}`, input }))
        }
      ]
    },
    runtimeDirectory: root,
    databaseName: "testdb",
    image: "fixture:1",
    scriptsRoot: scripts,
    containerInputRoot: input,
    containerHelpersPath: helpers
  });
  const env = {
    ...process.env,
    PARKBENCH_SETUP_HELPERS: helpers,
    PARKBENCH_SETUP_INPUT: plan.manifest.paths.input,
    PARKBENCH_SETUP_OUTPUT: plan.manifest.paths.output,
    PARKBENCH_SETUP_CONTROL: plan.manifest.paths.control,
    PARKBENCH_RUN_ID: "r",
    PARKBENCH_SETUP_ATTEMPT_ID: "a",
    DB_NAME: "testdb"
  };
  return {
    root,
    helpers,
    database,
    plan,
    env,
    close: () => fs.rmSync(root, { recursive: true, force: true })
  };
}
test("real custom dispatcher invokes empty and quoted sets in DB CWD, retaining primary failure masked by true", () => {
  const f = executableFixture(
    'printf "cwd=%s\\n" "$PWD"\nprintf "<%s>\\n" "$@"\ncase "${1:-}" in fail) exit 7;; esac\n',
    ["", '"customer group" --mode=fast', "fail; true", "never"]
  );
  try {
    const result = spawnSync("sh", [path.join(f.helpers, "run-setup.sh"), "execute"], {
      env: f.env,
      cwd: f.database,
      encoding: "utf8",
      timeout: 15000
    });
    assert.equal(result.status, 7, result.stderr);
    const evidence = readDatabaseSetupEvidence(f.plan.manifest);
    assert.equal(evidence.state, "FAILED");
    const sets = evidence.steps[0].optionSets;
    assert.equal(sets[0].state, "SUCCEEDED");
    assert.equal(sets[1].state, "SUCCEEDED");
    assert.equal(sets[2].primaryExitStatus, 7);
    assert.equal(sets[2].shellExitStatus, 0);
    assert.equal(sets[2].processScopeState, "QUIESCENT");
    assert.equal(sets[3].state, "NOT_EXECUTED");
    const output = fs.readFileSync(
      path.join(f.plan.manifest.paths.output, "steps/0001/0002.stdout"),
      "utf8"
    );
    assert(output.includes(`cwd=${f.database}`));
    assert(output.includes("<customer group>"));
  } finally {
    f.close();
  }
});
test("custom wait blocks later settings after parent zero and cancellation reaps detached work", async () => {
  const f = executableFixture(
    "setsid sh -c 'touch child-started; while [ ! -f child-release ]; do sleep .05; done; touch child-finished' </dev/null >/dev/null 2>&1 &\nexit 0\n",
    ["", "never"]
  );
  const child = spawn("sh", [path.join(f.helpers, "run-setup.sh"), "execute"], {
    env: f.env,
    cwd: f.database,
    stdio: "ignore"
  });
  try {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const status = path.join(f.plan.manifest.paths.output, "status.json");
      if (
        fs.existsSync(status) &&
        JSON.parse(fs.readFileSync(status, "utf8")).phase === "waiting-processes"
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const waiting = readDatabaseSetupEvidence(f.plan.manifest);
    assert.equal(waiting.phase, "waiting-processes");
    assert.equal(waiting.state, "RUNNING");
    assert.equal(waiting.steps[0].optionSets[0].primaryExitStatus, 0);
    assert.equal(waiting.steps[0].optionSets[0].processScopeState, "ACTIVE");
    assert(!fs.existsSync(path.join(f.plan.manifest.paths.output, "steps/0001/0002.json")));
    fs.writeFileSync(path.join(f.plan.manifest.paths.control, "cancel"), "cancel");
    const exit = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exit, 72);
    const cancelled = readDatabaseSetupEvidence(f.plan.manifest);
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.steps[0].optionSets[0].processScopeState, "QUIESCENT");
    assert(!fs.existsSync(path.join(f.database, "child-finished")));
  } finally {
    child.kill("SIGTERM");
    f.close();
  }
});

import { createControlUiFixture } from "../fixtures/control-ui";
import { ScenarioFileSource } from "../../apps/control-plane/src/catalog/scenario-source";
test("custom preview freezes references and raw options, accepts source edits and retains unavailable history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-custom-api-"));
  fs.writeFileSync(path.join(root, "prepare.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const fixture = await createControlUiFixture({ discoveryRoots: { scripts: root } });
  try {
    const discovery = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/database-setup/scripts"
    });
    assert.equal(discovery.statusCode, 200);
    assert.equal(discovery.json().items[0].scriptRef, "input:scripts/prepare.sh");
    const source = new ScenarioFileSource(
      fixture.platform.config.discoveryRoots?.scenarios
    ).list()[0];
    const raw = ' "customer group"\n\n';
    const setup: any = {
      contractVersion: "database-setup.v1",
      steps: [
        {
          id: "c",
          definitionId: "custom",
          scriptRef: "input:scripts/prepare.sh",
          optionSets: [
            { id: "one", input: raw },
            { id: "empty", input: "" }
          ]
        }
      ]
    };
    const preview = fixture.platform.controlUi.preview({
      contractVersion: "experiment-schedule.v2",
      runName: "custom-api",
      scenarioSourceId: source.id,
      dimensions: [],
      repetitions: 1,
      inputs: { seed: "input:seed", applicationArchive: "input:archive" },
      databaseSetup: setup
    });
    fs.writeFileSync(path.join(root, "prepare.sh"), "#!/bin/sh\nprintf changed\n", { mode: 0o644 });
    const plan = compileDatabaseSetup({
      runId: "changed",
      attemptId: "one",
      setup,
      runtimeDirectory: path.join(root, "capture"),
      databaseName: "testdb",
      image: "fixture:1",
      scriptsRoot: root
    });
    assert(fs.readFileSync(plan.manifest.scripts[0].stagedPath, "utf8").includes("changed"));
    const result = fixture.platform.controlUi.submit({
      previewId: preview.previewId,
      confirm: true
    });
    const run = fixture.platform.repositories.getRun(result.runs[0].id)!;
    fs.rmSync(path.join(root, "prepare.sh"));
    const failed = await fixture.platform.coordinator.executeRun(run);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.failureCode, "database_setup_script_unavailable");
    fs.rmSync(path.join(root, "capture"), { recursive: true, force: true });
    const history = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/runs/${run.id}/database-setup`
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().state, "FAILED");
    assert.equal(history.json().activeStepId, "c");
    assert.deepEqual(history.json().configuration, setup);
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
