import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { EngineApi } from "../../packages/compose-runner/src/engine-api";
const fields = [
  "BlkioDeviceReadIOps",
  "BlkioDeviceWriteIOps",
  "BlkioDeviceReadBps",
  "BlkioDeviceWriteBps",
  "BlkioWeight",
  "Memory",
  "MemorySwap",
  "NanoCpus",
  "CpuShares",
  "CpuQuota",
  "CpuPeriod",
  "CpusetCpus",
  "PidsLimit"
];
export async function captureIopsBoundaries(
  seedRef = "input:seeds/one_gb_lnx",
  archiveRef = "input:archives/parkbench-runner.zip"
) {
  const api = await EngineApi.forDocker();
  const list = await api.request("GET", api.versioned("/containers/json?all=1"));
  const containers = [];
  for (const c of list) {
    if (c.Labels?.["parkbench.run_id"]?.startsWith("f025-")) continue;
    const data = await api.inspect(c.Id);
    containers.push({
      id: data.Id,
      controls: Object.fromEntries(fields.map((k) => [k, data.HostConfig[k] ?? null]))
    });
  }
  assert.match(seedRef, /^input:seeds\/[A-Za-z0-9_./-]+$/);
  assert.match(archiveRef, /^input:archives\/[A-Za-z0-9_./-]+$/);
  assert.ok(![seedRef, archiveRef].some((r) => r.split("/").includes("..")));
  const seedRoot = path.resolve(
    process.env.PARKBENCH_DISCOVERY_SEEDS_ROOT ?? ".parkbench/seeds",
    seedRef.slice("input:seeds/".length)
  );
  const archive = path.resolve(
    process.env.PARKBENCH_DISCOVERY_ARCHIVES_ROOT ?? ".parkbench/archives",
    archiveRef.slice("input:archives/".length)
  );
  const seed = [];
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, name),
        s = fs.lstatSync(f);
      assert.ok(seed.length < 16384);
      if (s.isDirectory()) walk(f);
      else
        seed.push({
          relativePath: path.relative(seedRoot, f),
          size: s.size,
          mtimeMs: s.mtimeMs,
          mode: s.mode,
          symlink: s.isSymbolicLink()
        });
    }
  }
  walk(seedRoot);
  const a = fs.statSync(archive);
  return {
    daemonId: api.daemonId,
    containers: containers.sort((a, b) => a.id.localeCompare(b.id)),
    seed,
    archive: { size: a.size, mtimeMs: a.mtimeMs, mode: a.mode }
  };
}
if (process.argv.includes("--capture") || process.argv.includes("--verify")) {
  void (async () => {
    const file = path.resolve(".parkbench/validation/feature025/native/controls-before.json");
    const current = await captureIopsBoundaries();
    if (process.argv.includes("--capture")) {
      fs.writeFileSync(file, JSON.stringify(current, null, 2));
      console.log(
        "native input metadata and unrelated controls captured; no private contents read"
      );
    } else {
      assert.deepEqual(current, JSON.parse(fs.readFileSync(file, "utf8")));
      fs.writeFileSync(
        path.join(path.dirname(file), "controls-preserved.json"),
        JSON.stringify(
          { status: "PASSED", checkedAt: new Date().toISOString(), ...current },
          null,
          2
        )
      );
      console.log("private inputs and unrelated container resource controls unchanged");
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
