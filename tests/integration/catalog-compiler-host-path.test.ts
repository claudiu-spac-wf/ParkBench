import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("containerized compiler mounts shared staged sources through the Docker host path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-compiler-path-"));
  const localRoot = path.join(root, "container");
  const hostRoot = path.join(root, "host");
  const sourceDir = path.join(localRoot, "staging");
  const source = path.join(sourceDir, "probe.p");
  const log = path.join(root, "docker-args.jsonl");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.symlinkSync(localRoot, hostRoot, "dir");
  fs.writeFileSync(source, "DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.\n");
  const fakeDocker = path.join(root, "docker.mjs");
  fs.writeFileSync(
    fakeDocker,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PARKBENCH_TEST_DOCKER_LOG, JSON.stringify(args)+'\\n');
if (args[0] === 'run') {
  const mounts = args.flatMap((value,index) => value === '-v' ? [args[index+1].split(':')[0]] : []);
  if (mounts.length !== 2 || mounts.some((value) => !fs.existsSync(value))) process.exit(2);
}
if (args[0] === 'exec' && args.includes('/psc/dlc/bin/pro'))
  fs.writeFileSync(process.env.PARKBENCH_TEST_SOURCE.slice(0,-2)+'.r','compiled');
`
  );
  fs.chmodSync(fakeDocker, 0o755);
  try {
    execFileSync(process.execPath, [path.resolve("scripts/openedge/compile-with-db.mjs"), source], {
      env: {
        ...process.env,
        PARKBENCH_CONTAINER_PATH_ROOT: localRoot,
        PARKBENCH_DOCKER_HOST_PATH_ROOT: hostRoot,
        PARKBENCH_OPENEDGE_DOCKER_COMMAND: fakeDocker,
        PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE: "parkbench/openedge-db:test",
        PARKBENCH_OPENEDGE_COMPILE_SCHEMA: "",
        PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE: "",
        PARKBENCH_OPENEDGE_COMPILER_SEED_DIR: "",
        PARKBENCH_TEST_DOCKER_LOG: log,
        PARKBENCH_TEST_SOURCE: source
      }
    });
    assert.equal(fs.existsSync(source.slice(0, -2) + ".r"), true);
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run")!;
    assert.ok(run.includes(`${path.join(hostRoot, "staging")}:/parkbench/source:rw`));
    assert.ok(
      run.includes(
        `${path.join(hostRoot, "staging", ".parkbench-compile-source.p")}:/parkbench/compile-source.p:ro`
      )
    );
    assert.equal(fs.existsSync(path.join(sourceDir, ".parkbench-compile-source.p")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schema compilation mounts only definitions and never mounts the seed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-schema-compiler-"));
  const source = path.join(root, "probe.p");
  const schema = path.join(root, "schema.df");
  const log = path.join(root, "commands.jsonl");
  const fake = path.join(root, "docker.mjs");
  fs.writeFileSync(source, "DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.\n");
  fs.writeFileSync(schema, 'ADD TABLE "Account"\n AREA "Accounts"\n');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='run') {
  const mounts=args.flatMap((v,i)=>v==='-v'?[args[i+1].split(':')[0]]:[]);
  if(mounts.some(v=>!fs.existsSync(v))) process.exit(3);
  if(process.env.PROBE_FAIL==='true') process.exit(4);
}
if(process.env.PROBE_FAIL==='schema'&&args[0]==='exec') process.exit(5);
if(process.env.PROBE_FAIL==='schema'&&args[0]==='inspect') console.log('exited');
if(args[0]==='logs') console.log('compiler_schema_load_failed');
if(args.includes('/psc/dlc/bin/pro')) fs.writeFileSync(process.env.PROBE_SOURCE.slice(0,-2)+'.r','compiled');
`
  );
  fs.chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    PARKBENCH_OPENEDGE_DOCKER_COMMAND: fake,
    PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE: "parkbench/openedge-db:test",
    PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE: schema,
    PARKBENCH_OPENEDGE_COMPILER_SEED_DIR: "/never-mount-this-seed",
    PROBE_LOG: log,
    PROBE_SOURCE: source
  };
  try {
    execFileSync(process.execPath, [path.resolve("scripts/openedge/compile-with-db.mjs"), source], {
      env
    });
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run")!;
    assert.ok(run.includes(`${schema}:/parkbench/compiler.df:ro`));
    assert.ok(run.includes("PARKBENCH_DB_INIT_MODE=empty"));
    assert.ok(run.includes("/parkbench/init-compiler-db.sh"));
    assert.ok(run.every((arg) => !arg.includes("/run/parkbench/seed")));
    assert.ok(calls.some((args) => args[0] === "rm" && args.includes("-v")));
    assert.equal(fs.existsSync(path.join(root, ".parkbench-compiler.st")), false);
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [path.resolve("scripts/openedge/compile-with-db.mjs"), source],
        { env: { ...env, PROBE_FAIL: "true" }, stdio: "pipe" }
      )
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.resolve("scripts/openedge/compile-with-db.mjs"), source],
          { env: { ...env, PROBE_FAIL: "schema" }, stdio: "pipe" }
        ),
      /compiler_schema_load_failed/
    );
    const failedCalls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(failedCalls.at(-1)?.includes("rm"));
    assert.equal(fs.existsSync(source.slice(0, -2) + ".r"), false);
    assert.equal(fs.existsSync(path.join(root, ".parkbench-compile-source.p")), false);
    assert.equal(fs.existsSync(path.join(root, ".parkbench-compiler.st")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch compiler uses one container for nested sources and removes partial output on failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-batch-compiler-"));
  const sources = ["first/probe.p", "second/probe.p"].map((name) => path.join(root, name));
  for (const source of sources) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.");
  }
  const log = path.join(root, "calls.jsonl");
  const fake = path.join(root, "docker.mjs");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2);
fs.appendFileSync(process.env.BATCH_LOG,JSON.stringify(args)+'\\n');
if(args.includes('/psc/dlc/bin/pro')){
 const relative=args[args.indexOf('-param')+1].replace('/parkbench/source/','');
 if(process.env.BATCH_FAIL==='true'&&relative.startsWith('second/'))process.exit(7);
 const source=path.join(process.env.BATCH_ROOT,relative);
 fs.writeFileSync(source.slice(0,-2)+'.r','compiled');
}
`
  );
  fs.chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    PARKBENCH_OPENEDGE_DOCKER_COMMAND: fake,
    PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE: "parkbench/openedge-db:test",
    PARKBENCH_OPENEDGE_COMPILE_SCHEMA: "",
    PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE: "",
    PARKBENCH_OPENEDGE_COMPILER_SEED_DIR: "",
    BATCH_LOG: log,
    BATCH_ROOT: root
  };
  try {
    execFileSync(
      process.execPath,
      [path.resolve("scripts/openedge/compile-with-db.mjs"), "--batch", ...sources],
      { env }
    );
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((args) => args[0] === "run").length, 1);
    assert.equal(calls.filter((args) => args[0] === "rm").length, 1);
    assert.equal(calls.filter((args) => args.includes("/psc/dlc/bin/pro")).length, 2);
    for (const source of sources) assert.equal(fs.existsSync(source.slice(0, -2) + ".r"), true);
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [path.resolve("scripts/openedge/compile-with-db.mjs"), "--batch", ...sources],
        { env: { ...env, BATCH_FAIL: "true" }, stdio: "pipe" }
      )
    );
    for (const source of sources) assert.equal(fs.existsSync(source.slice(0, -2) + ".r"), false);
    assert.equal(fs.existsSync(path.join(root, ".parkbench-compile-source.p")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner archive compiles workloads and handler in one built-in session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-archive-batch-"));
  const workloadRoot = path.join(root, "Workloads");
  const handler = path.join(root, "runner", "Handler.cls");
  const log = path.join(root, "calls.jsonl");
  const fake = path.join(root, "docker.mjs");
  fs.mkdirSync(workloadRoot, { recursive: true });
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  for (const name of ["one.p", "two.p"])
    fs.writeFileSync(
      path.join(workloadRoot, name),
      "DEFINE INPUT PARAMETER SingleParam AS LONGCHAR NO-UNDO.\n"
    );
  fs.writeFileSync(handler, "CLASS Handler: END CLASS.");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);fs.appendFileSync(process.env.ARCHIVE_BATCH_LOG,JSON.stringify(args)+'\\n');
if(args.includes('/psc/dlc/bin/pro')) {
 const relative=args[args.indexOf('-param')+1].replace('/parkbench/source/','');
 const source=path.join(process.env.ARCHIVE_BATCH_ROOT,relative);
 fs.writeFileSync(source.slice(0,-path.extname(source).length)+'.r','compiled');
}
`
  );
  fs.chmodSync(fake, 0o755);
  const updates = {
    PARKBENCH_OPENEDGE_DOCKER_COMMAND: fake,
    PARKBENCH_OPENEDGE_COMPILER: path.resolve("scripts/openedge/compile-with-db.mjs"),
    PARKBENCH_OPENEDGE_COMPILER_DB_IMAGE: "parkbench/openedge-db:test",
    PARKBENCH_OPENEDGE_COMPILE_SCHEMA: "",
    PARKBENCH_OPENEDGE_COMPILER_SCHEMA_FILE: "",
    PARKBENCH_OPENEDGE_COMPILER_SEED_DIR: "",
    ARCHIVE_BATCH_LOG: log,
    ARCHIVE_BATCH_ROOT: root
  };
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);
  try {
    const { createRequire } = require("node:module");
    const { prepareRunnerArchive } = createRequire(path.join(process.cwd(), "package.json"))(
      "./scripts/openedge/package-runner.mjs"
    );
    const archive = prepareRunnerArchive({
      workloadRoot,
      handlerPath: handler,
      outputRoot: path.join(root, "output"),
      stage: "final"
    });
    assert.equal(archive.handlerCompiled, true);
    assert.equal(archive.procedures.length, 2);
    assert.ok(archive.procedures.every((procedure: any) => procedure.compiled));
    assert.ok(fs.existsSync(archive.archive));
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((args) => args[0] === "run").length, 1);
    assert.equal(calls.filter((args) => args.includes("/psc/dlc/bin/pro")).length, 3);
    assert.equal(calls.filter((args) => args[0] === "rm").length, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
