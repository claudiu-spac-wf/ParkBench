import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineApi } from "../../packages/compose-runner/src/engine-api";
test("bounded Unix API negotiates new updates and sends only directional IOPS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iops-http-")),
    socket = path.join(dir, "engine.sock");
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/version")
        res.end(JSON.stringify({ ApiVersion: "1.56", Version: "29.8.0" }));
      else if (req.url?.endsWith("/info")) res.end(JSON.stringify({ ID: "daemon-fixture" }));
      else res.end(JSON.stringify({ Warnings: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const api = new EngineApi(socket);
    await api.initialize();
    api.requireFinite();
    await api.updateIops("a".repeat(64), {
      read: [{ Path: "/dev/fixture", Rate: 150 }],
      write: [{ Path: "/dev/fixture", Rate: 150 }]
    });
    assert.deepEqual(Object.keys(requests.at(-1).body).sort(), [
      "BlkioDeviceReadIOps",
      "BlkioDeviceWriteIOps"
    ]);
    assert.match(requests.at(-1).path, /^\/v1\.55\/containers\/[a-f0-9]{64}\/update$/);
    api.apiVersion = "1.54";
    assert.throws(() => api.requireFinite(), /unsupported/);
    assert.throws(() => new EngineApi("tcp://host:2375"), /unsupported/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transport bounds errors, malformed responses and ambiguous update warnings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iops-errors-")),
    socket = path.join(dir, "engine.sock");
  let mode = "oversized";
  const server = http.createServer((_req, res) => {
    if (mode === "deadline") return;
    res.setHeader("content-type", "application/json");
    if (mode === "oversized") res.end("x".repeat(1048577));
    else if (mode === "invalid") res.end("private-secret");
    else if (mode === "status") {
      res.statusCode = 500;
      res.end("private-secret");
    } else res.end(JSON.stringify({ Warnings: ["private-secret"] }));
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const api = new EngineApi(socket);
    api.apiVersion = "1.55";
    api.daemonId = "daemon";
    for (const item of ["oversized", "invalid", "status", "deadline"]) {
      mode = item;
      await assert.rejects(api.request("GET", "/fixture", undefined, Date.now() + 100), (error) => {
        assert.ok(!String(error).includes("private-secret"));
        return true;
      });
    }
    mode = "warnings";
    await assert.rejects(
      api.updateIops("a".repeat(64), { read: [], write: [] }),
      /engine_update_warning/
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("CLI context overrides host and daemon identity must match", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iops-context-")),
    socket = path.join(dir, "engine.sock"),
    cli = path.join(dir, "docker"),
    log = path.join(dir, "calls");
  fs.writeFileSync(
    cli,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$IOPS_CLI_LOG"
if test "$1" = context; then printf '%s\\n' "$IOPS_CLI_ENDPOINT"; else printf '%s\\n' "$IOPS_CLI_DAEMON"; fi
`,
    { mode: 0o700 }
  );
  const server = http.createServer((req, res) =>
    res.end(
      JSON.stringify(
        req.url === "/version"
          ? { ApiVersion: "1.56", Version: "fixture" }
          : { ID: "daemon-fixture" }
      )
    )
  );
  await new Promise<void>((r) => server.listen(socket, r));
  const env = {
    ...process.env,
    DOCKER_CONTEXT: "chosen",
    DOCKER_HOST: "tcp://ignored:2375",
    IOPS_CLI_ENDPOINT: `unix://${socket}`,
    IOPS_CLI_DAEMON: "daemon-fixture",
    IOPS_CLI_LOG: log
  };
  try {
    const api = await EngineApi.forDocker(cli, env);
    assert.equal(api.daemonId, "daemon-fixture");
    assert.match(fs.readFileSync(log, "utf8"), /context inspect chosen/);
    fs.writeFileSync(log, "");
    await EngineApi.forDocker(cli, { ...env, DOCKER_CONTEXT: "", DOCKER_HOST: `unix://${socket}` });
    assert.ok(!fs.readFileSync(log, "utf8").includes("context inspect"));
    await assert.rejects(
      EngineApi.forDocker(cli, { ...env, IOPS_CLI_DAEMON: "wrong" }),
      /identity_or_socket/
    );
    await assert.rejects(
      EngineApi.forDocker(cli, { ...env, DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://remote:2375" }),
      /unsupported/
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only exec decodes bounded Docker frames and rejects failed or malformed streams", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iops-exec-")),
    socket = path.join(dir, "engine.sock");
  let mode = "good";
  const commands: any[] = [];
  const frame = (stream: number, text: string) => {
    const b = Buffer.from(text),
      h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(b.length, 4);
    return Buffer.concat([h, b]);
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      commands.push(body ? JSON.parse(body) : undefined);
      if (req.url?.endsWith("/start")) {
        res.end(
          mode === "bad-frame"
            ? Buffer.from("not-docker")
            : frame(mode === "stderr" ? 2 : 1, "owned-policy")
        );
      } else if (req.url?.endsWith("/exec")) res.end(JSON.stringify({ Id: "b".repeat(64) }));
      else res.end(JSON.stringify({ Running: false, ExitCode: mode === "failed" ? 1 : 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const api = new EngineApi(socket);
    api.apiVersion = "1.55";
    assert.equal(
      await api.execReadonly("a".repeat(64), ["sh", "-c", "read-only-fixture"], Date.now() + 1000),
      "owned-policy"
    );
    assert.deepEqual(commands[0], {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["sh", "-c", "read-only-fixture"]
    });
    for (const next of ["bad-frame", "stderr", "failed"]) {
      mode = next;
      await assert.rejects(
        api.execReadonly("a".repeat(64), ["sh", "-c", "fixture"], Date.now() + 1000),
        /unconfirmed/
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("owned unlimited reset preserves exact uint64 precision on both API directions", async () => {
  const { DATABASE_IOPS_UNLIMITED_RATE } =
    await import("../../packages/contracts/src/database-iops");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iops-max-")),
    socket = path.join(dir, "engine.sock");
  let sent = "";
  const server = http.createServer((req, res) => {
    req.on("data", (c) => (sent += c));
    req.on("end", () => {
      res.end(
        req.method === "POST"
          ? '{"Warnings":null}'
          : '{"HostConfig":{"BlkioDeviceReadIOps":[{"Path":"/dev/fixture","Rate":18446744073709551615}]}}'
      );
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const api = new EngineApi(socket);
    api.apiVersion = "1.55";
    api.daemonId = "fixture";
    await api.updateIops("a".repeat(64), {
      read: [{ Path: "/dev/fixture", Rate: DATABASE_IOPS_UNLIMITED_RATE }],
      write: [{ Path: "/dev/fixture", Rate: DATABASE_IOPS_UNLIMITED_RATE }]
    });
    assert.equal((sent.match(/"Rate":18446744073709551615/g) ?? []).length, 2);
    const inspected = await api.inspect("a".repeat(64));
    assert.equal(inspected.HostConfig.BlkioDeviceReadIOps[0].Rate, DATABASE_IOPS_UNLIMITED_RATE);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
