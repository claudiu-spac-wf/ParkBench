import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const enabled = process.env.PARKBENCH_RUN_CADVISOR_TESTS === "1";
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

test(
  "pinned cAdvisor preserves resource identity and real zero while excluding unrelated Docker metadata",
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const queue = await (await fetch("http://127.0.0.1:13002/api/v1/queue")).json();
    assert.ok(
      !queue.items.length && !queue.hasMore && !queue.activeExperiment,
      "exporter fixture requires an idle queue"
    );
    const productionId = docker([
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=parkbench-platform",
      "--filter",
      "label=com.docker.compose.service=cadvisor"
    ]);
    assert.match(productionId, /^[a-f0-9]{12,64}$/);
    const production = JSON.parse(docker(["inspect", productionId]))[0];
    assert.match(production.Config.Image, /v0\.55\.1$/);
    const compose = await fs.readFile("deploy/platform-compose.yml", "utf8");
    const service = compose.match(/^  cadvisor:\r?\n([\s\S]*?)(?=^  [a-zA-Z][\w-]*:)/m)?.[1];
    assert.ok(service, "execute production exporter options");
    const args = [...service.matchAll(/^\s+- (--[^\r\n]+)/gm)].map((m) =>
      m[1].replace(/\$\{PARKBENCH_CADVISOR_HOUSEKEEPING_INTERVAL:-1s\}/g, "1s")
    );
    assert.ok(args.length >= 5 && !args.some((arg) => arg.includes("${")));
    const sourceImage = docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "parkbench/observer:dev"
    ]);
    assert.match(sourceImage, /^sha256:[a-f0-9]{64}$/);
    const owner = "f024-labels-" + randomUUID(),
      fixtureName = owner + "-source",
      exporterName = owner + "-exporter";
    const labels = {
      "com.docker.compose.project": "f024-public-label-fixture",
      "com.docker.compose.service": "database",
      "com.docker.compose.container-number": "7",
      "parkbench.managed": "true",
      "parkbench.run_id": owner,
      "parkbench.experiment_id": "public-experiment",
      "parkbench.variant_id": "public-variant",
      "parkbench.repetition": "3",
      "parkbench.component": "database",
      "fixture.unrelated.metadata": "public-unrelated-value"
    };
    try {
      docker([
        "run",
        "-d",
        "--name",
        fixtureName,
        "--network",
        "none",
        "--read-only",
        "--memory",
        "64m",
        "--cpu-shares",
        "512",
        "--label",
        "parkbench.validation=" + owner,
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", key + "=" + value]),
        sourceImage,
        "node",
        "-e",
        "setTimeout(()=>{},110000)"
      ]);
      const fixtureId = docker(["inspect", "--format", "{{.Id}}", fixtureName]);
      const entrypoint = production.Config.Entrypoint as string[];
      docker([
        "run",
        "-d",
        "--name",
        exporterName,
        "--pid",
        "host",
        "--privileged",
        "--memory",
        "512m",
        "--label",
        "parkbench.validation=" + owner,
        "-p",
        "127.0.0.1::8080",
        "-v",
        "/sys:/sys:ro",
        "-v",
        "/dev/disk:/dev/disk:ro",
        "--device",
        "/dev/kmsg:/dev/kmsg",
        "--entrypoint",
        entrypoint[0],
        production.Image,
        ...entrypoint.slice(1),
        ...args
      ]);
      const binding = JSON.parse(
        docker([
          "inspect",
          "--format",
          '{{json (index .NetworkSettings.Ports "8080/tcp")}}',
          exporterName
        ])
      );
      assert.equal(binding.length, 1);
      assert.equal(binding[0].HostIp, "127.0.0.1");
      const url = "http://127.0.0.1:" + binding[0].HostPort + "/metrics";
      let rows: string[] = [],
        bytes = 0;
      for (let n = 0; n < 45; n++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
          const body = await response.text();
          bytes = Buffer.byteLength(body);
          assert.ok(bytes <= 16 * 1024 * 1024, "fixture source response is bounded");
          rows = body
            .split("\n")
            .filter(
              (line) => !line.startsWith("#") && line.includes('id="') && line.includes(fixtureId)
            );
          if (rows.some((line) => line.startsWith("container_spec_memory_limit_bytes{"))) break;
        } catch {
          /* Native registration may not yet be ready. */
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.ok(rows.length > 20, "native exporter discovers the public container");
      const memory = rows.find((line) => line.startsWith("container_spec_memory_limit_bytes{"));
      const reservation = rows.find((line) =>
        line.startsWith("container_spec_memory_reservation_limit_bytes{")
      );
      const shares = rows.find((line) => line.startsWith("container_spec_cpu_shares{"));
      assert.ok(memory && reservation && shares, "fixed native source readings remain available");
      const value = (line: string) =>
        Number(
          line
            .slice(line.indexOf("}") + 1)
            .trim()
            .split(/\s+/)[0]
        );
      assert.equal(value(memory), 64 * 1024 * 1024);
      assert.equal(value(reservation), 0, "a real native zero remains zero");
      assert.ok(value(shares) > 0, "native positive CPU share value remains present");
      for (const [key, expected] of Object.entries(labels).filter(
        ([key]) => !key.startsWith("fixture.")
      )) {
        const name = "container_label_" + key.replace(/[^a-zA-Z0-9_]/g, "_");
        assert.ok(
          memory.includes(name + '="' + expected + '"'),
          "required ownership label retained: " + name
        );
      }
      assert.ok(
        memory.includes('name="') && memory.includes('image="'),
        "native physical identity is retained"
      );
      assert.ok(
        rows.some(
          (line) => line.startsWith("container_cpu_usage_seconds_total{") && line.includes('cpu="')
        ),
        "native CPU dimension is retained"
      );
      const cpu = (text: string) =>
        Number(text.match(/^process_cpu_seconds_total ([0-9.eE+-]+)$/m)?.[1]);
      const beforeBody = await (await fetch(url)).text();
      const beforeCpu = cpu(beforeBody),
        began = performance.now();
      let afterBody = beforeBody;
      for (let i = 0; i < 6; i++) afterBody = await (await fetch(url)).text();
      const afterCpu = cpu(afterBody);
      assert.ok(Number.isFinite(beforeCpu) && Number.isFinite(afterCpu));
      t.diagnostic(
        JSON.stringify({
          responseBytes: bytes,
          fixtureRows: rows.length,
          requests: 6,
          wallMs: performance.now() - began,
          exporterCpuSeconds: afterCpu - beforeCpu
        })
      );
      assert.ok(
        !rows.some((line) => line.includes("container_label_fixture_unrelated_metadata")),
        "unrelated Docker label must not inflate every metric"
      );
    } finally {
      for (const name of [exporterName, fixtureName]) {
        let inspected;
        try {
          inspected = JSON.parse(docker(["inspect", name]))[0];
        } catch {
          continue;
        }
        assert.equal(inspected.Config.Labels["parkbench.validation"], owner);
        docker(["rm", "-f", "-v", inspected.Id]);
      }
      assert.equal(docker(["ps", "-aq", "--filter", "label=parkbench.validation=" + owner]), "");
    }
  }
);

test(
  "external availability evidence covers every platform member including the exporter itself",
  { skip: !enabled, timeout: 40000 },
  async () => {
    const { captureDeviceState } = await import(
      path.resolve("scripts/diagnostics/capture-measurement-device-state.mjs")
    );
    const records = await captureDeviceState("f024-platform-proof-fixture");
    const expected = ["cadvisor", "control-plane", "grafana", "node-exporter", "prometheus", "web"];
    assert.deepEqual(records.map((record: any) => record.service).sort(), expected.sort());
    for (const record of records) {
      assert.equal(
        record.state,
        "COMPLETE",
        "complete native/kernel evidence for " + record.service
      );
      assert.equal(record.kernelOwnerConfirmed, true, "kernel cgroup belongs to " + record.service);
      assert.ok(record.cadvisor && Array.isArray(record.kernelDevices));
      assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 4096);
    }
  }
);
