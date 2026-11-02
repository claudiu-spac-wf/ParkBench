import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createObserverHttpServer } from "../../packages/observers/src/http-shutdown";

for (const headersSent of [false, true])
  test(`shutdown drains the active response and stops persistent client reuse, headers sent=${headersSent}`, async (t) => {
    let release!: () => void,
      entered!: () => void,
      captures = 0;
    const held = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve));
    const body = "public-native-result".repeat(50000);
    const lifecycle = createObserverHttpServer(async (_request, response) => {
      captures++;
      if (headersSent) {
        response.writeHead(200, { "content-length": Buffer.byteLength(body) });
        response.flushHeaders();
      }
      entered();
      await held;
      response.end(body);
    });
    await new Promise<void>((resolve) => lifecycle.server.listen(0, "127.0.0.1", resolve));
    const address = lifecycle.server.address() as { port: number };
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    let stopping: Promise<void> | undefined = undefined;
    t.after(async () => {
      release();
      agent.destroy();
      lifecycle.server.closeAllConnections();
      await stopping?.catch(() => {});
    });
    const request = () =>
      new Promise<{ body: string | null; error?: string }>((resolve) => {
        http
          .get({ host: "127.0.0.1", port: address.port, path: "/metrics", agent }, (response) => {
            let received = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (received += chunk));
            response.on("end", () => resolve({ body: received }));
            response.on("error", (error) => resolve({ body: null, error: error.message }));
          })
          .on("error", (error) => resolve({ body: null, error: error.message }));
      });
    const first = request();
    await started;
    // This request is queued behind the first on the same live keep-alive agent.
    const next = request();
    stopping = lifecycle.close();
    assert.equal(lifecycle.close(), stopping);
    release();
    assert.equal(
      (await first).body,
      body,
      "shutdown must preserve every byte of the active response"
    );
    const closed = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300))
    ]);
    assert.equal(closed, true, "shutdown cannot wait indefinitely on a reused busy connection");
    const after = await next;
    assert.equal(after.body, null, "no fresh source capture is admitted after shutdown");
    assert.equal(captures, 1);
  });

test("an aborted HTTP client cannot let shutdown seal before its native handler settles", async (t) => {
  let release!: () => void,
    entered!: () => void,
    finished = false;
  const held = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const lifecycle = createObserverHttpServer(async (_request, response) => {
    entered();
    await held;
    finished = true;
    response.end("public");
  });
  await new Promise<void>((r) => lifecycle.server.listen(0, "127.0.0.1", r));
  const port = (lifecycle.server.address() as { port: number }).port;
  const request = http.get({ host: "127.0.0.1", port, path: "/metrics" });
  request.on("error", () => {});
  await started;
  const closedClient = new Promise<void>((r) => request.once("close", r));
  request.destroy();
  await closedClient;
  let settled = false;
  const stopping = lifecycle.close().then(() => {
    settled = true;
  });
  t.after(async () => {
    release();
    lifecycle.server.closeAllConnections();
    await stopping;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, "the accepted native work still needs a terminal outcome");
  release();
  await stopping;
  assert.equal(finished, true);
});

test("shutdown before listen still permits sealing and is idempotent", async () => {
  const lifecycle = createObserverHttpServer((_request, response) => response.end("public"));
  const stopping = lifecycle.close();
  assert.equal(lifecycle.close(), stopping);
  await assert.doesNotReject(stopping);
});
