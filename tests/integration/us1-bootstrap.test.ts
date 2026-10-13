import { describe, it } from "node:test";
import assert from "node:assert";
import { pasReplicaServices } from "../../packages/compose-runner/src";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { buildServer } from "../../apps/control-plane/src/server";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { FakeRunOrchestrator } from "../../packages/compose-runner/src";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
describe("bootstrap", () => {
  it("requires all six persistent services before reporting overall readiness", async () => {
    const helperUrl = pathToFileURL(
      path.join(process.cwd(), "scripts/bootstrap-readiness.mjs")
    ).href;
    const script = `
      import { checkRequiredServices } from ${JSON.stringify(helperUrl)};
      const allReady = await checkRequiredServices(async () => true);
      const oneMissing = await checkRequiredServices(async (service) => service !== "cadvisor");
      console.log(JSON.stringify({ allReady, oneMissing }));
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    );
    assert.equal(result.allReady.ready, true);
    assert.deepEqual(Object.keys(result.allReady.services).sort(), [
      "cadvisor",
      "control-plane",
      "grafana",
      "node-exporter",
      "prometheus",
      "web-ui"
    ]);
    assert.equal(result.oneMissing.ready, false);
    assert.equal(result.oneMissing.services.cadvisor, "not_ready");
    assert.equal(result.oneMissing.services["control-plane"], "ready");
  });

  it("supports a bounded PAS topology", () => {
    assert.deepEqual(pasReplicaServices(2), ["pas-1", "pas-2"]);
  });

  it("persists a run-owned bootstrap and reports readiness", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-bootstrap-")),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    platform.scenarios.register(scenario as any);
    const app = buildServer(platform);
    const response: any = await app.inject({
      method: "POST",
      url: "/api/v1/environments/bootstrap",
      payload: {
        scenario,
        inputs: {
          databaseImage:
            "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          pasImage:
            "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          seed: "input:seed/fixture",
          applicationArchive: "input:archive/fixture"
        }
      }
    });
    assert.equal(response.statusCode, 202);
    const accepted = JSON.parse(response.body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status: any = await app.inject({
      method: "GET",
      url: `/api/v1/environments/${accepted.environmentId}`
    });
    assert.equal(JSON.parse(status.body).state, "READY");
    const statusDocument = JSON.parse(status.body);
    assert.equal(typeof statusDocument.composeProject, "string");
    assert.equal(statusDocument.inputProvenance.length, 2);
    assert.equal(typeof statusDocument.resolvedImages.loadgen.reference, "string");
    assert.equal(statusDocument.readiness.state, "READY");
    assert.ok(statusDocument.readiness.transitions.length >= 3);
    assert.ok(statusDocument.resources.length > 0);
    const closed = await platform.bootstrap.close(accepted.environmentId);
    assert.equal(closed.cleanupStatus, "COMPLETE");
    assert.equal(closed.readiness?.state, "CLEANED");
    await app.close();
  });

  it("persists failed bootstrap cleanup and retries it on startup reconciliation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-bootstrap-retry-"));
    const orchestrator = new FakeRunOrchestrator();
    orchestrator.ready = false;
    orchestrator.cleanupFailure = true;
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: root,
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true, orchestrator }
    );
    const request: any = {
      scenario: { id: scenario.id, version: scenario.version },
      comparisonMode: "exploratory",
      repetitions: 1,
      variants: [{ id: "bootstrap", name: "Bootstrap", parameters: {} }],
      inputs: {
        databaseImage:
          "db:fixture@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        pasImage:
          "pas:fixture@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        seed: "input:seed/fixture",
        applicationArchive: "input:archive/fixture"
      }
    };
    const initial = await platform.bootstrap.create(request, scenario as any);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const failed = platform.bootstrap.get(initial.environmentId)!;
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.cleanupStatus, "FAILED");
    assert.ok(failed.resources?.length);
    orchestrator.cleanupFailure = false;
    assert.equal(await platform.bootstrap.retryPendingCleanup(), 1);
    const recovered = platform.bootstrap.get(initial.environmentId)!;
    assert.equal(recovered.cleanupStatus, "COMPLETE");
    assert.equal(recovered.readiness?.state, "CLEANED");
    platform.close();
  });
});
