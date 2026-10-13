import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createFakeDocker } from "../helpers/fake-docker";

function clean(env: NodeJS.ProcessEnv) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.startsWith("PARKBENCH_")) delete result[key];
  return result;
}

test("partial Compose redeploy retains the generated native observer handoff", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-native-compose-"));
  const docker = createFakeDocker();
  try {
    const output = path.join(root, "openedge");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(root, "operator.env"), "PARKBENCH_OPENEDGE_OBSERVER_IMAGE=\n");
    fs.writeFileSync(
      path.join(output, "images.env"),
      [
        "PARKBENCH_OPENEDGE_OBSERVER_IMAGE=parkbench/openedge-observer:fixture",
        "PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE=parkbench-openedge-db-observer",
        "PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE=/app/openedge/observers/db/parkbench-db-observer-v2.r",
        `PARKBENCH_OPENEDGE_IMAGE_MANIFEST=${output}/manifest.json`
      ].join("\n") + "\n"
    );
    const result = spawnSync(
      "bash",
      [path.resolve("scripts/compose.sh"), "up", "-d", "--no-deps", "control-plane"],
      {
        env: {
          ...clean(docker.env),
          PARKBENCH_ENV_FILE: path.join(root, "operator.env"),
          PARKBENCH_HOST_DATA_ROOT: root,
          PARKBENCH_DOCKER_HOST_PATH_ROOT: root,
          PARKBENCH_OPENEDGE_OUTPUT_ROOT: output
        },
        encoding: "utf8",
        timeout: 10_000
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const call = docker.calls().find((call) => call.args.includes("up"))!;
    assert.equal(call.env.PARKBENCH_OPENEDGE_OBSERVER_IMAGE, "parkbench/openedge-observer:fixture");
    assert.equal(
      call.env.PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE,
      "/app/openedge/observers/db/parkbench-db-observer-v2.r"
    );
    assert.equal(
      call.env.PARKBENCH_CONTROL_PLANE_OPENEDGE_IMAGE_MANIFEST,
      "/var/lib/parkbench/openedge/manifest.json"
    );
    assert.equal(call.env.PARKBENCH_ENV_FILE, path.join(root, "operator.env"));
  } finally {
    docker.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("observer parameter capture retries a startup failure and caches the recovered capture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-capture-retry-"));
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const adapter = path.join(root, "adapter.cjs");
  const counter = path.join(root, "calls");
  const capture = {
    contractVersion: "openedge-db-parameter-capture.v1",
    databaseName: "parkbench",
    source: "_DbParams",
    status: "complete",
    attemptedAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    rows: []
  };
  fs.writeFileSync(
    adapter,
    `#!/usr/bin/env node\nconst fs=require('fs'); const counter=${JSON.stringify(counter)}; const n=fs.existsSync(counter)?Number(fs.readFileSync(counter))+1:1; fs.writeFileSync(counter,String(n)); if(n===1){console.error('database starting');process.exit(1);} setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(capture))}),50);\n`,
    { mode: 0o755 }
  );
  const child = spawn(process.execPath, [path.resolve("dist/apps/observer/src/index.js")], {
    env: {
      ...clean(process.env),
      PARKBENCH_ENV_FILE: path.join(root, "missing.env"),
      PARKBENCH_OBSERVER_KIND: "openedge_db_v1",
      PARKBENCH_OPENEDGE_DB_METRICS_ENABLED: "false",
      PARKBENCH_METRICS_PORT: String(port),
      PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE: adapter,
      PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE: "parkbench-db-observer-v2.r"
    },
    stdio: "pipe"
  });
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  const request = (route: string) =>
    fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(2000) });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await request("/health")).ok;
      } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready, errors);
    const first = await request("/parameter-capture");
    assert.equal(first.status, 503);
    await first.text();
    const recovered = await Promise.all([
      request("/parameter-capture"),
      request("/parameter-capture")
    ]);
    for (const response of recovered) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), capture);
    }
    const cached = await request("/parameter-capture");
    assert.equal(cached.status, 200);
    await cached.text();
    assert.equal(fs.readFileSync(counter, "utf8"), "2");
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("database metric HTTP scrapes refresh cached native timestamps and expose failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-scrape-fresh-"));
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const adapter = path.join(root, "adapter.cjs"),
    counter = path.join(root, "calls");
  const fixture = path.resolve("tests/fixtures/metrics/all-table-native-v3.json");
  fs.writeFileSync(
    adapter,
    `#!/usr/bin/env node
const fs=require('fs');
const counter=${JSON.stringify(counter)};
const n=fs.existsSync(counter)?Number(fs.readFileSync(counter))+1:1;
fs.writeFileSync(counter,String(n));
if(fs.existsSync(${JSON.stringify(path.join(root, "fail"))})){process.exit(1);}
const payload=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8'));
payload.collectedAt=new Date().toISOString();
setTimeout(()=>console.log(JSON.stringify(payload)),80);
`,
    { mode: 0o755 }
  );
  const child = spawn(process.execPath, [path.resolve("dist/apps/observer/src/index.js")], {
    env: {
      ...clean(process.env),
      PARKBENCH_ENV_FILE: path.join(root, "missing.env"),
      PARKBENCH_OBSERVER_KIND: "openedge_db_v1",
      PARKBENCH_METRICS_PORT: String(port),
      PARKBENCH_OPENEDGE_DB_OBSERVER_REFRESH_MS: "10000",
      PARKBENCH_OPENEDGE_DB_OBSERVER_EXECUTABLE: adapter,
      PARKBENCH_OPENEDGE_DB_OBSERVER_PROCEDURE: "parkbench-db-observer-v2.r"
    },
    stdio: "pipe"
  });
  const request = (route: string) =>
    fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await request("/health")).ok;
      } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready);
    assert.equal(fs.readFileSync(counter, "utf8"), "1");
    assert.ok((await request("/health")).ok);
    assert.equal(fs.readFileSync(counter, "utf8"), "1");
    const values: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await request("/metrics");
      assert.equal(response.status, 200);
      const text = await response.text();
      const match = text.match(
        /^parkbench_openedge_db_table_operations_total\{[^\n]+\} \S+ (\d+)$/m
      );
      assert.ok(match, text.slice(0, 1000));
      values.push(Number(match[1]));
    }
    assert.equal(fs.readFileSync(counter, "utf8"), "4");
    assert.ok(values.every((v, i) => !i || v > values[i - 1]));
    fs.writeFileSync(path.join(root, "fail"), "");
    const failed = await request("/metrics");
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /parkbench_openedge_db_table_operations_total/);
    fs.unlinkSync(path.join(root, "fail"));
    assert.ok((await request("/metrics")).ok);
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
