import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn, execFileSync } from "node:child_process";
const source = path.resolve("docker/openedge-db/setup");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-custom-helper-"));
const binary = path.join(root, "custom-supervisor");
function supervisor() {
  if (fs.existsSync(path.join(source, "custom-supervisor.c")))
    execFileSync("cc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      path.join(source, "custom-supervisor.c"),
      "-o",
      binary
    ]);
  return fs.existsSync(binary);
}
const available = supervisor();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
for (const [suffix, scriptBody, expected] of [
  [" | cat", "exit 7", 7],
  ["; true", "exit 9", 9],
  ["; false", "exit 0", 1],
  [" &", "exit 0", 0],
  ["", "false\nexit 0", 0]
] as const) {
  test(`designated primary and outer shell have independent exits: ${scriptBody.replace(/\n/g, " ")} ${suffix}`, () => {
    const dir = fs.mkdtempSync(path.join(root, "case-")),
      record = path.join(dir, "record"),
      script = path.join(dir, "selected script.sh"),
      command = path.join(dir, "command.sh");
    fs.writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
    fs.writeFileSync(
      command,
      `'${available ? path.join(source, "run-custom.sh") : script}' ${available ? "'" + script + "'" : ""} ${suffix}`
    );
    const result = available
      ? spawnSync(binary, [command, record], {
          cwd: dir,
          env: { ...process.env, PARKBENCH_PRIMARY_RECORD: record },
          encoding: "utf8"
        })
      : spawnSync("sh", [command], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(fs.readFileSync(record + ".process", "utf8").trim(), "QUIESCENT");
    assert(fs.existsSync(record + ".primary-exit"));
    assert(fs.existsSync(record + ".shell-exit"));
  });
}
test("subreaping waits for detached closed-output descendants after a zero parent exit", async () => {
  assert(available, "a compiled subreaper must supply the completion guarantee");
  const dir = fs.mkdtempSync(path.join(root, "detached-")),
    record = path.join(dir, "record"),
    script = path.join(dir, "detach.sh"),
    command = path.join(dir, "command.sh");
  fs.writeFileSync(
    script,
    "#!/bin/sh\nsetsid sh -c 'touch child-started; while [ ! -f child-release ]; do sleep 0.05; done; touch child-finished' </dev/null >/dev/null 2>&1 &\nexit 0\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(command, `'${path.join(source, "run-custom.sh")}' '${script}'`);
  const child = spawn(binary, [command, record], {
    cwd: dir,
    env: { ...process.env, PARKBENCH_PRIMARY_RECORD: record },
    stdio: "ignore"
  });
  try {
    const until = async (file: string) => {
      const end = Date.now() + 5000;
      while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      assert(fs.existsSync(file), file);
    };
    await until(path.join(dir, "child-started"));
    await until(record + ".shell-exit");
    assert.equal(child.exitCode, null);
    assert.equal(fs.readFileSync(record + ".process", "utf8").trim(), "ACTIVE");
    fs.writeFileSync(path.join(dir, "child-release"), "");
    const exit = await new Promise((r) => child.once("exit", r));
    assert.equal(exit, 0);
    assert(fs.existsSync(path.join(dir, "child-finished")));
    assert.equal(fs.readFileSync(record + ".process", "utf8").trim(), "QUIESCENT");
  } finally {
    child.kill("SIGTERM");
  }
});
