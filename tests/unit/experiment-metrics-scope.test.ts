import assert from "node:assert/strict";
import test from "node:test";
import { ownedMetricSelectors } from "../../packages/metrics/src/prometheus-admin";

test("metric deletion uses positive immutable prior-revision and legacy scopes, never future executions", () => {
  const selectors = ownedMetricSelectors(
    "experiment-a",
    ["run-a"],
    [
      { run_id: "run-a", execution_revision: "old" },
      {
        container_label_parkbench_run_id: "run-a",
        container_label_parkbench_execution_revision: "older"
      },
      { experiment_id: "experiment-a", execution_revision: "old" }
    ]
  );
  assert.ok(selectors.includes('{run_id="run-a",execution_revision="old"}'));
  assert.ok(selectors.includes('{run_id="run-a",execution_revision=""}'));
  assert.ok(
    selectors.includes(
      '{container_label_parkbench_run_id="run-a",container_label_parkbench_execution_revision="older"}'
    )
  );
  assert.ok(selectors.includes('{experiment_id="experiment-a",execution_revision="old"}'));
  assert.ok(
    selectors.every((x) => !x.includes("!=") && !x.includes("=~") && !x.includes("replacement"))
  );
  assert.equal(new Set(selectors).size, selectors.length);
});

test("unsafe or foreign metric ownership cannot broaden a deletion request", () => {
  assert.throws(() => ownedMetricSelectors('experiment"escape', ["run-a"], []), /identity_invalid/);
  const selectors = ownedMetricSelectors(
    "experiment-a",
    ["run-a"],
    [
      { run_id: "foreign", execution_revision: "foreign-revision" },
      { experiment_id: "foreign", execution_revision: "foreign-revision" }
    ]
  );
  assert.ok(selectors.every((x) => !x.includes("foreign")));
});

test("revision inventory reads distinct values rather than whole metric-label histories", async () => {
  const { HttpExperimentMetricAdmin } = await import("../../packages/metrics/src/prometheus-admin");
  const requests: string[] = [];
  const fetcher = async (url: any) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ status: "success", data: ["old", "older"] }), {
      headers: { "Content-Type": "application/json" }
    });
  };
  const admin = new HttpExperimentMetricAdmin("http://fixture", 86400, fetcher as any);
  const scopes = await admin.inventory("experiment", ["target"]);
  assert.ok(requests.every((url) => url.includes("/label/") && !url.includes("/series")));
  assert.equal(requests.length, 4);
  assert.ok(scopes.includes('{run_id="target",execution_revision="older"}'));
  assert.ok(
    scopes.includes(
      '{container_label_parkbench_experiment_id="experiment",container_label_parkbench_execution_revision="old"}'
    )
  );
});
