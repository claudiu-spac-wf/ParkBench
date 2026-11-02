import test from "node:test";
import assert from "node:assert/strict";
import { verifyIopsPolicy, applyIopsPolicy } from "../../packages/compose-runner/src/database-iops";
import {
  resolveDatabaseIops,
  pendingDatabaseIops,
  desiredIops
} from "../../packages/contracts/src/database-iops";
import { iopsCoverage } from "../fixtures/database-iops";
test("verification covers independent devices and rejects kernel/root/owner mismatch", () => {
  const coverage = iopsCoverage(129),
    condition = resolveDatabaseIops("hdd"),
    rules = desiredIops(condition, coverage);
  const kernel = Object.fromEntries(
    coverage.devices.map((d) => [d.id, { riops: 150, wiops: 150 }])
  );
  verifyIopsPolicy(condition, coverage, rules, kernel);
  assert.throws(() => verifyIopsPolicy(condition, coverage, rules, {}), /unconfirmed/);
  assert.throws(
    () =>
      verifyIopsPolicy(
        condition,
        coverage,
        rules,
        { ...kernel, "8:0": { riops: "max", wiops: 150 } },
        "measurement"
      ),
    /policy_drift/
  );
  assert.throws(
    () => verifyIopsPolicy(condition, coverage, { read: [], write: [] }, kernel),
    /unconfirmed/
  );
});
test("mutation awaits durable exact intent and revalidates after acknowledgement", async () => {
  const coverage = iopsCoverage(),
    condition = resolveDatabaseIops("hdd");
  const snapshot: any = {
    coverage,
    rules: { read: [], write: [] },
    kernel: {},
    capability: { apiVersion: "1.55" }
  };
  let updates = 0;
  let acknowledged = false;
  const api: any = {
    requireFinite() {},
    async updateIops(_id, rules) {
      assert.ok(acknowledged);
      updates++;
      snapshot.rules = rules;
      snapshot.kernel = { "8:0": { riops: 150, wiops: 150 } };
    }
  };
  const inspect = async () => structuredClone(snapshot);
  const args: any = {
    api,
    inspect,
    condition,
    runId: coverage.owner.runId,
    experimentId: "ex",
    variantId: "v",
    cancelled: () => false,
    deadline: Date.now() + 10000
  };
  await assert.rejects(
    applyIopsPolicy({
      ...args,
      persistIntent: async () => {
        throw Error("write_failed");
      }
    }),
    /apply_failed/
  );
  assert.equal(updates, 0);
  const evidence = await applyIopsPolicy({
    ...args,
    persistIntent: async (i) => {
      assert.equal(i.owner.containerId, coverage.owner.containerId);
      assert.equal(i.desiredIops.read[0].Rate, 150);
      acknowledged = true;
    }
  });
  assert.equal(updates, 1);
  assert.equal(evidence.verification.status, "MATCHED");
  snapshot.rules = { read: [], write: [] };
  snapshot.kernel = {};
  acknowledged = false;
  await assert.rejects(
    applyIopsPolicy({
      ...args,
      persistIntent: async () => {
        snapshot.coverage.owner.pid++;
        acknowledged = true;
      }
    })
  );
  assert.equal(updates, 1);
});
import { parseIopsProbe } from "../../packages/compose-runner/src/database-iops-inspection";
test("host probe binds working mounts and actual block nodes, not overlay root", () => {
  const owner = iopsCoverage().owner;
  const prefix = `OWNER\t${owner.pid}\t${owner.containerId}\nMAX\t8:0 riops=150 wiops=150\nDEVICE\t8:0\t/dev/fixture0\t8:0\t1\n`;
  const data =
    prefix +
    "MOUNT\t31 1 8:0 /data /psc/wrk rw - ext4 /dev/fixture0 rw\nMOUNT\t32 31 8:0 /alias /psc/wrk/fixture/temp rw - ext4 /dev/fixture0 rw\n";
  const parsed = parseIopsProbe(data, owner, "/psc/wrk/fixture");
  assert.equal(parsed.coverage.devices.length, 1);
  assert.equal(parsed.coverage.devices[0].paths.length, 2);
  assert.equal(parsed.coverage.devices[0].mountId, "31|32");
  assert.throws(() =>
    parseIopsProbe(data.replace("OWNER\t123", "OWNER\t124"), owner, "/psc/wrk/fixture")
  );
  assert.throws(() =>
    parseIopsProbe(data.replace("\t8:0\t1", "\t8:1\t1"), owner, "/psc/wrk/fixture")
  );
  assert.throws(() =>
    parseIopsProbe(
      prefix + "MOUNT\t31 1 0:72 / /psc/wrk rw - overlay overlay rw\n",
      owner,
      "/psc/wrk/fixture"
    )
  );
  assert.throws(() => parseIopsProbe("x".repeat(1048577), owner, "/psc/wrk/fixture"));
});
test("failed, missing, expired or cancelled persistence never authorizes mutation", async () => {
  for (const kind of ["missing", "rejected", "expired", "cancelled", "late"]) {
    const coverage = iopsCoverage();
    let updates = 0,
      cancelled = false;
    const snapshot: any = { coverage, rules: { read: [], write: [] }, kernel: {} };
    const api: any = {
      requireFinite() {},
      async updateIops() {
        updates++;
      }
    };
    const persist =
      kind === "missing"
        ? undefined
        : kind === "rejected"
          ? async () => {
              throw Error("private_secret");
            }
          : kind === "expired"
            ? async () => new Promise<void>(() => {})
            : kind === "late"
              ? async () => {
                  await new Promise((r) => setTimeout(r, 30));
                }
              : async () => {
                  cancelled = true;
                };
    await assert.rejects(
      applyIopsPolicy({
        api,
        inspect: async () => structuredClone(snapshot),
        condition: resolveDatabaseIops("hdd"),
        runId: coverage.owner.runId,
        experimentId: "ex",
        variantId: "v",
        cancelled: () => cancelled,
        persistIntent: persist as any,
        deadline: Date.now() + 20
      })
    );
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(updates, 0, kind);
  }
});
test("foreign IOPS rules are preserved by rejecting finite conflict; fresh Unlimited requires no capability", async () => {
  const coverage = iopsCoverage();
  let requests = 0;
  const api: any = {
    requireFinite() {
      requests++;
    },
    async updateIops() {
      requests++;
    }
  };
  const options: any = {
    api,
    inspect: async () => ({
      coverage,
      rules: { read: [{ Path: "/dev/foreign", Rate: 10 }], write: [] },
      kernel: {}
    }),
    condition: resolveDatabaseIops("hdd"),
    runId: coverage.owner.runId,
    experimentId: "ex",
    variantId: "v",
    cancelled: () => false,
    persistIntent: async () => {},
    deadline: Date.now() + 1000
  };
  await assert.rejects(applyIopsPolicy(options), /policy_conflict/);
  assert.equal(requests, 1);
  requests = 0;
  const unlimited = await applyIopsPolicy({ ...options, condition: resolveDatabaseIops() });
  assert.equal(unlimited.verification.status, "NO_ADDED_CAP");
  assert.equal(requests, 0);
});
import { checkIopsPolicy } from "../../packages/compose-runner/src/database-iops";
test("all finite policies verify every direction on independent data, BI, AI and temp devices", () => {
  const coverage = iopsCoverage(4);
  coverage.devices.forEach(
    (d, i) => (d.paths = [`/psc/wrk/fixture/${["data", "bi", "ai", "temp"][i]}`])
  );
  for (const preset of ["hdd", "sata-ssd", "slow-nvme", "fast-nvme"]) {
    const condition = resolveDatabaseIops(preset),
      rules = desiredIops(condition, coverage),
      kernel = Object.fromEntries(
        coverage.devices.map((d) => [
          d.id,
          { riops: condition.readIopsPerDevice, wiops: condition.writeIopsPerDevice }
        ])
      );
    verifyIopsPolicy(condition, coverage, rules, kernel);
    assert.throws(
      () =>
        verifyIopsPolicy(
          condition,
          coverage,
          rules,
          { ...kernel, "8:3": { riops: condition.readIopsPerDevice, wiops: "max" } },
          "cooldown"
        ),
      /policy_drift/
    );
  }
});
test("runtime rejects changed owner, start, device generation and late observations without any mutation", async () => {
  const coverage = iopsCoverage(),
    condition = resolveDatabaseIops("hdd"),
    rules = desiredIops(condition, coverage),
    snapshot: any = { coverage, rules, kernel: { "8:0": { riops: 150, wiops: 150 } } };
  for (const mutation of [
    (s: any) => s.coverage.owner.pid++,
    (s: any) => (s.coverage.owner.startedAt = "2026-11-02T00:01:00Z"),
    (s: any) => (s.coverage.owner.daemonId = "changed"),
    (s: any) => (s.coverage.devices[0].generation = "2"),
    (s: any) => (s.coverage.devices[0].mountId = "42")
  ]) {
    const changed = structuredClone(snapshot);
    mutation(changed);
    const e = pendingDatabaseIops(condition);
    e.coverage = coverage;
    await assert.rejects(
      checkIopsPolicy(async () => changed, e, "measurement"),
      /unconfirmed/
    );
  }
  const e = pendingDatabaseIops(condition);
  e.coverage = coverage;
  const start = Date.now();
  await assert.rejects(
    checkIopsPolicy(async () => new Promise(() => {}), e, "measurement"),
    /unconfirmed/
  );
  assert.ok(Date.now() - start < 750);
  assert.equal(e.verification.status, "UNAVAILABLE");
});

test("ignored, ambiguous and cancelled updates retain uncertainty and cannot become verified", async () => {
  for (const mode of ["ignored", "rejected", "cancelled"]) {
    const coverage = iopsCoverage();
    let cancelled = false,
      updates = 0;
    const api: any = {
      requireFinite() {},
      async updateIops() {
        updates++;
        if (mode === "rejected") throw Error("private-daemon-body");
        if (mode === "cancelled") cancelled = true;
      }
    };
    await assert.rejects(
      applyIopsPolicy({
        api,
        inspect: async () => ({ coverage, rules: { read: [], write: [] }, kernel: {} }),
        condition: resolveDatabaseIops("hdd"),
        runId: coverage.owner.runId,
        experimentId: "ex",
        variantId: "v",
        cancelled: () => cancelled,
        persistIntent: async () => {},
        deadline: Date.now() + 1000
      }),
      (error) => {
        assert.ok(!String(error).includes("private-daemon-body"));
        const e = (error as any).evidence;
        assert.equal(e.applicationOutcome, "POSSIBLY_APPLIED");
        assert.equal(e.failure.possiblyApplied, true);
        assert.equal(e.verification.status, "UNAVAILABLE");
        return true;
      }
    );
    assert.equal(updates, 1);
  }
});

test("unrecorded kernel caps and changes after durable acknowledgement authorize zero updates", async () => {
  for (const stage of ["before", "after-ack"]) {
    const coverage = iopsCoverage(),
      snapshot: any = { coverage, rules: { read: [], write: [] }, kernel: {} };
    let updates = 0;
    const foreign = { "8:0": { riops: 37, wiops: "max" } };
    if (stage === "before") snapshot.kernel = foreign;
    await assert.rejects(
      applyIopsPolicy({
        api: {
          requireFinite() {},
          async updateIops() {
            updates++;
          }
        },
        inspect: async () => structuredClone(snapshot),
        condition: resolveDatabaseIops("hdd"),
        runId: coverage.owner.runId,
        experimentId: "ex",
        variantId: "v",
        cancelled: () => false,
        persistIntent: async () => {
          snapshot.kernel = foreign;
        },
        deadline: Date.now() + 1000
      }),
      /policy_conflict/
    );
    assert.equal(updates, 0);
  }
});

test("owned clearing requires effective kernel removal as well as Engine metadata", async () => {
  const coverage = iopsCoverage(),
    condition = resolveDatabaseIops("hdd"),
    rules = desiredIops(condition, coverage);
  const { validateDatabaseIopsIntent } = await import("../../packages/contracts/src/database-iops");
  const prior = validateDatabaseIopsIntent({
    contractVersion: "database-iops-application-intent.v1",
    attemptId: "owned",
    experimentId: "ex",
    runId: coverage.owner.runId,
    variantId: "v",
    preparedAt: new Date().toISOString(),
    condition,
    owner: coverage.owner,
    coverage,
    previousIops: { read: [], write: [] },
    desiredIops: rules
  });
  const snapshot: any = { coverage, rules, kernel: { "8:0": { riops: 150, wiops: 150 } } };
  await assert.rejects(
    applyIopsPolicy({
      api: {
        requireFinite() {},
        async updateIops() {
          snapshot.rules = { read: [], write: [] };
        }
      },
      inspect: async () => structuredClone(snapshot),
      condition: resolveDatabaseIops("unlimited"),
      runId: coverage.owner.runId,
      experimentId: "ex",
      variantId: "v",
      cancelled: () => false,
      persistIntent: async () => {},
      deadline: Date.now() + 1000,
      ownedPrevious: prior
    }),
    (error) => {
      assert.match(String(error), /owned_rules_not_cleared/);
      assert.equal((error as any).evidence.verification.observed.kernel["8:0"].riops, 150);
      return true;
    }
  );
});
