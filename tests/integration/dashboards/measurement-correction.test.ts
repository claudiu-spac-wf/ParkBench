import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PROMETHEUS_IMAGE } from "./support/fixture-prometheus";

test(
  "the actual owned-resource scrape keeps exact run membership and observed zero when the proxy fails",
  {
    skip: process.env.PARKBENCH_RUN_GRAFANA_INTEGRATION !== "1",
    timeout: 90000
  },
  async (t) => {
    const suffix = randomUUID(),
      network = `f024-relabel-${suffix}`,
      source = `f024-source-${suffix}`,
      prometheus = `f024-prom-${suffix}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-resource-source-"));
    const docker = (args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
    t.after(() => {
      for (const name of [prometheus, source]) {
        try {
          docker(["rm", "-f", name]);
        } catch {
          /* creation may have failed */
        }
      }
      try {
        docker(["network", "rm", network]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    // Independent physical identities include another run, an unmanaged member and a legitimate zero.
    const rows = [
      { owner: "run-a", managed: "true", id: "/docker/a-db", service: "database", value: 0 },
      { owner: "run-a", managed: "true", id: "/docker/a-pas", service: "pas", value: 7 },
      { owner: "run-b", managed: "true", id: "/docker/b-db", service: "database", value: 999 },
      { owner: "run-a", managed: "false", id: "/docker/unmanaged", service: "other", value: 999 }
    ];
    fs.writeFileSync(
      path.join(root, "server.cjs"),
      `
const http = require('node:http'); let failed = false;
const rows = ${JSON.stringify(rows)};
http.createServer((req,res) => {
 const url = new URL(req.url, 'http://fixture');
 if (url.pathname === '/fail-proxy') { failed=true; res.end('ok'); return; }
 if (url.pathname !== '/metrics' && url.pathname !== '/internal/cadvisor/metrics') { res.writeHead(404); res.end(); return; }
 if (failed && url.pathname === '/internal/cadvisor/metrics') { res.writeHead(503); res.end(); return; }
 const selected = url.pathname === '/metrics' ? rows : rows.filter(r => r.owner === url.searchParams.get('run_id') && r.managed === 'true');
 res.setHeader('Content-Type', 'text/plain; version=0.0.4');
 res.end('# TYPE container_cpu_usage_seconds_total counter\\n' + selected.map(r => 'container_cpu_usage_seconds_total{container_label_parkbench_managed="'+r.managed+'",container_label_parkbench_run_id="'+r.owner+'",container_label_com_docker_compose_service="'+r.service+'",container_label_parkbench_component="'+r.service+'",id="'+r.id+'"} '+r.value).join('\\n')+'\\n');
}).listen(8080,'0.0.0.0');
`
    );
    const production = fs.readFileSync("deploy/prometheus/prometheus.yml", "utf8");
    const job = production.match(
      /  - job_name: parkbench-run-owned-cadvisor\n[\s\S]*?(?=  - job_name:)/
    )?.[0];
    assert.ok(job, "execute the actual production relabel rules");
    fs.writeFileSync(
      path.join(root, "prometheus.yml"),
      "global:\n  scrape_interval: 1s\n  scrape_timeout: 800ms\nscrape_configs:\n" +
        job.replaceAll("/etc/prometheus/targets/*.json", "/fixture/targets.json")
    );
    fs.writeFileSync(
      path.join(root, "targets.json"),
      JSON.stringify(
        ["run-a", "run-b"].map((run) => ({
          targets: ["cadvisor:8080"],
          labels: {
            run_id: run,
            experiment_id: "fixture",
            variant_id: "v",
            repetition: "1",
            phase: "measurement",
            component: "run",
            service: "run-cadvisor"
          }
        }))
      )
    );
    docker(["network", "create", network]);
    docker([
      "create",
      "--name",
      source,
      "--network",
      network,
      "--network-alias",
      "cadvisor",
      "--memory=128m",
      "--entrypoint",
      "node",
      "parkbench/control-plane:feature024-baseline",
      "/tmp/server.cjs"
    ]);
    docker(["cp", path.join(root, "server.cjs"), `${source}:/tmp/server.cjs`]);
    docker(["start", source]);
    docker([
      "create",
      "--name",
      prometheus,
      "--network",
      network,
      "--memory=256m",
      "-p",
      "127.0.0.1::9090",
      "--user",
      "0",
      PROMETHEUS_IMAGE,
      "--config.file=/fixture/prometheus.yml",
      "--storage.tsdb.path=/tmp/data"
    ]);
    docker(["cp", root + "/.", `${prometheus}:/fixture`]);
    docker(["start", prometheus]);
    const port = docker(["port", prometheus, "9090"]).trim().split(":").at(-1);
    const base = `http://127.0.0.1:${port}`;
    const query = async (expression: string) => {
      const result: any = await (
        await fetch(base + "/api/v1/query?" + new URLSearchParams({ query: expression }), {
          signal: AbortSignal.timeout(2000)
        })
      ).json();
      assert.equal(result.status, "success");
      return result.data.result;
    };
    async function waitFor(predicate: () => Promise<boolean>) {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        try {
          if (await predicate()) return;
        } catch {
          /* startup */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.fail("independent source/scope oracle was not satisfied");
    }
    await waitFor(async () => (await query('up{job="parkbench-run-owned-cadvisor"}')).length === 2);
    await waitFor(
      async () =>
        (
          await query(
            'container_cpu_usage_seconds_total{job="parkbench-run-owned-cadvisor",run_id="run-a"}'
          )
        ).length === 2
    );
    const before = await query(
      'container_cpu_usage_seconds_total{job="parkbench-run-owned-cadvisor",run_id="run-a"}'
    );
    assert.deepEqual(before.map((s: any) => [s.metric.id, s.metric.service, s.value[1]]).sort(), [
      ["/docker/a-db", "database", "0"],
      ["/docker/a-pas", "pas", "7"]
    ]);
    assert.ok(
      before.every(
        (s: any) =>
          s.metric.container_label_parkbench_run_id === s.metric.run_id &&
          s.metric.phase === "measurement"
      )
    );
    // Only the disposable proxy is made unavailable. The source remains unchanged and healthy.
    docker([
      "exec",
      source,
      "node",
      "-e",
      "fetch('http://127.0.0.1:8080/fail-proxy').then(r=>{if(!r.ok)process.exitCode=1})"
    ]);
    const failureAt = Date.now() / 1000;
    await waitFor(async () => {
      const up = await query('up{job="parkbench-run-owned-cadvisor"}');
      return (
        up.length === 2 &&
        up.every((s: any) => Number(s.value[0]) > failureAt + 2 && s.value[1] === "1")
      );
    });
    // Stored-timestamp raw samples prove fresh readings after failure; instant lookback cannot satisfy this check.
    const raw = await query(
      'container_cpu_usage_seconds_total{job="parkbench-run-owned-cadvisor",run_id="run-a"}[5s]'
    );
    assert.equal(raw.length, 2);
    assert.ok(
      raw.every((s: any) =>
        s.values.some(([timestamp]: [number, string]) => timestamp > failureAt + 1)
      )
    );
    assert.equal((await query('container_cpu_usage_seconds_total{run_id="run-b"}')).length, 1);
  }
);
