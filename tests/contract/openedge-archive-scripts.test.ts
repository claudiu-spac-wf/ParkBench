import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { zipEntry, zipEntryNames } from "../helpers/openedge";

const root = process.cwd();

describe("OpenEdge archive scripts", () => {
  it("packages a workload's sibling contract and keeps the one-parameter rule", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-contract-archive-"));
    try {
      const workloadRoot = path.join(temporaryRoot, "Workloads");
      fs.mkdirSync(path.join(workloadRoot, "ParkBench"), { recursive: true });
      fs.copyFileSync(
        path.join(root, "openedge/workloads/Workloads/ParkBench/bank_mix.p"),
        path.join(workloadRoot, "ParkBench/bank_mix.p")
      );
      fs.copyFileSync(
        path.join(root, "openedge/workloads/Workloads/ParkBench/bank_mix.contract.json"),
        path.join(workloadRoot, "ParkBench/bank_mix.contract.json")
      );
      const outputRoot = path.join(temporaryRoot, "output");
      const run = () =>
        execFileSync(
          process.execPath,
          [
            "scripts/openedge/create-runner-archive.mjs",
            "--output-root",
            outputRoot,
            "--workload-root",
            workloadRoot,
            "--stage",
            "final"
          ],
          { cwd: root, encoding: "utf8", env: { ...process.env, PARKBENCH_OPENEDGE_COMPILER: "" } }
        );
      run();
      const app = path.join(temporaryRoot, "app.zip");
      fs.writeFileSync(app, zipEntry(path.join(outputRoot, "archives/oepas1.zip"), "ablapps/parkbench.zip")!);
      const names = zipEntryNames(app);
      assert.ok(names.includes("openedge/Workloads/ParkBench/bank_mix.p"));
      assert.ok(names.includes("openedge/Workloads/ParkBench/bank_mix.contract.json"));
      const merge = zipEntry(app, "tlr/openedge.properties.merge")!.toString("utf8");
      assert.doesNotMatch(merge, /sports/i);
      assert.equal((zipEntry(app, "conf/startup.pf")!.toString("utf8").match(/-db /g) ?? []).length, 1);

      fs.appendFileSync(
        path.join(workloadRoot, "ParkBench/bank_mix.p"),
        "\nPROCEDURE extra:\n  DEFINE INPUT PARAMETER other AS CHARACTER NO-UNDO.\nEND PROCEDURE.\n"
      );
      assert.throws(run, /workload_signature_invalid:bank_mix\.p/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an invalid workload contract", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-contract-archive-"));
    try {
      const workloadRoot = path.join(temporaryRoot, "Workloads");
      fs.mkdirSync(path.join(workloadRoot, "ParkBench"), { recursive: true });
      fs.copyFileSync(
        path.join(root, "openedge/workloads/Workloads/ParkBench/bank_mix.p"),
        path.join(workloadRoot, "ParkBench/bank_mix.p")
      );
      fs.writeFileSync(
        path.join(workloadRoot, "ParkBench/bank_mix.contract.json"),
        JSON.stringify({ contractVersion: "workload-contract.v0" })
      );
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ["scripts/openedge/create-runner-archive.mjs", "--output-root", path.join(temporaryRoot, "out"),
              "--workload-root", workloadRoot, "--stage", "final"],
            { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, PARKBENCH_OPENEDGE_COMPILER: "" } }
          ),
        /workload_contract_invalid:contractVersion/
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("creates the oepas1 runner archive without rebuilding an image", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-runner-"));
    const workloadRoot = path.join(temporaryRoot, "workloads");
    fs.mkdirSync(workloadRoot, { recursive: true });
    const outputRoot = path.join(temporaryRoot, "output");
    const result = execFileSync(
      process.execPath,
      [
        "scripts/openedge/create-runner-archive.mjs",
        "--output-root",
        outputRoot,
        "--workload-root",
        workloadRoot,
        "--stage",
        "final",
        "--allow-empty"
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PARKBENCH_OPENEDGE_COMPILER: "" }
      }
    );
    const archive = path.join(outputRoot, "archives/oepas1.zip");
    assert.equal(fs.existsSync(archive), true);
    assert.match(result, /pasoe-runner-archive/);
    assert.deepEqual(zipEntryNames(archive).sort(), ["ablapps/parkbench.zip"]);
  });
});
