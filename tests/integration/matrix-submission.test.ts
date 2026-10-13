import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { validateDatabaseStartupParameters } from "../../packages/contracts/src/database-startup";
import { createSeedFixture } from "../helpers/seed";

describe("control UI matrix submission boundaries", () => {
  it("assigns sequential names, rejects stale name previews, and orders the queue by start time", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-run-names",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const request = {
        runName: "DB_Cache",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [500] }],
        repetitions: 2
      };
      const first = platform.controlUi.preview(request);
      const stale = platform.controlUi.preview(request);
      assert.deepEqual(
        first.cells.items.map((cell) => cell.runName),
        ["run_db-cache-1", "run_db-cache-2"]
      );
      const submit = (preview: typeof first) =>
        platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
      const experiment = submit(first);
      assert.equal(experiment.name, "DB_Cache");
      assert.equal(platform.controlUi.getExperiment(experiment.id)?.name, "DB_Cache");
      assert.deepEqual(
        experiment.runs.map((run) => run.name),
        ["run_db-cache-1", "run_db-cache-2"]
      );
      for(const [index,item] of experiment.runs.entries()){
        assert.match(item.id,new RegExp(`^db-cache-${index+1}-[0-9a-f]{4}$`));
        const run=platform.repositories.getRun(item.id)!;
        assert.equal(run.environmentSnapshot?.runNumber,index+1);
        assert.equal(run.environmentSnapshot?.runNameBase,"db-cache");
        assert.equal(run.environmentSnapshot?.runName,item.name);
        assert.equal(run.composeProject,"parkbench-"+item.id);
      }
      assert.throws(() => submit(stale), /run_name_conflict_repreview/);
      const next = platform.controlUi.preview(request);
      assert.deepEqual(
        next.cells.items.map((cell) => cell.runName),
        ["run_db-cache-3", "run_db-cache-4"]
      );
      const second = submit(next);
      assert.equal(second.name, "DB_Cache");
      assert.deepEqual(
        platform.controlUi
          .listExperiments()
          .filter((item) => item.name === "DB_Cache")
          .map((item) => item.id),
        [experiment.id, second.id]
      );
      const thirdPreview = platform.controlUi.preview(request);
      const third = submit(thirdPreview);
      assert.deepEqual(
        third.runs.map((run) => run.name),
        ["run_db-cache-5", "run_db-cache-6"]
      );
      for (const id of [second.runs[1]!.id, ...third.runs.map((run) => run.id)]) {
        const metadata = platform.controlRepository.getRunMetadata(id)!;
        platform.controlRepository.saveRunMetadata({
          ...metadata,
          runId: id,
          snapshot: { ...metadata.snapshot, queuedAt: "2026-01-04T00:00:00.000Z" }
        });
      }
      for (const [id, startedAt] of [
        [experiment.runs[0]!.id, "2026-01-01T00:00:00.000Z"],
        [experiment.runs[1]!.id, "2026-01-03T00:00:00.000Z"],
        [second.runs[0]!.id, "2026-01-02T00:00:00.000Z"]
      ] as const) {
        const run = platform.repositories.getRun(id)!;
        run.startedAt = startedAt;
        platform.repositories.saveRun(run);
      }
      const queue = platform.controlUi.listQueue();
      assert.deepEqual(
        queue.slice(0, 3).map((run) => run.name),
        ["run_db-cache-2", "run_db-cache-3", "run_db-cache-1"]
      );
      assert.deepEqual(
        queue.slice(3).map((run) => run.name),
        ["run_db-cache-5", "run_db-cache-6", "run_db-cache-4"]
      );
      assert.equal(platform.repositories.getRun(experiment.runs[0]!.id)?.name, "run_db-cache-1");
    } finally {
      platform.close();
    }
  });
  it("allows resolved run inputs inside the configured container data root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-control-input-root-"));
    const seed = createSeedFixture(path.join(root, "seeds"));
    const archive = path.join(root, "application.zip");
    fs.writeFileSync(archive, "application fixture");
    const previousInputRoot = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: path.join(root, "artifacts"),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const preview = platform.controlUi.preview({
        runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [500] }],
        repetitions: 1,
        inputs: { seed, applicationArchive: archive }
      });

      const submitted = platform.controlUi.submit({
        previewId: preview.previewId,
        confirm: true
      });

      assert.equal(submitted.runCount, 1);
      assert.equal(
        platform.repositories.getRun(submitted.runs[0]!.id)?.environmentSnapshot.inputProvenance[0]
          ?.location,
        seed
      );
    } finally {
      platform.close();
      if (previousInputRoot === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
      else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previousInputRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes a file-only startup value across later source edits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-startup-source-"));
    const seed = createSeedFixture(path.join(root, "seeds"), "one_gb_lnx", { startupPf: "-B 500\n" });
    const previousInputRoot = process.env.PARKBENCH_CONTAINER_PATH_ROOT;
    process.env.PARKBENCH_CONTAINER_PATH_ROOT = root;
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: path.join(root, "artifacts"),
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const request = {
        runName: "file-only",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [],
        repetitions: 1,
        inputs: { seed }
      };
      const preview = platform.controlUi.preview(request);
      assert.equal(preview.runCount, 1);
      assert.deepEqual(
        preview.cells.items[0]?.databaseStartup?.parameters.map((item: any) => [
          item.name,
          item.displayValue,
          item.source
        ]),
        [["-B", "500", "startup_file"]]
      );
      assert.equal(preview.cells.items[0]?.databaseStartup?.parameters[0]?.sourceReference, "startup.pf:1");
      assert.equal(preview.cells.items[0]?.databaseStartup?.databaseName, "parkbench");
      const first = platform.controlUi.submit({ previewId: preview.previewId, confirm: true });
      const saved = validateDatabaseStartupParameters(
        platform.repositories.getRun(first.runs[0]!.id)!.environmentSnapshot.databaseStartup
      );
      assert.equal(saved.parameters[0].displayValue, "500");
      assert.equal(saved.parameters[0].source, "startup_file");
      const stale = platform.controlUi.preview({ ...request, runName: "changed-source" });
      fs.writeFileSync(path.join(seed, "startup.pf"), "-B 750\n");
      const frozenSubmission = platform.controlUi.submit({ previewId: stale.previewId, confirm: true });
      const frozenStartup = validateDatabaseStartupParameters(
        platform.repositories.getRun(frozenSubmission.runs[0]!.id)!.environmentSnapshot.databaseStartup
      );
      assert.equal(frozenStartup.parameters[0].displayValue, "500");
      assert.equal(frozenStartup.parameters[0].source, "startup_file");
    } finally {
      platform.close();
      if (previousInputRoot === undefined) delete process.env.PARKBENCH_CONTAINER_PATH_ROOT;
      else process.env.PARKBENCH_CONTAINER_PATH_ROOT = previousInputRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects configured images without catalog image assets", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-configured-image-submission",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: { dbImage: "parkbench/openedge-db:dev", pasImage: "parkbench/openedge-pasoe:dev" }
      },
      { testMode: true }
    );
    const databaseImage = "parkbench/openedge-db:dev";
    const pasImage = "parkbench/openedge-pasoe:dev";
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const preview = platform.controlUi.preview({
        runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [500] }],
        repetitions: 1
      });
      const submitted = platform.controlUi.submit({
        previewId: preview.previewId,
        confirm: true
      });

      assert.equal(submitted.runCount, 1);
      const runId = submitted.runs[0]?.id;
      assert.equal(typeof runId, "string");
      const metadata = platform.controlRepository.getRunMetadata(runId!);
      const assets = metadata?.snapshot.assets as Record<string, string> | undefined;
      assert.equal(assets?.databaseImage, databaseImage);
      assert.equal(assets?.pasImage, pasImage);
    } finally {
      platform.close();
    }
  });

  it("submits a confirmed preview with all matrix cells and repetitions", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-matrix-submission",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.startupRecovery;
      platform.scenarios.register(scenario);
      platform.controlUi.syncExistingScenarios();
      const preview = platform.controlUi.preview({
        runName: "test-run",
        scenario: { id: "crud-rest", version: "1.0.0" },
        dimensions: [{ name: "-B", values: [500, 1000] }],
        repetitions: 2
      });
      assert.equal(preview.runCount, 4);
      const submitted = platform.controlUi.submit(
        { previewId: preview.previewId, confirm: true },
        "matrix-submission-idempotency"
      );
      assert.equal(submitted.runCount, 4);
      assert.equal(submitted.baselineRunId, undefined);
      assert.deepEqual(
        submitted.runs.map((run) => [run.cellOrdinal, run.repetition]),
        [
          [0, 1],
          [0, 2],
          [1, 1],
          [1, 2]
        ]
      );
    } finally {
      platform.close();
    }
  });
});

it("number reservations share submission rollback, idempotency, direct creation and persistence", async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"parkbench-numbering-"));
 const config={host:"127.0.0.1",port:0,dbPath:path.join(root,"db.sqlite"),artifactRoot:path.join(root,"artifacts"),prometheusUrl:"http://localhost:9090",prometheusRetention:"7d",openedge:{}};
 let platform=createPlatform(config,{testMode:true});
 try {
  await platform.startupRecovery;platform.scenarios.register(scenario);
  const preview=platform.controlUi.preview({runName:"DB Cache",scenario:{id:scenario.id,version:scenario.version},dimensions:[{name:"-B",values:[500]}],repetitions:1});
  const save=platform.controlRepository.saveRunMetadata.bind(platform.controlRepository);
  platform.controlRepository.saveRunMetadata=()=>{throw new Error("injected metadata failure");};
  assert.throws(()=>platform.controlUi.submit({previewId:preview.previewId,confirm:true}),/injected/);
  assert.equal(platform.repositories.listAllRuns().length,0);
  platform.controlRepository.saveRunMetadata=save;
  const submitted=platform.controlUi.submit({previewId:preview.previewId,confirm:true},"numbered-idempotent");
  const again=platform.controlUi.submit({previewId:preview.previewId,confirm:true},"numbered-idempotent");
  assert.equal(again.runs[0].id,submitted.runs[0].id);assert.match(submitted.runs[0].id,/^db-cache-1-[a-f0-9]{4}$/);
  const request=platform.repositories.getExperiment(submitted.id)!;
  const direct=platform.coordinator.createExperiment({...request,scheduleName:"DB Cache",repetitions:2,variants:[request.variants[0]]},scenario as any);
  assert.deepEqual(platform.repositories.listRuns(direct.id).map(r=>r.name),["run_db-cache-2","run_db-cache-3"]);
  const ids=[...submitted.runs.map(r=>r.id),...direct.runIds];
  platform.close();platform=createPlatform(config,{testMode:true});await platform.startupRecovery;platform.scenarios.register(scenario);
  for(const [i,id] of ids.entries())assert.equal(platform.repositories.getRun(id)!.environmentSnapshot.runNumber,i+1);
  const next=platform.controlUi.preview({runName:"DB Cache",scenario:{id:scenario.id,version:scenario.version},dimensions:[{name:"-B",values:[500]}],repetitions:1});
  assert.equal(next.cells.items[0].runName,"run_db-cache-4");
  const final=platform.controlUi.submit({previewId:next.previewId,confirm:true});assert.match(final.runs[0].id,/^db-cache-4-[a-f0-9]{4}$/);
 } finally {platform.close();fs.rmSync(root,{recursive:true,force:true});}
});
