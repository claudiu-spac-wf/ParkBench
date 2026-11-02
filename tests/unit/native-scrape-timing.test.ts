import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpPrometheusClient } from "../../packages/metrics/src/prometheus-client";

const target = (extra: Record<string, unknown> = {}) => ({
  labels: { job: "parkbench-runs", run_id: "run-1", component: "database" },
  health: "up",
  lastScrape: new Date(Date.now() - 1000).toISOString(),
  scrapeInterval: "5s",
  scrapeTimeout: "5s",
  ...extra
});
async function withTargets(
  body: (call: number) => unknown,
  run: (client: HttpPrometheusClient, calls: () => number) => Promise<void>
) {
  let count = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/v1/targets?state=active");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body(++count)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(
      new HttpPrometheusClient("http://127.0.0.1:" + (server.address() as any).port),
      () => count
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const response = (activeTargets: unknown[]) => ({ status: "success", data: { activeTargets } });

test("native scrape timing uses the unique owned database target and actual configured interval", async () => {
  const own = target({ scrapeInterval: "1m30s" });
  await withTargets(
    () =>
      response([
        target({
          labels: { job: "parkbench-runs", run_id: "other", component: "database" },
          lastError: "PASSWORD=private-foreign"
        }),
        target({ labels: { job: "parkbench-runs", run_id: "run-1", component: "pas" } }),
        target({ labels: { job: "other", run_id: "run-1", component: "database" } }),
        own
      ]),
    async (client, calls) => {
      assert.deepEqual(await (client as any).nativeScrapeTiming("run-1", 500), {
        lastScrapeAtMs: Date.parse(own.lastScrape as string),
        cadenceMs: 90000
      });
      assert.equal(calls(), 1);
    }
  );
});

test("native scrape timing waits for startup readiness without fabricating a clock", async () => {
  await withTargets(
    (call) =>
      response([target({ health: call === 1 ? "down" : "up", lastError: "TOKEN=private" })]),
    async (client, calls) => {
      const actual = await (client as any).nativeScrapeTiming("run-1", 1000);
      assert.equal(actual.cadenceMs, 5000);
      assert.ok(Number.isSafeInteger(actual.lastScrapeAtMs));
      assert.ok(calls() >= 2);
    }
  );
});

test("ambiguous owned native targets fail rather than selecting one clock", async () => {
  await withTargets(
    () => response([target(), target()]),
    async (client) => {
      await assert.rejects(
        () => (client as any).nativeScrapeTiming("run-1", 250),
        /native_scrape_target_ambiguous/
      );
    }
  );
});

test("stale, future, malformed and absent native clocks stay unavailable with redacted errors", async () => {
  for (const fields of [
    { lastScrape: new Date(Date.now() - 60000).toISOString() },
    { lastScrape: new Date(Date.now() + 60000).toISOString() },
    { lastScrape: "0001-01-01T00:00:00Z" },
    { scrapeInterval: "0s" },
    { scrapeInterval: "not-a-duration", lastError: "PASSWORD=private" }
  ])
    await withTargets(
      () => response([target(fields)]),
      async (client) => {
        await assert.rejects(
          () => (client as any).nativeScrapeTiming("run-1", 250),
          (error: any) => {
            assert.match(error.message, /native_scrape_schedule_unavailable/);
            assert.equal(error.message, "native_scrape_schedule_unavailable");
            return true;
          }
        );
      }
    );
  await withTargets(
    () => response([]),
    async (client) => {
      await assert.rejects(
        () => (client as any).nativeScrapeTiming("run-1", 250),
        /native_scrape_schedule_unavailable/
      );
    }
  );
});

test("oversized native target responses are bounded and do not escape in errors", async () => {
  await withTargets(
    () => ({ ...response([target()]), privateBody: "x".repeat(8 * 1024 * 1024) }),
    async (client) => {
      await assert.rejects(
        () => (client as any).nativeScrapeTiming("run-1", 250),
        (error: any) => error.message === "native_scrape_schedule_unavailable"
      );
    }
  );
});
