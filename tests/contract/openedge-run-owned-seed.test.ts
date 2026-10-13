import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { generateRunCompose } from "../../packages/compose-runner/src/run-compose";
import { Scenario } from "../../packages/contracts/src/scenario";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
import { createSeedFixture } from "../helpers/seed";

const copySeed = path.resolve("docker/openedge-db/copy-seed.sh");

function runCopy(
  seedDb: string,
  workdir: string
): { status: number | null; stdout: string; stderr: string } {
  // Isolate host tools: a developer host can have prostrct installed.
  const tools = path.join(path.dirname(workdir), "portable-tools");
  fs.mkdirSync(tools, { recursive: true });
  for (const command of ["find", "grep", "awk", "cp", "date", "rm"]) {
    const target = path.join(tools, command);
    if (!fs.existsSync(target)) fs.symlinkSync(`/usr/bin/${command}`, target);
  }
  const result = spawnSync("/bin/sh", [copySeed, seedDb, workdir, "parkbench"], {
    encoding: "utf8",
    env: { PATH: tools }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("OpenEdge run-owned seed (directory seeds)", () => {
  it("copies the seed database into a fresh run volume and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-copy-"));
    try {
      const seed = createSeedFixture(path.join(root, "seeds"));
      const volume = path.join(root, "run-volume");
      fs.mkdirSync(volume);
      const first = runCopy(seed, volume);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /^seed_copy_seconds=\d+$/m);
      for (const file of fs.readdirSync(seed))
        assert.deepEqual(
          fs.readFileSync(path.join(volume, file)),
          fs.readFileSync(path.join(seed, file))
        );
      assert.equal(fs.existsSync(path.join(volume, ".parkbench-seed-restored")), true);
      // The seed's structure file keeps its relative extent paths.
      assert.match(fs.readFileSync(path.join(volume, "parkbench.st"), "utf8"), /^b \.$/m);
      const retry = runCopy(seed, volume);
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(retry.stdout, "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a non-empty volume, a missing extent and a missing seed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-copy-"));
    try {
      const seed = createSeedFixture(path.join(root, "seeds"));
      const dirty = path.join(root, "dirty");
      fs.mkdirSync(dirty);
      fs.writeFileSync(path.join(dirty, "leftover"), "x");
      const refused = runCopy(seed, dirty);
      assert.equal(refused.status, 47);
      assert.match(refused.stderr, /run_database_volume_not_empty/);

      fs.rmSync(path.join(seed, "parkbench_12.d1"));
      const empty = path.join(root, "empty");
      fs.mkdirSync(empty);
      const missing = runCopy(seed, empty);
      assert.equal(missing.status, 50);
      assert.match(missing.stderr, /seed_database_files_missing:parkbench_12\.d1/);

      const absent = runCopy(path.join(root, "no-such-seed"), empty);
      assert.equal(absent.status, 44);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves no restore marker when the copy is interrupted, so a restart refuses the half copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-copy-"));
    try {
      const seed = createSeedFixture(path.join(root, "seeds"));
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      // A cp that writes part of the copy and then hangs, like a large seed copy in progress.
      fs.writeFileSync(path.join(bin, "cp"), '#!/bin/sh\ntouch "$3/parkbench.db"\nexec sleep 30\n');
      fs.chmodSync(path.join(bin, "cp"), 0o755);
      const volume = path.join(root, "run-volume");
      fs.mkdirSync(volume);
      const { spawn } = await import("node:child_process");
      const child = spawn("/bin/sh", [copySeed, seed, volume, "parkbench"], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        detached: true
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      process.kill(-child.pid!, "SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      assert.equal(fs.existsSync(path.join(volume, ".parkbench-seed-restored")), false);
      const restart = runCopy(seed, volume);
      assert.equal(restart.status, 47);
      assert.match(restart.stderr, /run_database_volume_not_empty/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives two runs separate copies so one run's writes are not visible to the next", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-seed-copy-"));
    try {
      const seed = createSeedFixture(path.join(root, "seeds"));
      const first = path.join(root, "run-a");
      const second = path.join(root, "run-b");
      fs.mkdirSync(first);
      fs.mkdirSync(second);
      assert.equal(runCopy(seed, first).status, 0);
      fs.writeFileSync(path.join(first, "parkbench.d1"), "written by run a");
      assert.equal(runCopy(seed, second).status, 0);
      assert.equal(fs.readFileSync(path.join(second, "parkbench.d1"), "utf8"), "fixture");
      assert.equal(fs.readFileSync(path.join(seed, "parkbench.d1"), "utf8"), "fixture");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mounts the seed folder read-only and uses a volume per run", () => {
    const seedPath = path.resolve(".parkbench/test-seeds/one_gb_lnx");
    const common = {
      scenario: scenario as unknown as Scenario,
      images: { db: "parkbench/openedge-db:test", pas: "parkbench/openedge-pasoe:test" }
    };
    const render = (runId: string) =>
      generateRunCompose(runId, "exp_seed", common.scenario, common.images, {
        seed: seedPath,
        databaseName: "parkbench",
        loadgenImage: "parkbench/loadgen:test",
        observerImage: "parkbench/observer:test"
      });
    const first = render("run_seed_a");
    const second = render("run_seed_b");
    assert.ok(first.file.includes(`${first.projectName}_run-db-data`));
    assert.ok(second.file.includes(`${second.projectName}_run-db-data`));
    assert.notEqual(first.projectName, second.projectName);
    assert.ok(first.file.includes(`${seedPath}:/run/parkbench/seed/db:ro`));
    assert.doesNotMatch(first.file, /PARKBENCH_SEED_PATH/);
    assert.match(first.file, /DB_NAME: "parkbench"/);
  });

  it("keeps the copy script valid shell", () => {
    execFileSync("/bin/sh", ["-n", copySeed]);
  });
});

it('mounts frozen literal argv and controlled directories read-only beside the owned run volume',()=>{
 const bundle=generateRunCompose('catalog-owned','exp-catalog',scenario as any,{db:'db:fixture',pas:'pas:fixture'},{parameters:{'-T':'/psc/wrk/parkbench/literal spaces','-ssj':false},loadgenImage:'loadgen:fixture',observerImage:'observer:fixture'});
 assert.match(bundle.file,/-broker\.argv:\/run\/parkbench\/broker\.argv:ro/);assert.match(bundle.file,/-broker-directories:\/run\/parkbench\/broker-directories:ro/);assert.equal(bundle.brokerArgv,'-T\n/psc/wrk/parkbench/literal spaces\n-ssj\n0\n');assert.equal(bundle.brokerDirectories,'/psc/wrk/parkbench/literal spaces\n');assert.doesNotMatch(bundle.file,/PARKBENCH_OPENEDGE_DB_STARTUP_WORDS:/);
});
