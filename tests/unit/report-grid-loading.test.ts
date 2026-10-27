import test from "node:test";
import assert from "node:assert/strict";
import { loadReportDatasetRows } from "../../apps/web/src/features/reports/reportDatasetRows";

function response(ordinals: number[], nextCursor: string | null, overrides: any = {}) {
  return {
    revision: "revision",
    columns: [],
    rows: ordinals.map((sourceRowOrdinal) => ({ sourceRowOrdinal })),
    matchingRowCount: "3",
    nextCursor,
    hasMore: nextCursor !== null,
    ...overrides
  };
}
test("grid loader automatically collects every bounded cursor batch and preserves query options", async () => {
  const calls: string[] = [],
    counts: number[] = [];
  const result = await loadReportDatasetRows(
    async (query) => {
      calls.push(query.toString());
      return query.has("cursor") ? response([3], null) : response([1, 2], "next");
    },
    new URLSearchParams({ search: "name", sortColumn: "15", sortDirection: "desc" }),
    new AbortController().signal,
    (r) => counts.push(r.rows.length)
  );
  assert.equal(result.rows.length, 3);
  assert.deepEqual(counts, [2, 3]);
  assert.equal(calls.length, 2);
  for (const raw of calls) {
    const query = new URLSearchParams(raw);
    assert.equal(query.get("search"), "name");
    assert.equal(query.get("sortDirection"), "desc");
    assert.equal(query.get("limit"), "250");
  }
  assert.equal(new URLSearchParams(calls[1]).get("cursor"), "next");
});
test("grid loading aborts stale work without fetching or publishing another batch", async () => {
  const controller = new AbortController();
  let calls = 0,
    published = 0;
  await assert.rejects(
    loadReportDatasetRows(
      async () => {
        calls++;
        return response([1], "next");
      },
      new URLSearchParams(),
      controller.signal,
      () => {
        published++;
        controller.abort();
      }
    ),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
  assert.equal(published, 1);
  calls = 0;
  await assert.rejects(
    loadReportDatasetRows(
      async () => {
        calls++;
        return response([], null);
      },
      new URLSearchParams(),
      controller.signal,
      () => {}
    ),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);
});
test("grid loading retains its published prefix on failure and rejects inconsistent continuations", async () => {
  let calls = 0,
    loaded = 0;
  await assert.rejects(
    loadReportDatasetRows(
      async () => {
        if (++calls > 1) throw new Error("fixture_network_failed");
        return response([1], "next");
      },
      new URLSearchParams(),
      new AbortController().signal,
      (r) => (loaded = r.rows.length)
    ),
    /fixture_network_failed/
  );
  assert.equal(loaded, 1);
  for (const mode of ["revision", "count", "duplicate", "loop", "empty", "short"]) {
    calls = 0;
    await assert.rejects(
      loadReportDatasetRows(
        async () => {
          if (++calls === 1) return response([1], "next");
          return mode === "revision"
            ? response([2, 3], null, { revision: "changed" })
            : mode === "count"
              ? response([2, 3], null, { matchingRowCount: "4" })
              : mode === "duplicate"
                ? response([1, 2], null)
                : mode === "loop"
                  ? response([2], "next")
                  : mode === "empty"
                    ? response([], "again")
                    : response([2], null);
        },
        new URLSearchParams(),
        new AbortController().signal,
        () => {}
      ),
      /report_(?:revision_changed|rows_inconsistent)/
    );
  }
});
