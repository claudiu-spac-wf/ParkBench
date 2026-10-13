import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  HttpPrometheusClient,
  type PrometheusClient
} from "../../packages/metrics/src/prometheus-client";
import { verifyRequiredSources } from "../../packages/metrics/src/required-sources";
import { loadConfig } from "../../packages/contracts/src/config";
import { createPlatform } from "../../apps/control-plane/src/platform";
import type { Run } from "../../packages/contracts/src/run";

const enabled = process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
test(
  "licensed v4 acquisition is retained by native tuple and missing evidence fails before publication",
  { skip: !enabled, timeout: 180000 },
  async () => {
    const id = process.env.PARKBENCH_NAMED_LATCH_TEST_RUN_ID;
    assert.ok(
      id,
      "provide PARKBENCH_NAMED_LATCH_TEST_RUN_ID from a completed licensed v4 acceptance run"
    );
    assert.match(id, /^[a-zA-Z0-9_-]+$/);
    const config = loadConfig();
    const artifactRoot = path.resolve(config.artifactRoot);
    const context = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, id, "run-context.v1.json"), "utf8")
    );
    const summaryRoot = path.join(artifactRoot, id, "summaries", "measurement-summary.v1");
    const summaries = fs
      .readdirSync(summaryRoot)
      .map((token) => path.join(summaryRoot, token, "comparison-summary.v1.json"))
      .filter((p) => fs.existsSync(p));
    assert.equal(summaries.length, 1, "one native retained summary");
    const summary = JSON.parse(fs.readFileSync(summaries[0], "utf8"));
    const header = summary;
    assert.equal(header.run.state, "SUCCEEDED");
    assert.equal(header.run.measurementValidity, "VALID");
    const observed = context.observed;
    const controls = context.effective.databaseRunControls;
    assert.equal(controls.requirements.observerProtocolVersion, 4);
    assert.equal(controls.requirements.namedLatchRequired, true);
    const inventories = observed.namedLatchInventories;
    assert.ok(inventories?.length);
    const native = inventories[0];
    assert.equal(native.runId, id);
    assert.equal(native.complete, true);
    assert.equal(native.authoritativePublisher, "endpoint");
    assert.ok(native.instances.length > 0 && native.instances.length <= 512);
    assert.ok(native.instances.every((t: any) => t.latch_name && t.latch_type && t.latch_id));
    const run: Run = {
      ...header.run,
      id,
      experimentId: header.run.experimentId,
      variantId: header.run.variantId,
      repetition: header.run.repetition,
      composeProject: "retained-native-proof",
      phaseBoundaries: observed.phaseBoundaries,
      resourceNamespace: {},
      cleanupStatus: "COMPLETE",
      environmentSnapshot: {
        ...observed,
        databaseRunControls: controls,
        scenario: context.scenario,
        metricContracts: { nativeDb: "openedge-db-observer.v4" },
        namedLatchInventories: structuredClone(inventories)
      }
    } as Run;
    const window = header.windows.measurement;
    const cadence = observed.sourceCadences?.nativeDatabaseRefreshSeconds ?? 5;
    const client = new HttpPrometheusClient(config.prometheusUrl);
    const verified = await verifyRequiredSources(client, run, window, cadence);
    assert.deepEqual(verified.gaps, []);
    const queries = verified.queries.filter(
      (q) => q.metricName.includes("latch_named_") || q.metricName.includes("latch_inventory")
    );
    assert.ok(
      queries.some(
        (q) =>
          q.metricName.endsWith("latch_named_waits_total") &&
          q.observed &&
          q.labelKeys.includes("latch_id")
      )
    );
    // Feature 021 P3 uses exactly the same licensed/native reduction as Grafana.
    const { createNamedLatchProjection } =
      await import("../../apps/control-plane/src/comparisons/named-latch-projection");
    const project = createNamedLatchProjection({ prometheusUrl: config.prometheusUrl });
    const projected = await project(
      run,
      { status: "READY", attemptToken: "retained-native", header },
      { metricId: "native_latch.waits", statistics: ["total"], selectors: {} }
    );
    assert.ok(projected.length > 0);
    assert.ok(projected.some((r) => r.value !== null && Number.isFinite(r.value) && r.value >= 0));
    assert.ok(
      projected.every(
        (r) => r.dimensions.latch_name && r.dimensions.latch_type && r.sourceReferences.length
      )
    );
    const p3 = path.resolve(".parkbench/validation/feature021/p3");
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(
      path.join(p3, "native-latch-projection.json"),
      JSON.stringify(
        {
          runId: id,
          returnedRows: projected.length,
          availableRows: projected.filter((r) => r.value !== null).length,
          identity: projected.map((r) => r.dimensions),
          window
        },
        null,
        2
      ) + "\n"
    );
    const selected = native.instances[0];
    const damaged: PrometheusClient = {
      health: () => client.health(),
      queryInstant: (q) => client.queryInstant(q),
      queryRange: (...args) => client.queryRange(...args),
      queryRawRange: async (...args) =>
        (await client.queryRawRange(...args)).filter(
          (s) =>
            !(
              s.metricName === "parkbench_openedge_db_latch_named_waits_total" &&
              s.labels.latch_id === selected.latch_id
            )
        )
    };
    const negative = await verifyRequiredSources(damaged, run, window, cadence);
    assert.ok(
      negative.gaps.some(
        (g) =>
          g.observerId === "required-source:named-latch" &&
          g.measurementId?.includes(selected.latch_id)
      )
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-native-latch-finalize-"));
    fs.mkdirSync(path.join(root, id), { recursive: true });
    for (const file of ["db-parameter-snapshot.json", "loadgen-summary.json"]) {
      const source = path.join(artifactRoot, id, file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, id, file));
    }
    const platform = createPlatform(
      { ...config, dbPath: ":memory:", artifactRoot: root },
      { testMode: true, prometheus: damaged }
    );
    let cleaned = false;
    try {
      const failed: Run = {
        ...run,
        state: "FINALIZING",
        measurementValidity: "PENDING",
        cleanupStatus: "PENDING",
        environmentSnapshot: structuredClone(run.environmentSnapshot)
      };
      delete failed.environmentSnapshot!.requiredSourceVerification;
      const result = await platform.finalizer.finalize(failed, {
        terminalState: "SUCCEEDED",
        start: Date.parse(window.start) / 1000,
        end: Date.parse(window.end) / 1000,
        measurementState: "completed",
        cleanup() {
          assert.notEqual(platform.repositories.getSummaryCache(id)?.status, "READY");
          cleaned = true;
        }
      });
      assert.equal(
        result.state,
        "FAILED",
        JSON.stringify({ reason: result.failureReason, gaps: result.completeness?.requiredGaps })
      );
      assert.equal(result.measurementValidity, "UNAVAILABLE");
      assert.equal(result.failureKind, "observer");
      assert.equal(
        result.failureCode,
        "named_latch_evidence_missing",
        JSON.stringify({ reason: result.failureReason, gaps: result.completeness?.requiredGaps })
      );
      assert.equal(result.cleanupStatus, "COMPLETE");
      assert.equal(cleaned, true);
      assert.equal(platform.repositories.getSummaryCache(id)?.status, "READY");
      assert.ok(platform.repositories.listArtifacts(id).some((a) => a.kind === "run_context"));
      assert.ok(fs.existsSync(path.join(root, id, "diagnostics.json")));
      const output = path.resolve(".parkbench/validation/feature021/p1/native-named-latches");
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(
        path.join(output, `${id}-acceptance.json`),
        JSON.stringify(
          {
            runId: id,
            protocolVersion: 4,
            nativeInventory: native,
            verificationQueries: queries,
            missingTuple: selected,
            failure: {
              state: result.state,
              validity: result.measurementValidity,
              kind: result.failureKind,
              code: result.failureCode,
              cleanup: result.cleanupStatus
            },
            requiredGaps: negative.gaps
          },
          null,
          2
        )
      );
    } finally {
      platform.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
