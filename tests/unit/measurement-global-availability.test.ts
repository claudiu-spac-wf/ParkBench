import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

test("unconfigured memory limits require real zero readings and full physical member coverage", async () => {
  const { memoryLimitAvailability, globalQueryAvailabilityMatches } = await import(
    path.resolve("scripts/diagnostics/measurement-global-availability.mjs")
  );
  const ids = ["a".repeat(64), "b".repeat(64)];
  const diagnostics = {
    deployedRefs: Object.fromEntries(ids.map((id, i) => [`platform:service${i}:${id}`, "image"]))
  };
  const samples = ids.flatMap((id, i) =>
    [0, 5, 10, 15].map((timestamp) => ({
      timestamp,
      value: 0,
      labels: { id: "/docker/" + id, container_label_com_docker_compose_service: `service${i}` }
    }))
  );
  const options = {
    diagnostics,
    runId: "fresh",
    startMs: 0,
    endMs: 20000,
    cadenceSeconds: 5,
    acquisitionLagSeconds: 2
  };
  const query = {
    effectiveStartMs: 0,
    effectiveEndMs: 20000,
    sourceMetadata: { seriesCount: 0, evaluationPointCount: 0 }
  };
  const declaration = { emptyRule: "memory_limit_not_configured" };
  const accepted = (rows: typeof samples) =>
    globalQueryAvailabilityMatches(
      query,
      declaration,
      memoryLimitAvailability({ ...options, samples: rows }),
      diagnostics,
      "fresh"
    );
  assert.equal(accepted(samples), true);
  assert.equal(accepted([]), false);
  assert.equal(accepted(samples.filter((p) => p.labels.id.endsWith(ids[0]))), false);
  assert.equal(accepted(samples.filter((p) => p.timestamp !== 5 && p.timestamp !== 10)), false);
  assert.equal(accepted(samples.map((p, i) => (i ? p : { ...p, value: 4096 }))), false);
  assert.equal(
    accepted([...samples, { ...samples[0], labels: { ...samples[0].labels, id: "foreign" } }]),
    false
  );
});
