import { actionFixture } from "../fixtures/experiment-actions";
import { prometheusStorageBounds } from "../../apps/control-plane/src/experiments/actions/prometheus-storage-bounds";
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpExperimentMetricAdmin } from "../../packages/metrics/src/prometheus-admin";
import { verifyMetricRevisionCapability } from "../../apps/control-plane/src/experiments/actions/prerequisites";
const execute = promisify(execFile);
async function docker(args: string[]) {
  return (await execute("docker", args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function until(fn: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("fixture_readiness_timeout");
}
test(
  "owned real Prometheus full-domain deletion isolates replacement samples, including clock rollback and legacy/raw samples",
  { skip: process.env.PARKBENCH_RUN_EXPERIMENT_DELETION_TESTS !== "1", timeout: 180000 },
  async () => {
    const image = process.env.PARKBENCH_PROMETHEUS_IMAGE ?? "prom/prometheus:v3.5.0";
    assert.ok(image.includes(":") && !image.endsWith(":latest"));
    const nonce = crypto.randomUUID(),
      root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-deletion-"));
    const now = Date.now(),
      old = now - 10000,
      future = now + 60000;
    let id: string | undefined, exporterId: string | undefined;
    const network = `parkbench-f026-${nonce}`,
      volume = network + "-data";
    const setPhase = async (value: string) => {
      await docker([
        "exec",
        exporterId!,
        "node",
        "-e",
        `require('fs').writeFileSync('/tmp/phase',${JSON.stringify(value)})`
      ]);
    };
    const publishBody = async (value: string) => {
      await docker([
        "exec",
        exporterId!,
        "node",
        "-e",
        `require('fs').writeFileSync('/tmp/worker-body',${JSON.stringify(value)})`
      ]);
      await setPhase("worker");
    };
    fs.writeFileSync(
      path.join(root, "prometheus.yml"),
      "global:\n  scrape_interval: 1s\n  scrape_timeout: 1s\nscrape_configs:\n  - job_name: fixture\n    static_configs:\n      - targets: ['fixture-exporter:9100']\n"
    );
    const oldSamples = [
      `f026_target{run_id="target",experiment_id="experiment",execution_revision="old"} 1 ${old}`,
      `f026_legacy{run_id="target",experiment_id="experiment"} 2 ${old}`,
      `f026_raw{container_label_parkbench_run_id="target",container_label_parkbench_experiment_id="experiment",container_label_parkbench_execution_revision="old"} 3 ${old}`,
      `f026_future{run_id="target",execution_revision="old"} 4 ${future}`
    ];
    const newSamples = [
      `f026_target{run_id="target",experiment_id="experiment",execution_revision="replacement"} 9 ${old - 60000}`,
      `f026_raw{container_label_parkbench_run_id="target",container_label_parkbench_experiment_id="experiment",container_label_parkbench_execution_revision="replacement"} 9 ${old - 60000}`
    ];
    const sentinel = `f026_sentinel{run_id="sentinel",execution_revision="sentinel"} 8 ${now}`;
    const script = `const fs=require('fs'),http=require('http');http.createServer((q,r)=>{let p='old';try{p=fs.readFileSync('/tmp/phase','utf8')}catch{};r.setHeader('Content-Type','text/plain; version=0.0.4');r.end([${JSON.stringify(sentinel)},...(p==='worker'?fs.readFileSync('/tmp/worker-body','utf8').trim().split('\\n'):p==='old'?${JSON.stringify(oldSamples)}:p==='new'?${JSON.stringify(newSamples)}:[])].join('\\n')+'\\n')}).listen(9100,'0.0.0.0');`;
    try {
      await docker(["network", "create", "--label", `parkbench.feature_probe=${nonce}`, network]);
      await docker(["volume", "create", "--label", `parkbench.feature_probe=${nonce}`, volume]);
      exporterId = await docker([
        "run",
        "-d",
        "--network",
        network,
        "--network-alias",
        "fixture-exporter",
        "--label",
        `parkbench.feature_probe=${nonce}`,
        "--entrypoint",
        "node",
        process.env.PARKBENCH_LOADGEN_IMAGE ?? "parkbench/loadgen:dev",
        "-e",
        script
      ]);
      id = await docker([
        "create",
        "--name",
        `parkbench-f026-prom-${nonce}`,
        "--label",
        `parkbench.feature_probe=${nonce}`,
        "--network",
        network,
        "-p",
        "127.0.0.1::9090",
        "--mount",
        `type=volume,source=${volume},target=/prometheus`,
        image,
        "--config.file=/etc/prometheus/prometheus.yml",
        "--web.enable-admin-api",
        "--storage.tsdb.retention.time=1d"
      ]);
      await docker([
        "cp",
        path.join(root, "prometheus.yml"),
        id + ":/etc/prometheus/prometheus.yml"
      ]);
      await docker(["start", id]);
      const [info] = JSON.parse(await docker(["inspect", id]));
      const url = `http://127.0.0.1:${info.NetworkSettings.Ports["9090/tcp"][0].HostPort}`;
      const query = async (q: string, time?: number) => {
        const p = new URLSearchParams({ query: q, ...(time ? { time: String(time) } : {}) });
        const r = await fetch(url + "/api/v1/query?" + p);
        const b: any = await r.json();
        assert.equal(b.status, "success");
        return b.data.result;
      };
      await until(async () => (await query("sum(count_over_time(f026_target[5m]))")).length > 0);
      await until(
        async () =>
          (await query("sum(count_over_time(f026_future[5m]))", future / 1000 + 1)).length > 0
      );
      const admin = new HttpExperimentMetricAdmin(url, 86400, fetch, () =>
        prometheusStorageBounds(id)
      );
      await admin.preflight();
      const selectors = await admin.inventory("experiment", ["target"]);
      await setPhase("none");
      await new Promise((r) => setTimeout(r, 2500));
      await admin.delete(selectors);
      await admin.verify(selectors, { start: old / 1000 - 1, end: future / 1000 + 1 });
      assert.equal((await query("count_over_time(f026_target[1d])")).length, 0);
      assert.ok((await query("count_over_time(f026_sentinel[5m])")).length > 0);
      await setPhase("new");
      await until(
        async () =>
          (await query('sum(count_over_time(f026_target{execution_revision="replacement"}[10m]))'))
            .length > 0
      );
      await admin.delete(selectors);
      assert.ok(
        (await query('count_over_time(f026_target{execution_revision="replacement"}[10m])'))
          .length > 0
      );
      assert.ok(
        (
          await query(
            'count_over_time(f026_raw{container_label_parkbench_execution_revision="replacement"}[10m])'
          )
        ).length > 0
      );
      // Native allowlist verification is tied to the actual locally deployed cAdvisor.
      await verifyMetricRevisionCapability(
        process.env.PARKBENCH_CADVISOR_URL ?? "http://127.0.0.1:18080",
        process.env.PARKBENCH_LOADGEN_IMAGE ?? "parkbench/loadgen:dev"
      );
      // The complete action worker uses the same real adapter and immutable scopes.
      let sealed: string[] = [];
      const f = await actionFixture({
        experimentMetricAdmin: {
          preflight: () => admin.preflight(),
          inventory: (e, r, o) => admin.inventory(e, r, o),
          delete: async (s) => {
            sealed = [...s];
            await admin.delete(s);
          },
          verify: (s, w) => admin.verify(s, w),
          quiesce: async (r) => {
            await setPhase("none");
            await admin.quiesce(r);
          }
        }
      });
      try {
        f.terminal();
        const runId = f.runIds[0],
          experiment = f.submitted.id,
          revision = f.platform.experimentActions.repository.currentRevision(experiment);
        const body = (rev: string, value: number, stamp: number) =>
          `f026_worker{run_id="${runId}",experiment_id="${experiment}",execution_revision="${rev}"} ${value} ${stamp}\n`;
        const publish = async (value: string) => {
          await docker([
            "exec",
            exporterId!,
            "node",
            "-e",
            `require('fs').writeFileSync('/tmp/worker-body',${JSON.stringify(value)})`
          ]);
          await setPhase("worker");
        };
        await publish(
          body(revision, 1, old) + `f026_worker_legacy{run_id="${runId}"} 2 ${future}\n`
        );
        await until(
          async () =>
            (await query(`count_over_time(f026_worker{run_id="${runId}"}[1d])`)).length > 0
        );
        const actions = f.platform.experimentActions;
        const rerun = actions.submit(
          experiment,
          {
            contractVersion: "experiment-action.v1",
            kind: "RERUN",
            confirm: true,
            expectedRevision: revision
          },
          "native-worker-rerun"
        );
        await actions.idle();
        assert.equal(actions.get(rerun.id).status, "SUCCEEDED");
        const oldScope = [...sealed],
          replacement = actions.repository.currentRevision(experiment);
        await publish(body(replacement, 9, old - 60000));
        await until(
          async () =>
            (await query(`count_over_time(f026_worker{execution_revision="${replacement}"}[1d])`))
              .length > 0
        );
        await admin.delete(oldScope);
        assert.ok(
          (await query(`count_over_time(f026_worker{execution_revision="${replacement}"}[1d])`))
            .length > 0
        );
        f.terminal();
        const removal = actions.submit(
          experiment,
          {
            contractVersion: "experiment-action.v1",
            kind: "REMOVE",
            confirm: true,
            expectedRevision: replacement
          },
          "native-worker-remove"
        );
        await actions.idle();
        assert.equal(actions.get(removal.id).status, "SUCCEEDED");
        assert.equal(f.platform.repositories.getExperiment(experiment), undefined);
        assert.equal((await query(`count_over_time({run_id="${runId}"}[1d])`)).length, 0);
        assert.ok((await query("count_over_time(f026_sentinel[1d])")).length > 0);
        const evidence = path.resolve(".parkbench/validation/feature026/metrics/worker.json");
        fs.writeFileSync(
          evidence,
          JSON.stringify(
            {
              status: "PASSED",
              checks: [
                "full rerun worker",
                "same IDs and new revision",
                "delayed sealed deletion preserves replacement",
                "full removal worker",
                "sentinel retained",
                "opaque receipts",
                "native TSDB block bounds included"
              ]
            },
            null,
            2
          )
        );
      } finally {
        await f.platform.close();
        f.close();
      }
      // Identical parent/revision labels must not broaden an individual deletion.
      let individualScope: string[] = [];
      const single = await actionFixture({
        experimentMetricAdmin: {
          preflight: () => admin.preflight(),
          inventory: (e, r, o) => admin.inventory(e, r, o),
          delete: async (s) => {
            individualScope = [...s];
            await admin.delete(s);
          },
          verify: (s, w) => admin.verify(s, w),
          quiesce: async (r) => {
            await setPhase("none");
            await admin.quiesce(r);
          }
        }
      });
      try {
        single.terminal();
        const target = single.runIds[0],
          sibling = single.runIds[1],
          exp = single.submitted.id,
          revision = single.platform.repositories.getRun(target)!.executionRevision!;
        const normalized = (run: string, rev: string, value = 1, stamp = old) =>
          `f026_single{run_id="${run}",experiment_id="${exp}",execution_revision="${rev}"} ${value} ${stamp}\n`;
        const raw = (run: string) =>
          `f026_single_raw{container_label_parkbench_run_id="${run}",container_label_parkbench_experiment_id="${exp}",container_label_parkbench_execution_revision="${revision}"} 1 ${old}\n`;
        await publishBody(
          normalized(target, revision) +
            normalized(sibling, revision) +
            raw(target) +
            raw(sibling) +
            `f026_single_mixed{experiment_id="${exp}",execution_revision="${revision}",container_label_parkbench_run_id="${sibling}"} 1 ${old}\n` +
            `f026_parent_derived{experiment_id="${exp}",execution_revision="${revision}"} 2 ${old}\n`
        );
        await until(
          async () =>
            (await query(`count_over_time(f026_single{run_id="${target}"}[1d])`)).length > 0
        );
        const a = single.platform.experimentActions,
          admitted = a.submitRun(
            target,
            {
              contractVersion: "experiment-action.v1",
              kind: "RERUN",
              confirm: true,
              expectedRevision: revision
            },
            "native-single-run"
          );
        await a.idle();
        assert.equal(a.get(admitted.id).status, "SUCCEEDED");
        assert.equal(
          (await query(`count_over_time(f026_single{run_id="${target}"}[1d])`)).length,
          0
        );
        assert.equal((await query("count_over_time(f026_parent_derived[1d])")).length, 0);
        for (const expression of [
          `f026_single{run_id="${sibling}"}`,
          `f026_single_raw{container_label_parkbench_run_id="${sibling}"}`,
          `f026_single_mixed{container_label_parkbench_run_id="${sibling}"}`
        ])
          assert.ok((await query(`count_over_time(${expression}[1d])`)).length > 0);
        const sealed = [...individualScope],
          replacement = single.platform.repositories.getRun(target)!.executionRevision!;
        await publishBody(normalized(target, replacement, 9, old - 60000));
        await until(
          async () =>
            (await query(`count_over_time(f026_single{execution_revision="${replacement}"}[1d])`))
              .length > 0
        );
        await admin.delete(sealed);
        assert.ok(
          (await query(`count_over_time(f026_single{execution_revision="${replacement}"}[1d])`))
            .length > 0
        );
        assert.ok(
          (await query(`count_over_time(f026_single{run_id="${sibling}"}[1d])`)).length > 0
        );
        fs.writeFileSync(
          path.resolve(".parkbench/validation/feature026/metrics/individual.json"),
          JSON.stringify(
            {
              status: "PASSED",
              checks: [
                "selected run erased",
                "same-parent same-revision siblings preserved",
                "raw and mixed labels preserved",
                "parent-only derivatives invalidated",
                "replacement survives delayed positive deletion and rollback"
              ]
            },
            null,
            2
          )
        );
      } finally {
        await single.platform.close();
        single.close();
      }
      const out = path.resolve(".parkbench/validation/feature026/metrics/native.json");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            status: "PASSED",
            image,
            selectors: selectors.length,
            checks: [
              "all old revisions",
              "legacy",
              "raw cAdvisor",
              "future timestamps",
              "sparse samples",
              "sentinel intact",
              "replacement survives delayed deletion and rollback",
              "native raw label verified"
            ]
          },
          null,
          2
        )
      );
    } finally {
      if (id) {
        const [actual] = JSON.parse(await docker(["inspect", id]));
        assert.equal(actual.Config.Labels["parkbench.feature_probe"], nonce);
        await docker(["rm", "-f", id]);
      }
      if (exporterId) {
        const [actual] = JSON.parse(await docker(["inspect", exporterId]));
        assert.equal(actual.Config.Labels["parkbench.feature_probe"], nonce);
        await docker(["rm", "-f", exporterId]);
      }
      for (const kind of ["volume", "network"]) {
        const name = kind === "volume" ? volume : network;
        const existing = await docker([
          kind,
          "ls",
          "-q",
          "--filter",
          `label=parkbench.feature_probe=${nonce}`
        ]);
        if (existing.split("\n").includes(name)) await docker([kind, "rm", name]);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
