import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDatabaseIopsOwner,
  validateDatabaseIopsCoverage,
  validateIopsRules
} from "../../packages/contracts/src/database-iops";
import { iopsOwner, iopsCoverage } from "../fixtures/database-iops";
test("rejects unowned target identity, escaped working paths and non-IOPS payloads", () => {
  assert.throws(() => validateDatabaseIopsOwner(iopsOwner({ component: "pas" }) as any));
  assert.throws(() => validateDatabaseIopsOwner(iopsOwner({ containerId: "short" }) as any));
  const c = iopsCoverage();
  c.devices[0].paths = ["/psc/wrk/fixture/../../seed/private"];
  assert.throws(() => validateDatabaseIopsCoverage(c));
  assert.throws(() =>
    validateIopsRules({ read: [{ Path: "/dev/disk", Rate: 150, Memory: 1 }], write: [] } as any)
  );
});
import {
  DatabaseIopsInspector,
  IOPS_PROBE_SCRIPT
} from "../../packages/compose-runner/src/database-iops-inspection";
test("wrong daemon, run, service, container and stale process never reach host inspection or update", async () => {
  const owner = iopsOwner();
  const labels = {
    "parkbench.managed": "true",
    "parkbench.run_id": owner.runId,
    "parkbench.component": "database",
    "com.docker.compose.project": owner.composeProject
  };
  const valid = {
    Id: owner.containerId,
    Config: { Labels: labels },
    State: { Running: true, Pid: owner.pid, StartedAt: owner.startedAt }
  };
  for (const alteration of [
    { daemon: "other" },
    { Id: "b".repeat(64) },
    { labels: { "parkbench.run_id": "other" } },
    { labels: { "parkbench.component": "pas" } },
    { labels: { "parkbench.component": "observer" } },
    { labels: { "parkbench.managed": "false" } },
    { labels: { "com.docker.compose.project": "foreign" } },
    { State: { Running: false, Pid: 0 } }
  ]) {
    let reads = 0,
      updates = 0;
    const data = {
      ...structuredClone(valid),
      ...alteration,
      Config: { Labels: { ...labels, ...alteration.labels } }
    };
    const api: any = {
      daemonId: owner.daemonId,
      versioned: (s: string) => s,
      inspect: async () => data,
      request: async () => {
        reads++;
        return { ID: alteration.daemon ?? owner.daemonId };
      },
      updateIops: async () => {
        updates++;
      }
    };
    await assert.rejects(
      new DatabaseIopsInspector(api, "never-execute").snapshot(
        owner.containerId,
        owner.composeProject,
        owner.runId,
        "fixture",
        Date.now() + 1000,
        true
      )
    );
    assert.equal(reads, 1);
    assert.equal(updates, 0);
  }
  assert.ok(
    !/\b(?:tee|chmod|chown)\b|>\s*[^&]/.test(IOPS_PROBE_SCRIPT.replaceAll("2>/dev/null", "")),
    "host probe only reads policy and identity"
  );
});
