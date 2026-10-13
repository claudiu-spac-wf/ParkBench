import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPENEDGE_WORKLOAD_TIMEOUT_MS,
  validateBenchmarkImageManifest
} from "../../packages/contracts/src";
import {
  createOpenEdgeFixtureWorkloadRoot,
  postOpenEdgeWork,
  runOpenEdgeBuilder,
  temporaryOpenEdgeRoot,
  waitForOpenEdgeHealth,
  zipEntryNames
} from "../helpers/openedge";

const liveEnabled = Boolean(process.env.PARKBENCH_RUN_OPENEDGE_TESTS);
const cleanupRoots: string[] = [];
let preparation: Promise<LiveContext> | undefined;

interface LiveContext {
  baseUrl: string;
  outputRoot: string;
  manifest: any;
}

describe("OpenEdge workload runner integration", () => {
  after(() => {
    for (const root of cleanupRoots) fs.rmSync(root, { recursive: true, force: true });
  });

  it(
    "builds the final image and invokes successful, failing, and missing workloads",
    { skip: !liveEnabled },
    async () => {
      const context = await prepareLiveImage();
      assert.equal(context.manifest.imageStage, "final");
      assert.equal(context.manifest.parkBenchReady, true);
      assert.ok(context.manifest.totalBuildDurationMs >= 0);
      assert.ok(
        context.manifest.workloads.some((item: any) => item.procName.endsWith("success.p"))
      );
      assert.ok(
        context.manifest.workloads.some((item: any) => item.procName.endsWith("arbitrary_reads.p"))
      );

      const success = await postOpenEdgeWork(context.baseUrl, "Workloads/Fixture/success.p", {
        marker: "parkbench"
      });
      assert.equal(success.status, 200);
      assert.equal(success.body.ok, true);
      assert.equal(success.body.procName, "Workloads/Fixture/success.p");
      assert.ok(success.body.elapsedMs >= 0);

      const genericRead = await postOpenEdgeWork(
        context.baseUrl,
        "Workloads/Generic/arbitrary_reads.p",
        { mode: "run", TableName: "CustomerContact", WhereClause: "RandomInt100 = 1", Limit: 1 }
      );
      assert.equal(genericRead.status, 200);
      assert.equal(genericRead.body.ok, true);

      const failure = await postOpenEdgeWork(context.baseUrl, "Workloads/Fixture/failure.p", {
        marker: "parkbench"
      });
      assert.equal(failure.status, 500);
      assert.equal(failure.body.ok, false);
      assert.equal(failure.body.error, "workload_failed");
      if ("detail" in failure.body) assert.match(failure.body.detail, /^[A-Za-z0-9_.:-]{1,200}$/);

      const rejected = await postOpenEdgeWork(context.baseUrl, "Workloads/../Fixture/failure.p", {
        marker: "parkbench"
      });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error, "unsafe_proc_name");

      const missing = await postOpenEdgeWork(context.baseUrl, "Workloads/Fixture/missing.p", {
        marker: "parkbench"
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "workload_not_found");
    }
  );

  it(
    "covers timeout, no-response, malformed archive, and signature boundaries",
    { skip: !liveEnabled },
    async () => {
      const context = await prepareLiveImage();
      const timeout = await postOpenEdgeWork(
        context.baseUrl,
        "Workloads/Fixture/cooperative-timeout.p",
        null,
        OPENEDGE_WORKLOAD_TIMEOUT_MS + 5_000
      );
      assert.ok(timeout.timedOut || timeout.status === 408);
      assert.ok(timeout.elapsedMs >= OPENEDGE_WORKLOAD_TIMEOUT_MS - 500);
      if (!timeout.timedOut) assert.equal(timeout.body.error, "workload_timeout");

      const noResponseBase = (
        process.env.PARKBENCH_OPENEDGE_TEST_NO_RESPONSE_URL ?? context.baseUrl
      ).replace(/\/$/, "");
      const noResponse = await postOpenEdgeWork(
        noResponseBase,
        "Workloads/Fixture/no-response.p",
        null,
        OPENEDGE_WORKLOAD_TIMEOUT_MS + 5_000
      );
      assert.ok(noResponse.timedOut || noResponse.status === 408);
      assert.ok(noResponse.elapsedMs >= OPENEDGE_WORKLOAD_TIMEOUT_MS - 500);
      if (!noResponse.timedOut) assert.equal(noResponse.body.error, "workload_timeout");

      const brokenParent = temporaryOpenEdgeRoot();
      const brokenRoot = path.join(brokenParent, "malformed");
      fs.mkdirSync(brokenRoot, { recursive: true });
      const brokenArchive = path.join(brokenRoot, "malformed.zip");
      fs.writeFileSync(brokenArchive, "not-a-zip");
      assert.throws(() => zipEntryNames(brokenArchive), /zip_end_record_missing/);

      const loadModule = Function("specifier", "return import(specifier)") as (
        specifier: string
      ) => Promise<any>;
      const runner = await loadModule(
        pathToFileURL(path.resolve("scripts/openedge/package-runner.mjs")).href
      );
      assert.throws(
        () => runner.discoverWorkloads(path.resolve("tests/fixtures/openedge/invalid")),
        /workload_signature_invalid/
      );
      fs.rmSync(brokenParent, { recursive: true, force: true });
    }
  );
});

async function prepareLiveImage(): Promise<LiveContext> {
  if (preparation) return preparation;
  preparation = (async () => {
    for (const variable of [
      "PARKBENCH_OPENEDGE_JDK_IMAGE",
      "PARKBENCH_OPENEDGE_COMPILER",
      "PARKBENCH_OPENEDGE_TEST_BASE_URL"
    ])
      assert.ok(process.env[variable], `${variable} is required when live tests are enabled`);

    const workloadRoot = createOpenEdgeFixtureWorkloadRoot();
    const outputParent = temporaryOpenEdgeRoot();
    const outputRoot = path.join(outputParent, "output");
    fs.mkdirSync(outputRoot, { recursive: true });
    cleanupRoots.push(path.dirname(workloadRoot), outputParent);
    const environment = {
      PARKBENCH_OPENEDGE_WORKLOAD_ROOT: workloadRoot,
      PARKBENCH_OPENEDGE_OUTPUT_ROOT: outputRoot
    };
    runOpenEdgeBuilder("all", environment);
    const manifestPath = path.join(outputRoot, "manifest.json");
    assert.equal(fs.existsSync(manifestPath), true);
    const genericManifestPath = path.join(outputRoot, "stages/generic/manifest.json");
    assert.equal(fs.existsSync(genericManifestPath), true);
    const genericManifest = JSON.parse(fs.readFileSync(genericManifestPath, "utf8"));
    assert.equal(genericManifest.imageStage, "generic");
    assert.equal(genericManifest.parkBenchReady, false);
    const manifest = validateBenchmarkImageManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      true
    );
    assert.notEqual(manifest.pasoe.reference, genericManifest.pasoe.reference);
    assert.ok(manifest.workloads.every((workload: any) => workload.compiled === true));
    const baseUrl = normalizeBaseUrl(process.env.PARKBENCH_OPENEDGE_TEST_BASE_URL!);
    await waitForOpenEdgeHealth(baseUrl);
    return { baseUrl, outputRoot, manifest };
  })();
  return preparation;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}
