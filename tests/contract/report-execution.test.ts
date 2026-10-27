import test from "node:test";
import assert from "node:assert/strict";
import { buildReportCompose } from "../../packages/compose-runner/src/report-compose";
import { extentAliases } from "../../apps/control-plane/src/reports/preflight";
for (const type of ["DBANALYS", "IDXANALYS", "TABANALYS"] as const)
  test(`fixed ${type} command analyzes a report-owned DB copy in the broker container`, () => {
    const bundle = buildReportCompose({
      reportId: "a",
      token: "b",
      directory: "/out",
      seedPath: "/seed-host",
      databaseName: "db",
      image: "db:12.8.11",
      type,
      aliases: []
    });
    const s = bundle.services.analysis;
    assert.equal(s.network_mode, "none");
    assert.equal(s.entrypoint[0], "/bin/sh");
    assert.match(s.entrypoint[2], /parkbench-db-entrypoint\.sh/);
    assert.match(s.entrypoint[2], /6\) break/);
    assert.match(s.entrypoint[2], /0\|64/);
    assert.deepEqual(s.command, [
      "/psc/dlc/bin/proutil",
      "/psc/wrk/db/db",
      "-C",
      type.toLowerCase(),
      "-csoutput",
      "-fieldsep",
      ",",
      "-verbose",
      "-csfilePrefix",
      "report"
    ]);
    assert.equal(s.environment.DB_NAME, "db");
    assert.equal(s.environment.PARKBENCH_DB_INIT_MODE, "seed");
    assert.equal(s.environment.PARKBENCH_DATABASE_RUN_CONTROLS, "");
    assert.deepEqual(Object.keys(bundle.services).sort(), ["analysis", "version"]);
    for (const service of Object.values(bundle.services) as any[]) {
      assert.equal(service.command.includes("-RO"), false);
      assert.equal(service.ports, undefined);
      const seed = service.volumes.find((v: any) => v.target === "/run/parkbench/seed/db");
      assert.equal(seed.read_only, true);
      assert.equal(seed.source, "/seed-host");
      assert.equal(
        service.volumes.some((v: any) => v.target === "/seed"),
        false
      );
      assert.equal(
        service.volumes.find((v: any) => v.target === "/psc/wrk").source,
        "/out/scratch"
      );
    }
  });
test("recorded extent targets fail closed", () => {
  for (const target of ["/", "/etc", "/reports", "/psc/dlc", "/tmp", "/work/../etc"]) {
    assert.throws(() =>
      extentAliases([{ path: target, file: "db.d1" }], new Set(["db.d1"]), "/seed-host")
    );
  }
  assert.deepEqual(
    extentAliases([{ path: "/psc/wrk/db.d1", file: "db.d1" }], new Set(["db.d1"]), "/seed-host"),
    ["/psc/wrk"]
  );
});
