import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { Repositories } from "../../apps/control-plane/src/db/repositories";
import { databaseSummaryRows } from "../../packages/metrics/src/database-summary";
import { summaryRun, summaryHeader, summaryRow } from "../helpers/summary";
import { streamComparisonCsv } from "../../apps/control-plane/src/comparisons/export";
const VERSION = "measurement-summary.v1";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-stream-")),
    db = new DatabaseClient();
  db.migrate(
    fs
      .readdirSync("apps/control-plane/src/db/migrations")
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .map((n) => fs.readFileSync(path.join("apps/control-plane/src/db/migrations", n), "utf8"))
      .join("\n")
  );
  const r = new Repositories(db);
  r.saveRun(summaryRun());
  return {
    root,
    db,
    r,
    storage: new ArtifactStorage(root),
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
describe("full current-attempt summary stream", () => {
  it("stages, publishes, pages and exports every row beyond 4096 rows/2 MiB", async () => {
    const f = fixture();
    try {
      const tables = Array.from({ length: 1000 }, (_, i) => `Table${String(i).padStart(4, "0")}`),
        samples = tables.flatMap((table) =>
          [0, 1, 2].map((timestamp) => ({
            metricName: "parkbench_openedge_db_table_operations_total",
            type: "counter" as const,
            timestamp,
            value: timestamp,
            labels: {
              table,
              operation: "read",
              database_epoch: "opaque",
              run_id: "run-test"
            } as any,
            source: "fixture"
          }))
        );
      const rows = databaseSummaryRows({
          samples,
          inventory: { protocolVersion: 3, tables },
          window: { start: 0, end: 2 },
          cadenceSeconds: 1
        }),
        token = f.r.claimSummaryAttempt("run-test")!;
      for (let offset = 0; offset < rows.length; offset += 64)
        f.r.stageSummaryRows("run-test", VERSION, token, rows.slice(offset, offset + 64));
      assert.equal(f.r.pageSummaryRows("run-test").rows.length, 0);
      const header = { ...summaryHeader(), totalRowCount: rows.length, tableRowCount: 5000 };
      const artifact = await f.storage.writeSummaryAttempt(
        header,
        f.r.iterateStagedSummaryRows("run-test", VERSION, token),
        token
      );
      assert.ok(artifact.sizeBytes > 2 * 1024 * 1024);
      assert.ok(rows.length > 4096);
      f.r.publishSummary("run-test", VERSION, token, header, artifact);
      let count = 0,
        cursor: string | undefined;
      do {
        const page = f.r.pageSummaryRows("run-test", { cursor, tablesOnly: true, limit: 500 });
        count += page.rows.length;
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(count, 5000);
      assert.equal(f.r.countSummaryTableUnion("run-test"), 5000);
      assert.equal(
        f.r.findSummaryRow("run-test", rows.find((r) => r.dimensions.table === "Table0999")!.rowKey)
          ?.dimensions.table,
        "Table0999"
      );
      const reader = {
        read: (id: string) => f.r.getSummaryCache(id),
        page: (id: string, o: any) => f.r.pageSummaryRows(id, o),
        find: (id: string, key: string) => f.r.findSummaryRow(id, key),
        iterate: (id: string) => f.r.iterateSummaryRows(id)
      };
      let lines = 0,
        lastSeen = false;
      for await (const chunk of streamComparisonCsv(
        { id: "cmp-stream", variantRunIds: ["run-test"], selectionRevision: 1, createdAt: "now" },
        reader
      )) {
        lines += chunk.split("\n").length - 1;
        lastSeen ||= chunk.includes("Table0999");
      }
      assert.equal(lines, rows.length + 1);
      assert.equal(lastSeen, true);
      assert.equal(f.r.listArtifacts("run-test").length, 1);
    } finally {
      f.close();
    }
  });
  it("aborts a replaced token mid-stream and never registers its partial file", async () => {
    const f = fixture();
    try {
      const token = f.r.claimSummaryAttempt("run-test")!;
      f.r.stageSummaryRows("run-test", VERSION, token, [summaryRow("A"), summaryRow("B")]);
      const privateRows = f.r.iterateStagedSummaryRows("run-test", VERSION, token, 1);
      const rows = (async function* () {
        let count = 0;
        for await (const row of privateRows) {
          yield row;
          if (++count === 1) {
            f.db.db.exec("UPDATE run_comparison_summaries SET lease_until=0");
            f.r.claimSummaryAttempt("run-test");
          }
        }
      })();
      await assert.rejects(
        () =>
          f.storage.writeSummaryAttempt(
            { ...summaryHeader(), totalRowCount: 2, tableRowCount: 2 },
            rows,
            token
          ),
        /summary_attempt_stale/
      );
      assert.equal(f.r.listArtifacts("run-test").length, 0);
      assert.equal(f.r.pageSummaryRows("run-test").rows.length, 0);
    } finally {
      f.close();
    }
  });
  it("does not publish after a file flush failure", async () => {
    const f = fixture(),
      original = fs.promises.open;
    try {
      const token = f.r.claimSummaryAttempt("run-test")!;
      (fs.promises as any).open = async (...args: any[]) => {
        const handle = await (original as any)(...args);
        return new Proxy(handle, {
          get(target, key) {
            if (key === "sync")
              return async () => {
                throw new Error("injected_flush");
              };
            const value = (target as any)[key];
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      };
      await assert.rejects(
        () => f.storage.writeSummaryAttempt(summaryHeader(), [], token),
        /injected_flush/
      );
      assert.equal(f.r.getSummaryCache("run-test").status, "RECOMPUTING");
      assert.equal(f.r.listArtifacts("run-test").length, 0);
    } finally {
      fs.promises.open = original;
      f.close();
    }
  });
});

it("awaits disk backpressure before pulling another UTF-8 row and recovers a multi-chunk orphan", async () => {
  const f = fixture(),
    original = fs.promises.open;
  let release!: () => void,
    entered!: () => void,
    pulled = 0;
  const blocked = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  try {
    const token = f.r.claimSummaryAttempt("run-test")!,
      rows = Array.from({ length: 160 }, (_, i) =>
        summaryRow(`東京,\"quoted\\${String(i).padStart(4, "0")}\n`)
      );
    for (let offset = 0; offset < rows.length; offset += 64)
      f.r.stageSummaryRows("run-test", VERSION, token, rows.slice(offset, offset + 64));
    (fs.promises as any).open = async (...args: any[]) => {
      const handle = await (original as any)(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile")
            return async (contents: string) => {
              if (contents.includes('"definitionId"') && pulled === 1) {
                entered();
                await blocked;
              }
              return target.writeFile(contents);
            };
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
    const stream = (async function* () {
      for (const row of rows) {
        pulled++;
        yield row;
      }
    })();
    const header = { ...summaryHeader(), totalRowCount: rows.length, tableRowCount: rows.length };
    const pending = f.storage.writeSummaryAttempt(header, stream, token);
    await started;
    assert.equal(pulled, 1);
    release();
    const artifact = await pending;
    fs.promises.open = original;
    assert.ok(artifact.sizeBytes > 65536);
    const recovered = await new ArtifactStorage(f.root).recoverSummaryAttempt(
      "run-test",
      VERSION,
      token,
      f.r.iterateStagedSummaryRows("run-test", VERSION, token)
    );
    assert.ok(recovered);
    f.r.publishSummary("run-test", VERSION, token, recovered.header, recovered.artifact);
    assert.equal(
      f.r.pageSummaryRows("run-test", { tablesOnly: true, limit: 500 }).rows.length,
      rows.length
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(f.storage.safePath(artifact.path), "utf8")).rows,
      rows
    );
  } finally {
    release?.();
    fs.promises.open = original;
    f.close();
  }
});

it("cancels an in-flight summary stream without a durable current artifact or published rows", async () => {
  const f = fixture(),
    controller = new AbortController();
  try {
    const token = f.r.claimSummaryAttempt("run-test")!,
      rows = (async function* () {
        yield summaryRow("A");
        controller.abort(new Error("cancelled_stream"));
        yield summaryRow("B");
      })();
    await assert.rejects(
      () =>
        f.storage.writeSummaryAttempt(
          { ...summaryHeader(), totalRowCount: 2, tableRowCount: 2 },
          rows,
          token,
          controller.signal
        ),
      /cancelled_stream/
    );
    assert.equal(f.r.pageSummaryRows("run-test").rows.length, 0);
    assert.equal(f.r.listArtifacts("run-test").length, 0);
    assert.equal(f.r.getSummaryCache("run-test").status, "RECOMPUTING");
  } finally {
    f.close();
  }
});
