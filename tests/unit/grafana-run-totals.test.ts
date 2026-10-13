import test from "node:test";
import assert from "node:assert/strict";
import { sumRunTotals } from "../../apps/control-plane/src/grafana/run-totals";
import { rankCanonicalTables } from "../../apps/control-plane/src/grafana/table-ranking";

const row = (run: string, epoch: string, value: string, extra: Record<string, string> = {}) => ({
  metric: { run_id: run, database_epoch: epoch, ...extra },
  value: [100, value]
});

test("run totals sum independent epochs once, isolate runs and preserve their source rows", () => {
  const rows = [row("a", "one", "10"), row("a", "two", "20"), row("b", "one", "7")];
  const before = structuredClone(rows);
  assert.deepEqual(sumRunTotals(rows), [
    { metric: { run_id: "a", aggregation: "run_total" }, value: [100, "30"] },
    { metric: { run_id: "b", aggregation: "run_total" }, value: [100, "7"] }
  ]);
  assert.deepEqual(rows, before);
});

test("totals preserve zero, propagate missing or overflowing contributions, and invent no absent run", () => {
  assert.deepEqual(sumRunTotals([]), []);
  for (const missing of ["NaN", "+Inf", "-Inf", "", "-1"]) {
    const totals = sumRunTotals([
      row("a", "one", "10"),
      row("a", "two", missing),
      row("b", "one", "0")
    ]);
    assert.equal(totals.find((r) => r.metric.run_id === "a")!.value[1], "NaN");
    assert.equal(totals.find((r) => r.metric.run_id === "b")!.value[1], "0");
  }
  assert.equal(
    sumRunTotals([row("a", "one", "1e308"), row("a", "two", "1e308")])[0].value[1],
    "NaN"
  );
  assert.throws(
    () =>
      sumRunTotals([row("a", "one", "1")], () => {
        throw new Error("deadline");
      }),
    /deadline/
  );
});

test("ranked table totals count top ten, complementary Other and CRUD writes exactly once", () => {
  for (const operation of ["read", "write"]) {
    const operations = operation === "read" ? ["read"] : ["create", "update", "delete"];
    const raw = ["a", "b"].flatMap((run) =>
      ["one", "two"].flatMap((epoch) =>
        [...Array.from({ length: 12 }, (_, i) => "T" + i), "other"].flatMap((table, i) =>
          operations.map((op) => row(run, epoch, String(i + 1), { table, operation: op }))
        )
      )
    );
    const before = structuredClone(raw);
    const ranked = rankCanonicalTables(raw, "total", operation, true, 0, 100000);
    assert.equal(ranked.length, 44, "ten tables plus Other for each run and epoch");
    const totals = sumRunTotals(ranked);
    assert.equal(totals.length, 2);
    assert.ok(totals.every((total) => total.value[1] === String(91 * 2 * operations.length)));
    assert.deepEqual(raw, before);
    const missing = structuredClone(raw);
    missing[0].value[1] = "NaN";
    const incomplete = sumRunTotals(
      rankCanonicalTables(missing, "total", operation, true, 0, 100000)
    );
    assert.equal(incomplete.find((r) => r.metric.run_id === "a")!.value[1], "NaN");
    assert.equal(
      incomplete.find((r) => r.metric.run_id === "b")!.value[1],
      String(91 * 2 * operations.length)
    );
  }
});
