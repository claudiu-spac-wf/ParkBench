import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../../apps/control-plane/src/server";
import { actionFixture, deferred } from "../fixtures/experiment-actions";
import { validateActionRequest } from "../../packages/contracts/src/experiment-action";
test("action request contracts reject unconfirmed, oversized or edited schedules", () => {
  const request = {
    contractVersion: "experiment-action.v1",
    kind: "RERUN",
    confirm: true,
    expectedRevision: "revision"
  };
  assert.equal(validateActionRequest(request).kind, "RERUN");
  for (const extra of [
    { confirm: false },
    { expectedRevision: "" },
    { expectedRevision: "x".repeat(257) },
    { kind: "RETRY" },
    { settings: {} },
    { runIds: ["subset"] }
  ])
    assert.throws(() => validateActionRequest({ ...request, ...extra }), /request_invalid/);
});
test("confirmed actions return asynchronous no-store progress within two seconds and keep one idempotent identity", async () => {
  const f = await actionFixture();
  const app = buildServer(f.platform);
  try {
    await app.ready();
    f.terminal();
    const gate = deferred();
    const admin = f.platform.experimentActions.metricAdmin;
    const preflight = admin.preflight.bind(admin);
    admin.preflight = async () => {
      await gate.promise;
      await preflight();
    };
    const eligibility = await app.inject({
      method: "GET",
      url: `/api/v1/experiments/${f.submitted.id}/actions`
    });
    assert.equal(eligibility.statusCode, 200);
    assert.equal(eligibility.json().runCount, 4);
    const request = {
      contractVersion: "experiment-action.v1",
      kind: "RERUN",
      confirm: true,
      expectedRevision: eligibility.json().executionRevision
    };
    const start = performance.now();
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/experiments/${f.submitted.id}/actions`,
      headers: { "idempotency-key": "contract-rerun" },
      payload: request
    });
    assert.equal(accepted.statusCode, 202);
    assert.ok(performance.now() - start < 2000);
    assert.equal(accepted.headers["cache-control"], "no-store");
    const location = accepted.headers.location!;
    assert.ok(location);
    const statusStart = performance.now(),
      status = await app.inject({ method: "GET", url: String(location) });
    assert.equal(status.statusCode, 200);
    assert.ok(performance.now() - statusStart < 2000);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/experiments/${f.submitted.id}/actions`,
      headers: { "idempotency-key": "contract-rerun" },
      payload: request
    });
    assert.equal(duplicate.json().id, accepted.json().id);
    assert.equal(status.json().status, "PENDING");
    gate.resolve();
    await f.platform.experimentActions.idle();
  } finally {
    await app.close();
  }
});

test("bad, stale and active admissions never mutate data; REMOVE supports queued incomplete schedules", async () => {
  const f = await actionFixture(),
    app = buildServer(f.platform);
  try {
    await app.ready();
    const url = `/api/v1/experiments/${f.submitted.id}/actions`,
      revision = f.platform.experimentActions.repository.currentRevision(f.submitted.id),
      body = {
        contractVersion: "experiment-action.v1",
        kind: "REMOVE",
        confirm: true,
        expectedRevision: revision
      };
    for (const [payload, key, status] of [
      [{ ...body, confirm: false }, "bad", 400],
      [body, undefined, 400],
      [{ ...body, expectedRevision: "old" }, "stale", 409]
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url,
        headers: key ? { "idempotency-key": key } : {},
        payload
      });
      assert.equal(r.statusCode, status);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal(f.platform.repositories.listRuns(f.submitted.id).length, 4);
    }
    const r = await app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": "remove-contract" },
      payload: body
    });
    assert.equal(r.statusCode, 202);
    await f.platform.experimentActions.idle();
    assert.equal(f.platform.repositories.getExperiment(f.submitted.id), undefined);
    const replay = await app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": "remove-contract" },
      payload: body
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().id, r.json().id);
  } finally {
    await app.close();
    f.close();
  }
});
