import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const { resolveCompilerSchema, compilerStructure } = createRequire(
  path.join(process.cwd(), "package.json")
)("./scripts/openedge/compiler-schema.mjs");

test("compiler requires an explicit readable definition file", () => {
  assert.throws(() => resolveCompilerSchema(undefined), /compile_schema_required/);
  assert.throws(() => resolveCompilerSchema("/nonexistent/schema.df"), /compile_schema_missing/);
});
test("minimal compiler structure preserves definition areas without seed allocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-compiler-schema-"));
  try {
    const file = path.join(root, "schema.df");
    fs.writeFileSync(
      file,
      'ADD TABLE "Account"\n  AREA "PB_Data"\nADD INDEX "Primary" ON "Account"\n  AREA "PB_Index"\n'
    );
    const schema = resolveCompilerSchema(file);
    assert.match(schema.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(compilerStructure(fs.readFileSync(file, "utf8")).split("\n").filter(Boolean), [
      "b .",
      'd "Schema Area":6,32;1 .',
      'd "PB_Data":7,32;1 .',
      'd "PB_Index":8,32;1 .'
    ]);
    assert.throws(
      () => compilerStructure('ADD TABLE "Account"\n AREA "bad~nname"'),
      /compile_schema_area_invalid/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { hostMemoryCheck } = createRequire(path.join(process.cwd(), "package.json"))(
  "./scripts/host-preflight.mjs"
);
test("bootstrap fails under host pressure and accepts the exact RAM boundary", () => {
  assert.equal(hostMemoryCheck("MemAvailable: 2097151 kB").diagnosticCode, "host_memory_pressure");
  assert.equal(hostMemoryCheck("MemAvailable: 2097152 kB").status, "pass");
  assert.equal(hostMemoryCheck("MemFree: 9000000 kB").diagnosticCode, "host_memory_unavailable");
  assert.equal(hostMemoryCheck("MemAvailable: 0 kB").status, "fail");
});

test("generic compilation clears inherited schema settings across child env loading and restores them", () => {
  const { withCompilerDatabase } = createRequire(path.join(process.cwd(), "package.json"))(
    "./scripts/openedge/build-images.mjs"
  );
  const original = process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA;
  process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA = "/operator/schema.df";
  try {
    withCompilerDatabase("parkbench/openedge-db:test", { databaseName: "parkbench" }, () => {
      const output = execFileSync(
        process.execPath,
        [
          "-e",
          "require('./scripts/lib/load-env.cjs').loadEnvironment(); console.log(JSON.stringify({schema:process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA,legacySeed:process.env.PARKBENCH_OPENEDGE_COMPILER_SEED_DIR}))"
        ],
        { encoding: "utf8" }
      );
      assert.deepEqual(JSON.parse(output), { schema: "", legacySeed: "" });
    });
    assert.equal(process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA, "/operator/schema.df");
    assert.throws(
      () =>
        withCompilerDatabase("parkbench/openedge-db:test", undefined, () => {
          throw new Error("probe");
        }),
      /probe/
    );
    assert.equal(process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA, "/operator/schema.df");
  } finally {
    if (original === undefined) delete process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA;
    else process.env.PARKBENCH_OPENEDGE_COMPILE_SCHEMA = original;
  }
});
