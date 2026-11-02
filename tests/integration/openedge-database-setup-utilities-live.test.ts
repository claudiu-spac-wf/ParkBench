import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { compileDatabaseSetup } from "../../apps/control-plane/src/database-setup/compile-plan";
import { validateDatabaseSetup } from "../../packages/contracts/src/database-setup";
const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const docker = (args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
test(
  "licensed utility wrappers execute selected indexes, offline compaction and two-table temporary reorganization",
  { skip: !enabled, timeout: 300000 },
  () => {
    const image = process.env.PARKBENCH_DATABASE_SETUP_TEST_IMAGE;
    assert(image, "explicit native opt-in requires PARKBENCH_DATABASE_SETUP_TEST_IMAGE");
    const id = `parkbench-f023-util-${Date.now().toString(36)}`;
    const root = path.resolve(".parkbench/validation/feature023/native-utilities", id);
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o777);
    const volume = id + "-data",
      label = "org.parkbench.validation=feature023";
    const evidence: any = { image, volume, commands: [], deleted: false };
    const call = (args: string[]) => {
      try {
        const result = docker(args);
        evidence.commands.push({ args, stdout: result });
        return result;
      } catch (error: any) {
        evidence.commands.push({
          args,
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          status: error.status
        });
        throw error;
      }
    };
    try {
      call(["image", "inspect", image]);
      call(["volume", "create", "--label", label, volume]);
      const fixture = path.resolve("tests/fixtures/database-setup/native");
      call([
        "run",
        "--rm",
        "--label",
        label,
        "--entrypoint",
        "sh",
        "-v",
        `${volume}:/psc/wrk`,
        "-v",
        `${fixture}:/fixture:ro`,
        image,
        "-ec",
        'mkdir -p /psc/wrk/testdb; cd /psc/wrk/testdb; procopy "$DLC/prolang/utf/empty8" testdb; prostrct add testdb /fixture/areas.st; pro -b -db testdb -p /fixture/load.p; pro -b -db testdb -p /fixture/populate.p'
      ]);
      const setup = validateDatabaseSetup({
        contractVersion: "database-setup.v1",
        steps: [
          { id: "all", definitionId: "idxbuild", optionSets: [{ id: "all", scope: "all" }] },
          {
            id: "table",
            definitionId: "idxbuild",
            optionSets: [
              { id: "customers", scope: "table", table: "PUB.SetupCustomer" },
              { id: "orders", scope: "table", table: "PUB.SetupOrder" }
            ]
          },
          {
            id: "selected",
            definitionId: "idxbuild",
            optionSets: [
              {
                id: "some",
                scope: "indexes",
                indexes: [
                  { table: "SetupCustomer", index: "CustomerId" },
                  { table: "SetupOrder", index: "OrderId" }
                ]
              }
            ]
          },
          {
            id: "compact",
            definitionId: "idxcompact",
            optionSets: [
              { id: "default", index: "PUB.SetupCustomer.CustomerId" },
              { id: "percent", index: "PUB.SetupOrder.OrderId", compactionPercent: 75 },
              { id: "unused", index: "PUB.SetupCustomer.CustomerId", mode: "unusedblocks" }
            ]
          },
          {
            id: "reorg",
            definitionId: "tablereorg",
            optionSets: [
              { id: "customers", table: "PUB.SetupCustomer", useIndex: "CustomerId" },
              { id: "orders", table: "PUB.SetupOrder", useIndex: "OrderId" }
            ]
          }
        ]
      });
      const plan = compileDatabaseSetup({
        runId: id,
        attemptId: "attempt-1",
        setup,
        runtimeDirectory: root,
        databaseName: "testdb",
        image
      });
      const result = call([
        "run",
        "--rm",
        "--label",
        label,
        "--entrypoint",
        "sh",
        "-v",
        `${volume}:/psc/wrk`,
        "-v",
        `${plan.manifest.paths.input}:/run/parkbench/setup-input:ro`,
        "-v",
        `${plan.manifest.paths.output}:/run/parkbench/setup-output`,
        "-v",
        `${plan.manifest.paths.control}:/run/parkbench/setup-control`,
        "-e",
        `PARKBENCH_RUN_ID=${id}`,
        "-e",
        "PARKBENCH_SETUP_ATTEMPT_ID=attempt-1",
        "-e",
        "DB_NAME=testdb",
        image,
        "-ec",
        "cd /psc/wrk/testdb; /usr/local/lib/parkbench/setup/run-setup.sh claim; /usr/local/lib/parkbench/setup/run-setup.sh execute"
      ]);
      evidence.output = result;
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(plan.manifest.paths.output, "status.json"), "utf8"))
          .state,
        "SUCCEEDED"
      );
    } finally {
      try {
        docker(["volume", "rm", volume]);
        evidence.deleted = true;
      } catch {}
      fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
    }
  }
);
