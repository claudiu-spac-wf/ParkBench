import test from "node:test";
import assert from "node:assert/strict";
import { parseIopsProbe } from "../../packages/compose-runner/src/database-iops-inspection";
import { checkIopsPolicy } from "../../packages/compose-runner/src/database-iops";
import {
  pendingDatabaseIops,
  resolveDatabaseIops,
  desiredIops,
  validateDatabaseIopsCoverage
} from "../../packages/contracts/src/database-iops";
import { iopsCoverage } from "../fixtures/database-iops";

const owner = iopsCoverage().owner;
function probe(secondParent = "254:0") {
  return `OWNER\t${owner.pid}\t${owner.containerId}
DEVICE\t254:0\t/dev/vda\tfe:0\t41
DEVICE\t254:1\t/dev/vda1\tfe:1\t41
DEVICE\t254:2\t/dev/vda2\tfe:2\t41
PARTITION\t254:1\t254:0\t2048\t100000
PARTITION\t254:2\t${secondParent}\t102048\t100000
MOUNT\t31 1 254:1 /data /psc/wrk rw - ext4 /dev/vda1 rw
MOUNT\t32 31 254:2 /temp /psc/wrk/fixture/temp rw - ext4 /dev/vda2 rw
MAX\t254:0 riops=150 wiops=150
`;
}
test("partitions resolve to the verified whole disk and deduplicate shared-parent caps", () => {
  const { coverage } = parseIopsProbe(probe(), owner, "/psc/wrk/fixture");
  assert.equal(coverage.devices.length, 1);
  const d = coverage.devices[0];
  assert.equal(d.id, "254:0");
  assert.equal(d.path, "/dev/vda");
  assert.deepEqual(d.paths, ["/psc/wrk/fixture", "/psc/wrk/fixture/temp"]);
  assert.deepEqual((d as any).partitions, [
    { id: "254:1", path: "/dev/vda1", start: "2048", size: "100000" },
    { id: "254:2", path: "/dev/vda2", start: "102048", size: "100000" }
  ]);
  assert.deepEqual(desiredIops(resolveDatabaseIops("hdd"), coverage).read, [
    { Path: "/dev/vda", Rate: 150 }
  ]);
});
test("partition mapping rejects missing or mismatched parent/block identity and ambiguous topology", () => {
  for (const text of [
    probe("254:16"),
    probe().replace("DEVICE\t254:0\t/dev/vda\tfe:0\t41\n", ""),
    probe().replace("fe:0", "fe:1"),
    probe().replace("PARTITION\t254:1\t254:0", "PARTITION\t254:1\t254:1"),
    probe().replace("2048\t100000", "-1\t100000"),
    probe() + "PARTITION\t254:1\t254:2\t2048\t100000\n",
    probe() + "PARTITION\t254:0\t254:2\t0\t100000\n",
    probe() + "DEVICE\t254:0\t/dev/wrong\tfe:0\t99\n"
  ])
    assert.throws(() => parseIopsProbe(text, owner, "/psc/wrk/fixture"));
});
test("partition geometry remains part of immutable runtime coverage", async () => {
  const condition = resolveDatabaseIops("hdd");
  const evidence = pendingDatabaseIops(condition);
  evidence.coverage = parseIopsProbe(probe(), owner, "/psc/wrk/fixture").coverage;
  const changed = parseIopsProbe(
    probe().replace("2048\t100000", "4096\t100000"),
    owner,
    "/psc/wrk/fixture"
  );
  await assert.rejects(
    checkIopsPolicy(
      async () => ({ ...changed, rules: desiredIops(condition, changed.coverage) }),
      evidence,
      "measurement"
    ),
    /unconfirmed/
  );
});
test("retained partition metadata rejects malformed and unbounded identities", () => {
  for (const partitions of [
    Array(16385).fill({}),
    [],
    [{ id: "0:1", path: "/dev/vda1", start: "0", size: "1" }],
    [{ id: "254:1", path: "/dev/../bad", start: "0", size: "1" }],
    [{ id: "254:1", path: "/dev/vda1", start: "0", size: "0" }]
  ]) {
    const c: any = iopsCoverage();
    c.devices[0].partitions = partitions;
    assert.throws(() => validateDatabaseIopsCoverage(c));
  }
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IOPS_BLOCK_PROBE_SCRIPT } from "../../packages/compose-runner/src/database-iops-inspection";
test("read-only sysfs resolver handles partition parents and rejects stacked or missing parents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-partition-sysfs-"));
  const disk = path.join(root, "sys/devices/block/vda");
  const partition = path.join(disk, "vda1");
  const index = path.join(root, "sys/dev/block");
  fs.mkdirSync(path.join(partition, "slaves"), { recursive: true });
  fs.mkdirSync(path.join(disk, "slaves"), { recursive: true });
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(disk, "dev"), "254:0\n");
  fs.writeFileSync(path.join(disk, "uevent"), "DEVNAME=vda\nDISKSEQ=41\n");
  fs.writeFileSync(path.join(partition, "uevent"), "DEVNAME=vda1\nDISKSEQ=41\n");
  fs.writeFileSync(path.join(partition, "partition"), "1\n");
  fs.writeFileSync(path.join(partition, "start"), "2048\n");
  fs.writeFileSync(path.join(partition, "size"), "100000\n");
  fs.symlinkSync(disk, path.join(index, "254:0"));
  fs.symlinkSync(partition, path.join(index, "254:1"));
  // Only block-node operations are faked; all topology/identity reads use the fixture sysfs.
  const program = `test() { if [ "$1" = -b ]; then return 0; fi; command test "$@"; }
stat() { case "$3" in */vda1) echo fe:1;; */vda) echo fe:0;; *) return 1;; esac; }
${IOPS_BLOCK_PROBE_SCRIPT.replaceAll("/proc/1/root", root)}
probe_block 254:1`;
  const run = () => spawnSync("sh", ["-c", program], { encoding: "utf8" });
  try {
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /PARTITION\t254:1\t254:0\t2048\t100000/);
    assert.match(good.stdout, /DEVICE\t254:0\t\/dev\/vda\tfe:0\t41/);
    fs.writeFileSync(path.join(disk, "slaves/stacked"), "");
    assert.equal(run().status, 29);
    fs.unlinkSync(path.join(disk, "slaves/stacked"));
    fs.unlinkSync(path.join(index, "254:0"));
    assert.equal(run().status, 29);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
