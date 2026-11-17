import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EngineApi } from "../../packages/compose-runner/src/engine-api";
const enabled =
  process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1" && process.env.PARKBENCH_RUN_IOPS_TESTS === "1";
const execute = promisify(execFile),
  pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const terminal = new Set([
  "SUCCEEDED",
  "THRESHOLD_FAILED",
  "FAILED",
  "INCOMPLETE",
  "CANCELLED",
  "INTERRUPTED"
]);
const profiles = [
  { id: "biw-finite", apws: 0, preset: "sata-ssd-t1", setup: true },
  { id: "apw9-finite", apws: 9, preset: "sata-ssd-t1", setup: false },
  { id: "apw9-unlimited", apws: 9, preset: "unlimited", setup: false }
];
async function docker(args: string[]) {
  return (await execute("docker", args, { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
class NativeWriterCampaign {
  origin = new URL(process.env.PARKBENCH_CONTROL_API_URL ?? "http://127.0.0.1:13000");
  root = path.resolve(".parkbench/validation/feature026/writers");
  owned = new Set<string>();
  records: any[] = [];
  campaignId = `${process.env.PARKBENCH_WRITER_CAMPAIGN ?? "confirmation"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  sourceId = "";
  async api(
    method: string,
    route: string,
    body?: unknown,
    key = crypto.randomUUID()
  ): Promise<any> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(this.origin.origin + "/api/v1" + route, {
          method,
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(method === "POST" ? 360000 : 30000)
        });
        break;
      } catch {
        if (method !== "GET" || attempt === 2) throw Error("native_writer_api_unavailable");
        await pause(1000);
      }
    }
    const bytes = await response!.arrayBuffer();
    assert.ok(bytes.byteLength <= 8 * 1024 * 1024);
    if (!response!.ok) throw Error(`native_writer_http_${response!.status}:${route}`);
    return JSON.parse(Buffer.from(bytes).toString());
  }
  save() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(
      path.join(this.root, `${this.campaignId}.json`),
      JSON.stringify(
        {
          startedOrUpdatedAt: new Date().toISOString(),
          ownedRunIds: [...this.owned],
          records: this.records
        },
        null,
        2
      )
    );
  }
  async prepare() {
    assert.ok(["localhost", "127.0.0.1"].includes(this.origin.hostname));
    const assets = await this.api("GET", "/catalog/assets?category=scenarios&pageSize=250");
    const requested = process.env.PARKBENCH_WRITER_SCENARIO_SOURCE_ID;
    this.sourceId = (
      requested
        ? assets.items.find((a: any) => a.id === requested)
        : assets.items.find((a: any) =>
            Buffer.from(a.id.replace(/^discovery_file_/, ""), "base64url")
              .toString()
              .endsWith("parkbench-banking-writes.json")
          )
    )?.id;
    assert.ok(this.sourceId, "installed original workload required");
  }
  async idle() {
    const deadline = Date.now() + 120000;
    while (true) {
      const q = await this.api("GET", "/queue");
      if (!q.activeExperiment && !q.items.length) return;
      assert.ok(!q.items.length, "never start unrelated queue work");
      assert.ok(
        this.records.some((r) => r.experimentId === (q.activeExperiment?.id ?? q.activeExperiment)),
        "native writer host is occupied by unrelated work"
      );
      assert.ok(Date.now() < deadline, "owned host claim did not settle");
      await pause(1000);
    }
  }
  async schedule(profile: (typeof profiles)[number], suffix: string) {
    await this.idle();
    const name = `f026-${profile.id}-${suffix}-${crypto.randomUUID().slice(0, 8)}`;
    const preview = await this.api("POST", "/experiments/preview", {
      contractVersion: "experiment-schedule.v2",
      runName: name,
      scenarioSourceId: this.sourceId,
      dimensions: [{ name: "storage.databaseIopsPreset", values: [profile.preset] }],
      fixedOverrides: {
        ...(process.env.PARKBENCH_WRITER_CAMPAIGN === "gate-proof" ? {} : { "-B": 251072 }),
        "-basetable": -361,
        "-n": 200,
        "-tablerangesize": 1500,
        "database.biClusterSizeMiB": 255,
        "database.biwEnabled": true,
        "database.apwCount": profile.apws
      },
      repetitions: 1,
      inputs: {
        seed: process.env.PARKBENCH_WRITER_SEED_REF ?? "input:seeds/twentyeight_gb_lnx",
        applicationArchive:
          process.env.PARKBENCH_WRITER_ARCHIVE_REF ?? "input:archives/parkbench-runner.zip"
      },
      ...(profile.setup
        ? {
            databaseSetup: {
              contractVersion: "database-setup.v1",
              steps: [
                {
                  id: "writer-index-build",
                  definitionId: "idxbuild",
                  optionSets: [{ id: "all-indexes", scope: "all" }]
                }
              ]
            }
          }
        : {})
    });
    assert.equal(preview.runCount, 1);
    const experiment = await this.api(
        "POST",
        "/experiments/submit",
        { previewId: preview.previewId, confirm: true },
        name
      ),
      id = experiment.runs[0].id;
    this.owned.add(id);
    const record: any = {
      profile: profile.id,
      experimentId: experiment.id,
      runId: id,
      setup: profile.setup,
      kind: suffix,
      startedAt: new Date().toISOString()
    };
    this.records.push(record);
    this.save();
    await this.api("POST", "/queue/start", {});
    return record;
  }
  async container(run: any) {
    const name = `${run.composeProject}-database-1`,
      [actual] = JSON.parse(await docker(["inspect", name]));
    assert.equal(actual.Config.Labels["parkbench.run_id"], run.id);
    assert.equal(actual.Config.Labels["parkbench.execution_revision"], run.executionRevision);
    assert.equal(actual.Config.Labels["parkbench.component"], "database");
    return actual;
  }
  async observe(
    record: any,
    fault?: "writer-loss" | "capture-unavailable" | "cancel" | "policy-drift",
    gateProof = false
  ) {
    const deadline = Date.now() + 90 * 60000;
    let injected = false,
      last = "";
    while (Date.now() < deadline) {
      const run = await this.api("GET", "/runs/" + record.runId);
      if (run.state !== last) {
        console.log(`${record.profile} ${record.kind} ${run.id}: ${run.state}`);
        last = run.state;
      }
      if (fault && !injected && run.state === "MEASURING") {
        const container = await this.container(run),
          db = run.environmentSnapshot.inputs.databaseName ?? "parkbench";
        if (fault === "writer-loss") {
          const state = JSON.parse(
            await docker(["exec", container.Id, "cat", `/psc/wrk/${db}/database-run-controls.json`])
          );
          const writer = state.observed.writers.find((w: any) => w.type === "APW");
          assert.ok(writer);
          assert.ok(Number.isSafeInteger(writer.pid) && writer.pid > 1);
          const checked = state.processChecks.find((p: any) => p.pid === writer.pid);
          assert.ok(checked?.matched && Number.isSafeInteger(checked.startIdentity));
          await docker([
            "exec",
            container.Id,
            "sh",
            "-ec",
            `test "$(awk '{print $22}' /proc/${writer.pid}/stat)" = '${checked.startIdentity}'; kill -TERM ${writer.pid}`
          ]);
        }
        if (fault === "capture-unavailable")
          await docker([
            "exec",
            "-u",
            "0",
            container.Id,
            "mv",
            "/usr/local/lib/parkbench/parkbench-db-startup-state.r",
            "/usr/local/lib/parkbench/parkbench-db-startup-state.r.validation-disabled"
          ]);
        if (fault === "cancel") await this.api("POST", `/queue/runs/${run.id}/cancel`, {});
        if (fault === "policy-drift") {
          const e = run.environmentSnapshot.databaseIopsEvidence;
          const full = await this.api("GET", `/runs/${run.id}/artifacts/${e.artifactId}`);
          assert.equal(full.applicationIntent.owner.containerId, container.Id);
          const api = await EngineApi.forDocker();
          const rules = structuredClone(full.applicationIntent.desiredIops);
          for (const rule of [...rules.read, ...rules.write])
            rule.Rate = Math.max(1, Number(rule.Rate) - 1);
          await api.updateIops(container.Id, rules);
        }
        record.injection = { kind: fault, at: new Date().toISOString(), containerId: container.Id };
        injected = true;
        this.save();
      }
      if (
        terminal.has(run.state) &&
        ["COMPLETE", "FAILED", "PARTIAL"].includes(run.cleanupStatus)
      ) {
        const detail = await this.api("GET", "/history/runs/" + record.runId),
          snapshot = detail.run.environmentSnapshot,
          iops = snapshot.databaseIopsEvidence,
          full = iops?.artifactId
            ? await this.api("GET", `/runs/${run.id}/artifacts/${iops.artifactId}`)
            : undefined;
        Object.assign(record, {
          state: run.state,
          failureCode: run.failureCode,
          measurementValidity: run.measurementValidity,
          cleanupStatus: run.cleanupStatus,
          completeness: run.completeness,
          phaseBoundaries: run.phaseBoundaries,
          declaredPhases: snapshot.scenario.phases,
          controls: snapshot.databaseRunControls?.requested,
          writerEvidence: snapshot.databaseRunControlEvidence,
          iops: full,
          collectionCounts: snapshot.observerCollection?.counts?.map((c: any) => ({
            observerId: c.observerId,
            phase: c.phase,
            expected: c.expected,
            observed: c.observed,
            required: c.required,
            failureCount: c.failureCount,
            longestGapSeconds: c.longestGapSeconds
          })),
          finishedAt: new Date().toISOString()
        });
        this.save();
        assert.equal(run.cleanupStatus, "COMPLETE");
        assert.ok(detail.resources.every((r: any) => r.cleanupResult === "deleted"));
        assert.equal(
          (await docker(["ps", "-aq", "--filter", `label=parkbench.run_id=${run.id}`])).trim(),
          ""
        );
        if (fault) {
          assert.ok(injected, "fault actually reached the owned native run");
          assert.equal(run.state, fault === "cancel" ? "CANCELLED" : "FAILED");
          if (fault !== "cancel")
            assert.equal(
              run.failureCode,
              {
                "writer-loss": "database_writer_lost",
                "capture-unavailable": "database_writer_health_unavailable",
                "policy-drift": "database_iops_policy_drift"
              }[fault]
            );
          if (fault === "capture-unavailable") {
            assert.notEqual(record.writerEvidence.capture.outcome, "SUCCEEDED");
            assert.ok(record.writerEvidence.processChecks.every((p: any) => p.matched));
          }
          return record;
        }
        assert.ok(
          ["SUCCEEDED", "THRESHOLD_FAILED"].includes(run.state),
          "threshold outcome is retained separately; infrastructure/incomplete outcomes do not count"
        );
        assert.equal(run.measurementValidity, "VALID");
        assert.equal(run.completeness.complete, true);
        assert.ok(["verified", "stopped"].includes(record.writerEvidence.writerHealth));
        assert.ok(record.writerEvidence.lastSuccessAt);
        assert.equal(
          full.verification.status,
          full.condition.presetId === "unlimited" ? "NO_ADDED_CAP" : "MATCHED"
        );
        if (!gateProof)
          assert.deepEqual(record.declaredPhases, {
            warmupSeconds: 60,
            measurementSeconds: 600,
            cooldownSeconds: 30
          });
        assert.equal(
          snapshot.databaseRunControls.apwCount,
          profiles.find((p) => p.id === record.profile)!.apws
        );
        assert.equal(snapshot.databaseRunControls.biwEnabled, true);
        assert.equal(snapshot.databaseRunControls.biCluster.nativeKiB, 261120);
        if (full.condition.presetId !== "unlimited") {
          assert.equal(full.mode, "native");
          assert.equal(full.applicationTiming, "BEFORE_DATABASE_STARTUP");
          assert.ok(
            full.startupGate.heldAt &&
              full.startupGate.releaseIntentAt &&
              full.startupGate.releasePublishedAt &&
              full.startupGate.consumedAt
          );
        }
        if (record.setup) assert.equal(snapshot.databaseSetupEvidence.state, "SUCCEEDED");
        return record;
      }
      await pause(3000);
    }
    throw Error("native_writer_campaign_deadline");
  }
}
test(
  "three consecutive full native runs for each affected finite/Unlimited writer profile, including setup",
  {
    skip:
      !enabled || ["faults", "gate-proof"].includes(process.env.PARKBENCH_WRITER_CAMPAIGN ?? ""),
    timeout: 12 * 3600000
  },
  async () => {
    const decision = JSON.parse(
      fs.readFileSync(".parkbench/validation/feature026/investigation/timing-decision.json", "utf8")
    );
    assert.equal(
      decision.status,
      "READY_FOR_CONFIRMATION",
      "correction/timing decision required before confirmation"
    );
    const campaign = new NativeWriterCampaign();
    await campaign.prepare();
    for (const profile of profiles.filter(
      (p) => !process.env.PARKBENCH_WRITER_PROFILE || process.env.PARKBENCH_WRITER_PROFILE === p.id
    ))
      for (let repeat = 1; repeat <= 3; repeat++)
        await campaign.observe(await campaign.schedule(profile, `repeat-${repeat}`));
  }
);
test(
  "owned genuine writer loss, unavailable capture, cancellation and policy drift retain distinct honest outcomes",
  { skip: !enabled || process.env.PARKBENCH_WRITER_CAMPAIGN !== "faults", timeout: 6 * 3600000 },
  async () => {
    const campaign = new NativeWriterCampaign();
    await campaign.prepare();
    for (const fault of ["writer-loss", "capture-unavailable", "cancel", "policy-drift"] as const) {
      const profile = { ...profiles[fault === "policy-drift" ? 1 : 2], setup: false };
      await campaign.observe(await campaign.schedule(profile, fault), fault);
    }
  }
);

test(
  "native startup gate proves policy-before-broker with the installed short read validation scenario",
  { skip: !enabled || process.env.PARKBENCH_WRITER_CAMPAIGN !== "gate-proof", timeout: 30 * 60000 },
  async () => {
    const campaign = new NativeWriterCampaign();
    await campaign.prepare();
    const profile = { ...profiles[0], setup: process.env.PARKBENCH_WRITER_GATE_SETUP === "1" };
    const record = await campaign.observe(
      await campaign.schedule(profile, "gate-proof"),
      undefined,
      true
    );
    assert.equal(record.iops.applicationTiming, "BEFORE_DATABASE_STARTUP");
    assert.ok(
      Date.parse(record.writerEvidence.preparation.startedAt) + 1000 >=
        Date.parse(record.iops.startupGate.releasePublishedAt)
    );
  }
);
