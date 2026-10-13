import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateWorkloadContract } from "../../packages/contracts/src/workload-contract";

const procedurePath = "openedge/workloads/Workloads/Generic/arbitrary_reads.p";
const contractPath = "openedge/workloads/Workloads/Generic/arbitrary_reads.contract.json";
const errorCodes = [
  "invalid_work_mode",
  "invalid_work_input:",
  "arbitrary_reads_invalid:table:",
  "arbitrary_reads_invalid:field:",
  "arbitrary_reads_invalid:lob_field:",
  "arbitrary_reads_invalid:where_clause",
  "arbitrary_reads_failed:"
];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

describe("generic arbitrary reads workload", () => {
  it("ships a valid any-table, read-only contract", () => {
    const contract = validateWorkloadContract(
      JSON.parse(fs.readFileSync(contractPath, "utf8")),
      "Workloads/Generic/arbitrary_reads.p"
    );
    assert.equal(contract.id, "generic-arbitrary-reads");
    assert.equal(contract.tableScope, "any");
    assert.equal(contract.databaseName, "*");
    assert.deepEqual(contract.requiredTables, []);
    assert.equal(contract.readiness.mode, "none");
    assert.equal(contract.writes, undefined);
  });

  it("keeps the single-parameter signature and the handler-owned timer", () => {
    const source = fs.readFileSync(procedurePath, "utf8");
    assert.equal(
      (source.match(/DEFINE\s+INPUT\s+PARAMETER\s+SingleParam\s+AS\s+LONGCHAR\s+NO-UNDO\./gi) ?? [])
        .length,
      1
    );
    assert.equal((source.match(/DEFINE\s+INPUT\s+PARAMETER\b/gi) ?? []).length, 1);
    assert.doesNotMatch(source, /ETIME\s*\(\s*(YES|TRUE)/i);
    for (const required of ["NO-LOCK", "FINALLY", "SET-SIZE(", "COPY-LOB", "QUERY-PREPARE"])
      assert.ok(source.toUpperCase().includes(required), required);
  });

  it("is write-free", () => {
    const code = withoutComments(fs.readFileSync(procedurePath, "utf8"));
    assert.doesNotMatch(code, /\bCREATE\s+(?!BUFFER\b|QUERY\b|WIDGET-POOL\b)[\w-]+/i);
    assert.doesNotMatch(code, /\bDELETE\s+(?!OBJECT\b)\w+/i);
    assert.doesNotMatch(
      code,
      /BUFFER-CREATE|BUFFER-DELETE|BUFFER-COPY|EXCLUSIVE-LOCK|SHARE-LOCK|\bTRANSACTION\b/i
    );
    assert.doesNotMatch(code, /\bASSIGN\b[^.]*BUFFER-VALUE\s*=/i);
  });

  it("raises every documented error code", () => {
    const source = fs.readFileSync(procedurePath, "utf8");
    for (const code of errorCodes) assert.ok(source.includes(`"${code}`), code);
  });

  it("is discovered with its sibling contract", () => {
    const packageRunner = pathToFileURL(
      path.join(process.cwd(), "scripts/openedge/package-runner.mjs")
    ).href;
    const workloadRoot = path.join(process.cwd(), "openedge/workloads/Workloads");
    const script = `
      const { discoverWorkloads } = await import(${JSON.stringify(packageRunner)});
      console.log(JSON.stringify(discoverWorkloads(${JSON.stringify(workloadRoot)}, { compile: false })));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PARKBENCH_OPENEDGE_COMPILER: "" }
    });
    const workloads = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    const generic = workloads.find(
      (item: any) => item.procName === "Workloads/Generic/arbitrary_reads.p"
    );
    assert.ok(generic, "generic workload discovered");
    assert.equal(generic.contract.path, "Workloads/Generic/arbitrary_reads.contract.json");
  });
});
