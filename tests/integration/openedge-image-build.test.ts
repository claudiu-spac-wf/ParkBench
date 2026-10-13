import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateBenchmarkImageManifest } from "../../packages/contracts/src";
import {
  dockerImageInspection,
  runOpenEdgeBuilder,
  zipEntry,
  zipEntryNames,
  syntheticImageManifest
} from "../helpers/openedge";

describe("OpenEdge image build integration", () => {
  it("accepts a final manifest made from explicit tag-only image references", () => {
    const manifest = syntheticImageManifest("final");
    for (const image of [manifest.db, manifest.pasoe, manifest.observer, manifest.jdk]) {
      image.reference = `${image.repository}:fixture`;
      delete image.digest;
    }
    assert.equal(
      validateBenchmarkImageManifest(manifest, true).db.reference,
      "parkbench/openedge-db:fixture"
    );
  });

  it(
    "builds and inspects the generic stage from licensed local prerequisites",
    { skip: !process.env.PARKBENCH_RUN_OPENEDGE_TESTS },
    () => {
      const outputRoot = path.resolve(
        process.env.PARKBENCH_OPENEDGE_OUTPUT_ROOT ?? ".parkbench/openedge"
      );
      runOpenEdgeBuilder("generic");
      const manifestPath = path.join(outputRoot, "stages/generic/manifest.json");
      assert.equal(fs.existsSync(manifestPath), true);
      const manifest = validateBenchmarkImageManifest(
        JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        false
      );
      assert.equal(manifest.imageStage, "generic");
      assert.equal(manifest.parkBenchReady, false);
      assert.ok(manifest.buildDurationMs >= 0);
      assert.equal(fs.existsSync(path.join(outputRoot, "manifest.json")), false);
      assert.equal(fs.existsSync(path.join(outputRoot, "images.env")), false);
      for (const image of [manifest.db, manifest.pasoe, manifest.observer, manifest.jdk]) {
        const inspection = dockerImageInspection(image.reference);
        assert.ok(inspection.Id);
      }
      const archive = path.join(outputRoot, manifest.runnerArchive.path);
      const outerEntries = zipEntryNames(archive);
      assert.deepEqual(outerEntries, ["ablapps/parkbench.zip"]);
      const appArchive = zipEntry(archive, "ablapps/parkbench.zip");
      assert.ok(appArchive);
      const appFile = path.join(outputRoot, "staging/generic/parkbench.zip");
      fs.writeFileSync(appFile, appArchive);
      const appEntries = zipEntryNames(appFile);
      assert.ok(appEntries.includes("openedge/ParkBenchWorkHandler.cls"));
      assert.ok(appEntries.includes("openedge/Workloads/.keep"));
      assert.ok(appEntries.includes("conf/MANIFEST.MF"));
      assert.ok(appEntries.includes("conf/startup.pf"));
      assert.ok(appEntries.includes("tlr/openedge.properties.merge"));
      assert.ok(appEntries.includes("webapps/parkbench.war"));
      const mergeProperties = zipEntry(appFile, "tlr/openedge.properties.merge")?.toString("utf8");
      assert.match(mergeProperties ?? "", /\[AppServer\.SessMgr\.oepas1\]/);
      // The DB connection is applied to conf/startup.pf when PAS starts (apply-db-connection.sh).
      assert.match(mergeProperties ?? "", /agentStartupParam=-pf \$\{catalina\.base\}\/ablapps\/parkbench\/conf\/startup\.pf/);
      assert.doesNotMatch(mergeProperties ?? "", /-db sports/);
      assert.match(mergeProperties ?? "", /\[oepas1\.parkbench\.WEB\]/);
      assert.match(mergeProperties ?? "", /handler1=ParkBenchWorkHandler: \/work/);
      assert.equal(fs.existsSync(path.join(outputRoot, "staging/generic/private")), false);
      assert.equal(fs.existsSync(path.join(outputRoot, "staging/generic/contexts")), false);
      fs.rmSync(appFile, { force: true });
    }
  );
});
