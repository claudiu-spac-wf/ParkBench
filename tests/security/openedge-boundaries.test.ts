import {parameterPlan} from '../../packages/compose-runner/src/parameters';
import {validateDatabaseParameterPaths,databaseParameterTokens} from '../../packages/contracts/src/database-parameter-options';
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES,
  classifyTimeout,
  isJsonValue,
  parseWorkRequestBody,
  validateCanonicalProcName,
  validateBenchmarkImageManifest
} from "../../packages/contracts/src";
import { syntheticImageManifest } from "../helpers/openedge";

describe("OpenEdge boundary and security contract", () => {
  it("rejects unsafe procedure names before resolution", () => {
    for (const value of [
      "",
      "/Workloads/Read/test.p",
      "Workloads/../secret.p",
      "Workloads/Read/..\\secret.p",
      "Workloads//Read/test.p",
      "Workloads/Read/test.r",
      "Workloads/Read/test%2ep",
      "Workloads/Read/test.p/"
    ])
      assert.throws(() => validateCanonicalProcName(value), /unsafe_proc_name/);
  });

  it("rejects non-finite values and oversized request bodies", () => {
    assert.equal(isJsonValue(Number.NaN), false);
    assert.equal(isJsonValue(Infinity), false);
    const oversized = JSON.stringify({
      procName: "Workloads/Read/test.p",
      input: "x".repeat(OPENEDGE_WORKLOAD_BODY_LIMIT_BYTES)
    });
    assert.throws(() => parseWorkRequestBody(oversized), /invalid_work_request/);
  });

  it("classifies every timeout as a lower bound at one minute", () => {
    const timeout = classifyTimeout();
    assert.equal(timeout.timeoutMs, 60000);
    assert.equal(timeout.latencyObservation, "lower_bound");
    assert.ok(timeout.elapsedMs >= 60000);
  });

  it("rejects a generic image as a ParkBench workload input", () => {
    assert.throws(() => validateBenchmarkImageManifest(syntheticImageManifest("generic"), true));
  });

  it("rejects mutable build inputs before Docker work and cleans private staging", async () => {
    const loadModule = Function("specifier", "return import(specifier)") as (
      specifier: string
    ) => Promise<any>;
    const builder = await loadModule(
      pathToFileURL(path.join(process.cwd(), "scripts/openedge/preflight.mjs")).href
    );
    assert.throws(() => builder.normalizeOptions({ jdkImage: "jdk:latest" }), /jdk_image_invalid/);
    const compilerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-compiler-adapter-"));
    const compiler = path.join(compilerRoot, "adapter.sh");
    fs.writeFileSync(compiler, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    assert.throws(
      () => builder.validateCompilerAdapter(compiler, compilerRoot),
      /compiler_adapter_not_executable/
    );
    fs.chmodSync(compiler, 0o755);
    assert.equal(builder.validateCompilerAdapter(compiler, compilerRoot), "available");
    assert.doesNotThrow(() =>
      builder.normalizeOptions({
        dbImage: "parkbench/openedge-db:fixture",
        pasoeImage: "parkbench/openedge-pas:fixture",
        jdkImage: "parkbench/jdk:fixture"
      })
    );
    const stage = await loadModule(
      pathToFileURL(path.join(process.cwd(), "scripts/openedge/stage-inputs.mjs")).href
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-stage-test-"));
    const license = path.join(root, "progress.cfg");
    const progressRoot = path.join(root, "IMAGES");
    const workloadRoot = path.join(root, "Workloads");
    fs.mkdirSync(progressRoot);
    fs.mkdirSync(workloadRoot);
    fs.writeFileSync(license, "synthetic-license");
    const staged = stage.stageInputs(
      { license, progressRoot, workloadRoot, outputRoot: path.join(root, "output") },
      "generic"
    );
    assert.equal(fs.existsSync(staged.stagedLicense), true);
    stage.cleanupPrivateStage(staged);
    assert.equal(fs.existsSync(staged.stagedLicense), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

it("approves only finite readable collector names and preserves read-only enforcement", () => {
  const { validateOpenEdgeDatabaseCommand } = require("../../packages/observers/src/openedge-db/adapter");
  for (const name of ["parkbench-db-observer.p", "parkbench-db-observer.r", "parkbench-db-observer-v2.p", "parkbench-db-observer-v2.r", "prepare-run-db-observer.p"])
    validateOpenEdgeDatabaseCommand({ executable: "pro", procedure: "/app/openedge/observers/db/" + name, readOnly: true });
  for (const name of ["evil-parkbench-db-observer-v2.p", "prepare-run-db-observer.r", "other.p"])
    assert.throws(() => validateOpenEdgeDatabaseCommand({ executable: "pro", procedure: name, readOnly: true }), /not_approved/);
  assert.throws(() => validateOpenEdgeDatabaseCommand({ executable: "pro", procedure: "parkbench-db-observer-v2.p", readOnly: false }), /read_only_required/);
});

it('keeps the expanded catalog inside owned broker paths and infrastructure',()=>{
 for(const name of ['-S','-H','-minport','-maxport'])assert.throws(()=>parameterPlan({[name]:name==='-minport'||name==='-maxport'?22222:'foreign'}));
 for(const value of ['/tmp/foreign','/psc/wrk/parkbench/../foreign','/run/parkbench/seed/db/read-only'])assert.throws(()=>validateDatabaseParameterPaths({'-T':value},'parkbench'));
 assert.doesNotThrow(()=>validateDatabaseParameterPaths({'-T':'/psc/wrk/parkbench/literal spaces'},'parkbench'));
 assert.deepEqual(databaseParameterTokens('-threadedServer',false),['-threadedServer','0']);
 assert.throws(()=>parameterPlan({'-m3':true}));assert.throws(()=>parameterPlan({'-cache':'/run/parkbench/seed/db/client.bin'}));
});
