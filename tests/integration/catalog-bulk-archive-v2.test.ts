import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { readArchiveContents, assertScenarioArchiveCompatible } from "../../apps/control-plane/src/catalog/archive-contents";
import { Scenario } from "../../packages/contracts/src/scenario";

async function terminal(get: () => { state: string }): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const action = get();
    if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(action.state)) return action;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("catalog_action_timeout");
}

test("named partial archive publishes compiled siblings without clobbering an older archive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-bulk-archive-"));
  const workloads = path.join(root, "workloads");
  const archives = path.join(root, "archives");
  fs.mkdirSync(path.join(workloads, "nested"), { recursive: true });
  fs.mkdirSync(archives);
  const source = "DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.\n";
  fs.writeFileSync(path.join(workloads, "nested", "good.p"), source);
  fs.writeFileSync(path.join(workloads, "nested", "bad.p"), source);
  const compiler = path.join(root, "compiler.mjs");
  fs.writeFileSync(compiler, `import fs from 'node:fs'; import path from 'node:path'; const file=process.argv[2];\nif(file.endsWith('bad.p')) process.exit(1);\nfs.writeFileSync(file.slice(0,-path.extname(file).length)+'.r','compiled');\n`);
  const oldCompiler = process.env.PARKBENCH_OPENEDGE_COMPILER;
  process.env.PARKBENCH_OPENEDGE_COMPILER = compiler;
  const platform = createPlatform({ host: "127.0.0.1", port: 0, dbPath: path.join(root, "db.sqlite"),
    artifactRoot: path.join(root, "artifacts"), prometheusUrl: "http://127.0.0.1:9090",
    prometheusRetention: "7d", discoveryRoots: { workloads, archives }, openedge: {} } as any,
    { testMode: true });
  try {
    const started = platform.catalogActions.start("REBUILD_ARCHIVE", "trial");
    const action = await terminal(() => platform.catalogActions.get(started.id)!);
    assert.equal(action.state, "PARTIAL", JSON.stringify(action.error));
    assert.equal(action.results.length, 2);
    const archive = path.join(archives, "trial.zip");
    assert.equal(fs.existsSync(archive), true);
    const contents = readArchiveContents(archive);
    assert.equal(contents.state, "PARTIAL");
    assert.deepEqual(contents.included, ["Workloads/nested/good.r"]);
    assert.deepEqual(contents.excluded.map((item) => item.procedure), ["Workloads/nested/bad.r"]);
    const scenario = { workload: { operations: [{ bodyTemplate: { procName: "Workloads/nested/good.p" } }] } } as Scenario;
    assert.doesNotThrow(() => assertScenarioArchiveCompatible(archive, scenario));
    assert.throws(() => assertScenarioArchiveCompatible(archive, {
      ...scenario, workload: { operations: [{ bodyTemplate: { procName: "Workloads/nested/bad.p" } }] }
    } as Scenario), /archive_workload_excluded/);
    const before = fs.readFileSync(archive);
    const repeatedStart = platform.catalogActions.start("REBUILD_ARCHIVE", "trial");
    const repeated = await terminal(() => platform.catalogActions.get(repeatedStart.id)!);
    assert.equal(repeated.state, "FAILED");
    assert.deepEqual(fs.readFileSync(archive), before);
  } finally {
    platform.close();
    if (oldCompiler === undefined) delete process.env.PARKBENCH_OPENEDGE_COMPILER;
    else process.env.PARKBENCH_OPENEDGE_COMPILER = oldCompiler;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
