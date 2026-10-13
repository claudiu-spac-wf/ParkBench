import assert from "node:assert/strict";
import test from "node:test";
import { parameterPlan, readParameterPlan } from "../../packages/compose-runner/src/parameters";
import {
  resolveDatabaseRunControls,
  validateWriterCapacity,
  validateDatabaseRunControls
} from "../../packages/contracts/src/database-run-controls";

test("writers and cluster are strict run controls, never broker switches", () => {
  const p = parameterPlan({
    "-bibufs": 64,
    "database.apwCount": 2,
    "database.biClusterSizeMiB": 16,
    "database.biwEnabled": true
  });
  assert.deepEqual(p.databaseStartupArgs, ["-bibufs", "64"]);
  assert.equal(p.databaseEnvironment.PARKBENCH_APW_COUNT, "2");
  assert.equal(p.databaseEnvironment.PARKBENCH_BIW_ENABLED, "true");
  assert.equal(p.databaseEnvironment.PARKBENCH_BI_CLUSTER_KIB, "16384");
});
test("capability, precedence and connection capacity are explicit and never adjusted", () => {
  const controls = resolveDatabaseRunControls(
    { "database.apwCount": 2, "database.biwEnabled": true },
    { "database.apwCount": 0, "database.biwEnabled": false },
    { version: "12.8.11" }
  );
  assert.equal(controls.apwCount, 0);
  assert.equal(controls.biwEnabled, false);
  assert.equal(controls.sources.apwCount, "queued");
  assert.deepEqual(controls.biCluster, { mode: "inherit" });
  assert.throws(
    () =>
      resolveDatabaseRunControls(
        {},
        { "database.apwCount": 1 },
        { version: "12.8.11", features: [] }
      ),
    /database_writer_unavailable/
  );
  assert.throws(
    () => resolveDatabaseRunControls({}, { "database.biClusterSizeMiB": 16 }, { version: "13.0" }),
    /openedge_version_unverified/
  );
  const writers = resolveDatabaseRunControls(
    {},
    { "database.apwCount": 2, "database.biwEnabled": true },
    { version: "12.8.11", features: ["enterprise"] }
  );
  validateWriterCapacity(writers, 10, 7);
  assert.throws(
    () => validateWriterCapacity(writers, 9, 7),
    /database_writer_capacity_insufficient:required=10:available=9/
  );
  assert.equal(writers.apwCount, 2);
  assert.throws(
    () =>
      validateDatabaseRunControls({
        ...writers,
        biCluster: { mode: "override", requestedMiB: 16, nativeKiB: 512 }
      }),
    /cluster_conversion_mismatch/
  );
});
test("omission inherits cluster; explicit false/zero survives runtime translation", () => {
  const p = parameterPlan({ "database.apwCount": 0, "database.biwEnabled": false });
  assert.equal(p.databaseEnvironment.PARKBENCH_APW_COUNT, "0");
  assert.equal(p.databaseEnvironment.PARKBENCH_BIW_ENABLED, "false");
  assert.equal(p.databaseEnvironment.PARKBENCH_BI_CLUSTER_KIB, undefined);
});
test("exact fractional native increments pass without rounding", () => {
  for (const [m, k] of [
    [0.015625, 16],
    [0.5, 512],
    [16, 16384],
    [255.984375, 262128]
  ])
    assert.equal(
      parameterPlan({ "database.biClusterSizeMiB": m }).databaseEnvironment
        .PARKBENCH_BI_CLUSTER_KIB,
      String(k)
    );
});
test("invalid control types, counts and cluster increments are rejected", () => {
  for (const [key, values] of [
    ["database.apwCount", [-1, 10, 1.5, "2", null]],
    ["database.biClusterSizeMiB", [0, -1, 0.1, 256, NaN, Infinity, "16"]],
    ["database.biwEnabled", [0, 1, "false", null]]
  ] as Array<[string, unknown[]]>)
    for (const value of values)
      assert.throws(
        () => parameterPlan({ [key]: value }),
        /database_run_control_invalid/,
        `${key}=${String(value)}`
      );
  assert.throws(() => parameterPlan({ "-bibufs": 2 }), /database_parameter_invalid/);
  assert.deepEqual(parameterPlan({ "-bibufs": 3 }).databaseStartupArgs, ["-bibufs", "3"]);
  for (const n of [0, 9])
    assert.equal(
      parameterPlan({ "database.apwCount": n }).databaseEnvironment.PARKBENCH_APW_COUNT,
      String(n)
    );
});
test("legacy adapter records add neither writers nor required evidence policy", () => {
  const { databaseRunControls, contractVersion, ...old } = parameterPlan({ "-bibufs": 64 });
  const legacy = readParameterPlan({ ...old, contractVersion: "parameters.v1" });
  assert.equal(legacy.databaseRunControls.apwCount, 0);
  assert.equal(legacy.databaseRunControls.biwEnabled, false);
  assert.deepEqual(legacy.databaseRunControls.biCluster, { mode: "inherit" });
  assert.equal(legacy.databaseRunControls.requirements, undefined);
  assert.deepEqual(legacy.databaseStartupArgs, ["-bibufs", "64"]);
  assert.equal(legacy.databaseEnvironment.PARKBENCH_APW_COUNT, "0");
});
test("runtime readers reconstruct scalars from the frozen record and reject contradictory provenance", () => {
  const plan = parameterPlan({ "database.apwCount": 0, "database.biwEnabled": false });
  const read = readParameterPlan({
    ...plan,
    databaseEnvironment: {
      ...plan.databaseEnvironment,
      PARKBENCH_APW_COUNT: "9",
      PARKBENCH_BIW_ENABLED: "true",
      PARKBENCH_BI_CLUSTER_KIB: "16384"
    }
  });
  assert.equal(read.databaseEnvironment.PARKBENCH_APW_COUNT, "0");
  assert.equal(read.databaseEnvironment.PARKBENCH_BIW_ENABLED, "false");
  assert.equal(read.databaseEnvironment.PARKBENCH_BI_CLUSTER_KIB, undefined);
  for (const change of [
    { requested: { apwCount: 2, biwEnabled: false } },
    { sources: { ...plan.databaseRunControls.sources, apwCount: "default" } },
    { requested: {} }
  ])
    assert.throws(
      () => validateDatabaseRunControls({ ...plan.databaseRunControls, ...change }),
      /requested_source_mismatch/
    );
  assert.throws(
    () =>
      parameterPlan({ "database.apwCount": 2 }, { databaseRunControls: plan.databaseRunControls }),
    /conflict/
  );
});
