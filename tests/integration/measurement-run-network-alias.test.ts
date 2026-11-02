import test from "node:test";
import assert from "node:assert/strict";
import { generateRunCompose } from "../../packages/compose-runner/src/run-compose";
import { qualifyRunServiceUrl } from "../../apps/control-plane/src/runs/coordinator";
import scenario from "../../examples/scenarios/parkbench-bank-mix.json";
const environment = { PARKBENCH_CONTAINER_PATH_ROOT: "/var/lib/parkbench" };
function bundle(runId: string) {
  return generateRunCompose(
    runId,
    "public-experiment",
    scenario as any,
    { db: "parkbench/database:test", pas: "parkbench/pas:test" },
    {
      loadgenImage: "parkbench/loadgen:test",
      observerImage: "parkbench/observer:test",
      dbObserverImage: "parkbench/native:test"
    }
  );
}
test("valid long run identities produce resolvable DNS labels shared by Compose and controller URLs", () => {
  for (const runId of [
    "f024-h1-deadline2-read-timeout-5s-1-1-9da6",
    "a".repeat(90) + "-one",
    "a".repeat(90) + "-two"
  ]) {
    const generated = bundle(runId);
    const hosts = [];
    for (const service of ["loadgen", "db-observer", "pas-observer", "file-sampler"]) {
      const host = new URL(qualifyRunServiceUrl(`http://${service}:9100`, generated, environment))
        .hostname;
      assert.ok(host.length <= 63, `${service} generated a ${host.length}-character DNS label`);
      assert.match(host, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      assert.ok(
        generated.file.includes(`          - ${host}\n`),
        "the qualified HTTP destination must be a registered network alias"
      );
      hosts.push(host);
    }
    assert.equal(new Set(hosts).size, 4);
  }
  const first = new URL(
    qualifyRunServiceUrl("http://db-observer:9100", bundle("a".repeat(90) + "-one"), environment)
  ).hostname;
  const second = new URL(
    qualifyRunServiceUrl("http://db-observer:9100", bundle("a".repeat(90) + "-two"), environment)
  ).hostname;
  assert.notEqual(first, second, "shortening must preserve the distinct run namespaces");
});
test("short existing aliases and localhost observer-port routing stay stable", () => {
  const generated = bundle("public-short");
  assert.equal(
    new URL(qualifyRunServiceUrl("http://db-observer:9100", generated, environment)).hostname,
    generated.projectName + "-db-observer"
  );
  generated.observerPorts = { "db-observer": 32123 };
  assert.equal(
    qualifyRunServiceUrl("http://db-observer:9100/metrics", generated, {}),
    "http://127.0.0.1:32123/metrics"
  );
});
