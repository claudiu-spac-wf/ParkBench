import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { captureIopsBoundaries } from "../helpers/iops-boundaries-native";
import { EngineApi } from "../../packages/compose-runner/src/engine-api";
const enabled =
  process.env.PARKBENCH_RUN_IOPS_TESTS === "1" && process.env.PARKBENCH_RUN_OPENEDGE_TESTS === "1";
const terminal = new Set([
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "native frozen IOPS pair and three phase drift failures retain quality and owned cleanup",
  { skip: !enabled, timeout: 3600000 },
  async (t) => {
    const origin = new URL(process.env.PARKBENCH_CONTROL_API_URL ?? "http://127.0.0.1:13000");
    assert.ok(["127.0.0.1", "localhost"].includes(origin.hostname), "local platform required");
    const request = async (method: string, route: string, body?: unknown, key?: string) => {
      if (method === "POST") console.log(`native IOPS ${method} ${route}`);
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await fetch(origin.origin + route, {
            method,
            headers: {
              ...(body ? { "content-type": "application/json" } : {}),
              ...(key ? { "idempotency-key": key } : {})
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(method === "POST" ? 360000 : 30000)
          });
          break;
        } catch (error) {
          if (method !== "GET" || attempt >= 2)
            throw new Error(`native_iops_request_unavailable:${method}:${route}`);
          await pause(1000);
        }
      }
      const bytes = await response.arrayBuffer();
      assert.ok(bytes.byteLength <= 8388608, "bounded native validation response");
      if (!response.ok) throw Error(`native_iops_http_${response.status}:${route}`);
      return JSON.parse(Buffer.from(bytes).toString());
    };
    const out = path.resolve(".parkbench/validation/feature025/native/results.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const resume = process.env.PARKBENCH_IOPS_RESUME_RESULTS;
    if (resume) assert.ok(fs.statSync(resume).size <= 8388608, "bounded validation resume");
    const results: any = resume
      ? JSON.parse(fs.readFileSync(resume, "utf8"))
      : {
          startedAt: new Date().toISOString(),
          normal: [],
          drift: [],
          experiments: [],
          status: "RUNNING"
        };
    results.status = "RUNNING";
    delete results.reason;
    delete results.finishedAt;
    const owned = new Set<string>((results.experiments ?? []).flatMap((e) => e.runIds));
    const save = () => fs.writeFileSync(out, JSON.stringify(results, null, 2));
    const api = await EngineApi.forDocker();
    api.requireFinite();
    const options = await request("GET", "/api/v1/ui-options");
    assert.equal(
      options.databaseIopsCatalog?.contractVersion,
      "database-iops-presets.v1",
      "deploy updated controller first"
    );
    const assets = await request("GET", "/api/v1/catalog/assets?category=scenarios&pageSize=250");
    const scenario =
      assets.items.find((a) => a.id === process.env.PARKBENCH_IOPS_SCENARIO_SOURCE_ID) ||
      assets.items.find((a) => {
        try {
          return Buffer.from(a.id.replace(/^discovery_file_/, ""), "base64url")
            .toString()
            .endsWith("feature024-read-timeout-control.json");
        } catch {
          return false;
        }
      });
    assert.ok(scenario, "installed native validation scenario required");
    const sourceInputs = {
      seed: process.env.PARKBENCH_IOPS_SEED_REF ?? "input:seeds/one_gb_lnx",
      applicationArchive:
        process.env.PARKBENCH_IOPS_ARCHIVE_REF ?? "input:archives/parkbench-runner.zip"
    };
    const protectedBefore = await captureIopsBoundaries(
      sourceInputs.seed,
      sourceInputs.applicationArchive
    );
    const setup = {
      contractVersion: "database-setup.v1",
      steps: [
        {
          id: "iops-build",
          definitionId: "idxbuild",
          optionSets: [{ id: "all-indexes", scope: "all" }]
        }
      ]
    };
    const guardIdle = async () => {
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        const q = await request("GET", "/api/v1/queue");
        if ((q.items ?? []).some((r) => !owned.has(r.id)))
          throw Error("native_iops_unrelated_queue_work");
        if (!q.activeExperiment && !q.items.length) return;
        await pause(1000);
      }
      throw Error("native_iops_queue_not_idle");
    };
    const schedule = async (kind: string, presets: string[]) => {
      await guardIdle();
      const runName = `f025-${kind}-${crypto.randomUUID().slice(0, 8)}`;
      const preview = await request("POST", "/api/v1/experiments/preview", {
        contractVersion: "experiment-schedule.v2",
        runName,
        scenarioSourceId: scenario.id,
        dimensions: [{ name: "storage.databaseIopsPreset", values: presets }],
        fixedOverrides: { "-n": 100 },
        repetitions: 1,
        inputs: sourceInputs,
        ...(kind === "pair" ? { databaseSetup: setup } : {})
      });
      assert.equal(preview.runCount, presets.length);
      let page = preview;
      while (page.cells.hasMore)
        page = await request(
          "GET",
          `/api/v1/experiments/previews/${preview.previewId}/cells?pageToken=${encodeURIComponent(page.cells.nextPageToken)}`
        );
      const experiment = await request(
        "POST",
        "/api/v1/experiments/submit",
        { previewId: preview.previewId, confirm: true },
        runName
      );
      for (const run of experiment.runs) owned.add(run.id);
      results.experiments.push({
        id: experiment.id,
        kind,
        runIds: experiment.runs.map((r) => r.id)
      });
      save();
      await request("POST", "/api/v1/queue/start", {}, `start-${runName}`);
      return experiment.runs.map((r) => r.id) as string[];
    };
    const waitRun = async (id: string, driftPhase?: string) => {
      const until = Date.now() + 900000;
      let injection: any,
        preparationObserved = false;
      let seenState = "";
      let phaseEnteredAt = Date.now();
      while (Date.now() < until && !t.signal.aborted) {
        const run = await request("GET", `/api/v1/runs/${id}`);
        const e = run.environmentSnapshot?.databaseIopsEvidence;
        if (run.state !== seenState) {
          console.log(`${id}: ${run.state}${driftPhase ? ` (inject ${driftPhase})` : ""}`);
          seenState = run.state;
          phaseEnteredAt = Date.now();
        }
        if (run.state === "PROVISIONING") {
          const list = await api.request(
            "GET",
            api.versioned(
              `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`parkbench.run_id=${id}`, "parkbench.component=database"] }))}`
            )
          );
          if (list.length === 1) {
            const db = await api.inspect(list[0].Id);
            assert.equal(
              (db.HostConfig.BlkioDeviceReadIOps ?? []).length,
              0,
              "preparation must be uncapped"
            );
            assert.equal((db.HostConfig.BlkioDeviceWriteIOps ?? []).length, 0);
            preparationObserved = true;
          }
        }
        const phaseState = { warmup: "WARMING_UP", measurement: "MEASURING", cooldown: "COOLDOWN" }[
          driftPhase
        ];
        if (
          driftPhase &&
          !injection &&
          run.state === phaseState &&
          e?.verification.status === "MATCHED" &&
          Date.now() - phaseEnteredAt >= 6000
        ) {
          assert.ok(e.artifactId);
          const full = await request("GET", `/api/v1/runs/${id}/artifacts/${e.artifactId}`);
          const intent = full.applicationIntent;
          assert.equal(intent.runId, id);
          const target = await api.inspect(intent.owner.containerId);
          assert.equal(target.Config.Labels["parkbench.run_id"], id);
          assert.equal(target.Config.Labels["parkbench.component"], "database");
          assert.equal(target.State.Pid, intent.owner.pid);
          assert.equal(target.State.StartedAt, intent.owner.startedAt);
          const rule = {
            read: intent.coverage.devices.map((d) => ({ Path: d.path, Rate: 1 })),
            write: intent.coverage.devices.map((d) => ({ Path: d.path, Rate: 1 }))
          };
          await api.updateIops(intent.owner.containerId, rule);
          injection = {
            phase: driftPhase,
            at: new Date().toISOString(),
            containerId: intent.owner.containerId,
            expected: intent.desiredIops,
            injected: rule
          };
          console.log(`${id}: injected owned ${driftPhase} policy change`);
          save();
        }
        if (terminal.has(run.state) && ["COMPLETE", "FAILED"].includes(run.cleanupStatus)) {
          assert.equal(run.cleanupStatus, "COMPLETE");
          assert.ok(preparationObserved, "capture uncapped preparation");
          const snapshot = run.environmentSnapshot;
          assert.equal(
            snapshot.databaseIops?.presetId,
            driftPhase ? "sata-ssd" : snapshot.databaseIops?.presetId
          );
          assert.equal(e.condition.presetId, snapshot.databaseIops.presetId);
          const detail = await request("GET", `/api/v1/history/runs/${id}`);
          assert.ok(detail.resources.every((r) => r.cleanupResult === "deleted"));
          const full = e.artifactId
            ? await request("GET", `/api/v1/runs/${id}/artifacts/${e.artifactId}`)
            : undefined;
          assert.ok(full?.cleanup?.completed);
          const record = {
            runId: id,
            state: run.state,
            measurementValidity: run.measurementValidity,
            cleanupStatus: run.cleanupStatus,
            condition: snapshot.databaseIops,
            evidence: full,
            phaseBoundaries: run.phaseBoundaries,
            declaredPhases: snapshot.scenario.phases,
            preparationObserved,
            setup: snapshot.databaseSetupEvidence?.state,
            completeness: run.completeness,
            collectionCounts: snapshot.observerCollection?.counts?.map((c) => ({
              observerId: c.observerId,
              phase: c.phase,
              expected: c.expected,
              observed: c.observed,
              required: c.required,
              failureCount: c.failureCount,
              longestGapSeconds: c.longestGapSeconds
            })),
            injection
          };
          if (driftPhase) {
            assert.ok(injection, "drift was actually injected");
            assert.equal(run.state, "FAILED");
            assert.equal(run.failureCode, "database_iops_policy_drift");
            assert.equal(run.measurementValidity, "UNAVAILABLE");
            assert.equal(full.failure.phase, driftPhase);
            assert.equal(full.terminationDecision.cause, "POLICY_DRIFT");
            assert.equal(full.verification.status, "MISMATCH");
            assert.ok(
              snapshot.observerCollection?.counts?.some((c) => c.observed > 0),
              "retain actual partial collections"
            );
            results.drift.push(record);
          } else {
            assert.equal(run.state, "SUCCEEDED");
            assert.equal(run.measurementValidity, "VALID");
            assert.equal(run.completeness.complete, true);
            assert.equal(
              full.verification.status,
              snapshot.databaseIops.presetId === "unlimited" ? "NO_ADDED_CAP" : "MATCHED"
            );
            for (const [phase, key] of [
              ["warmup", "warmupSeconds"],
              ["measurement", "measurementSeconds"],
              ["cooldown", "cooldownSeconds"]
            ]) {
              const boundary = run.phaseBoundaries[phase];
              assert.ok(boundary?.startedAt && boundary?.finishedAt);
              assert.equal(
                (Date.parse(boundary.finishedAt) - Date.parse(boundary.startedAt)) / 1000,
                snapshot.scenario.phases[key]
              );
            }
            results.normal.push(record);
          }
          save();
          return run;
        }
        await pause(1500);
      }
      throw Error("native_iops_run_deadline");
    };
    try {
      const missing = ["unlimited", "sata-ssd"].filter(
        (preset) => !results.normal.some((r) => r.condition.presetId === preset)
      );
      if (missing.length) {
        const pair = await schedule("pair", missing);
        for (const id of pair) await waitRun(id);
      }
      for (const phase of ["warmup", "measurement", "cooldown"]) {
        if (results.drift.some((r) => r.injection?.phase === phase)) continue;
        const [id] = await schedule(`drift-${phase}`, ["sata-ssd"]);
        await waitRun(id, phase);
      }
      await guardIdle();
      assert.deepEqual(
        await captureIopsBoundaries(sourceInputs.seed, sourceInputs.applicationArchive),
        protectedBefore
      );
      results.boundaryVerification = "PASSED";
      results.status = "PASSED";
    } catch (error) {
      results.status = "FAILED_OR_BLOCKED";
      results.reason = String(error);
      for (const id of owned) {
        try {
          const run = await request("GET", `/api/v1/runs/${id}`);
          if (!terminal.has(run.state))
            await request("POST", `/api/v1/queue/runs/${id}/cancel`, {}, `cleanup-${id}`);
        } catch {}
      }
      throw error;
    } finally {
      results.finishedAt = new Date().toISOString();
      save();
    }
  }
);
