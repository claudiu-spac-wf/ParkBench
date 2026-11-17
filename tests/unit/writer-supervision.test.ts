import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writerHarness } from "../helpers/writer-supervision";
for (const [mode, outcome] of [
  ["124", "TIMEOUT"],
  ["1", "EXIT_FAILED"],
  ["missing", "MISSING"],
  ["malformed", "MALFORMED"],
  ["stale", "STALE"]
] as const)
  test(`fresh writer observation ${outcome} fails honestly without stale JSON success`, () => {
    const h = writerHarness();
    try {
      const file = path.join(h.root, "bin/mpro"),
        body = fs.readFileSync(file, "utf8");
      const fault =
        mode === "missing"
          ? "exit 0"
          : mode === "malformed"
            ? 'for arg do prefix=$arg; done; echo garbage > "$prefix.env"; echo garbage > "$prefix.json"; exit 0'
            : mode === "stale"
              ? 'for arg do prefix=$arg; done; cp startup-state.env "$prefix.env"; cp startup-state.json "$prefix.json"; touch -d "2000-01-01" "$prefix.env" "$prefix.json"; exit 0'
              : `exit ${mode}`;
      fs.writeFileSync(
        file,
        body.replace(
          "echo native >>",
          `if [ -f .parkbench-controls-ready ]; then ${fault}; fi\necho native >>`
        )
      );
      const result = h.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /database_writer_health_unavailable/);
      const e = JSON.parse(fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8"));
      assert.equal(e.capture.outcome, outcome);
      assert.ok(e.lastSuccessAt);
      assert.equal(e.observed, null);
      assert.equal(e.writerHealth, "unavailable");
    } finally {
      h.close();
    }
  });
test("writer PID reuse is loss even when membership PID is unchanged", () => {
  const h = writerHarness({ REPLACE_PID: "1" });
  try {
    const r = h.run();
    assert.match(r.stderr, /database_writer_lost/);
    const e = JSON.parse(fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8"));
    assert.equal(e.processChecks[0].matched, false);
    assert.notEqual(e.processChecks[0].startIdentity, e.processChecks[0].expectedStartIdentity);
  } finally {
    h.close();
  }
});
for (const corrupt of ["trailing-garbage", "disagreeing-inventory", "duplicate-json-document"])
  test(`valid scalar capture cannot hide ${corrupt} in fresh JSON`, () => {
    const h = writerHarness();
    try {
      const file = path.join(h.root, "bin/mpro"),
        body = fs.readFileSync(file, "utf8");
      const fault =
        corrupt === "duplicate-json-document"
          ? 'cp "$prefix.json" "$prefix.duplicate"; cat "$prefix.duplicate" >> "$prefix.json"; rm "$prefix.duplicate"'
          : corrupt === "trailing-garbage"
            ? 'echo garbage >> "$prefix.json"'
            : 'sed \'s/"apwCount":2/"apwCount":1/\' "$prefix.json" > "$prefix.bad"; mv "$prefix.bad" "$prefix.json"';
      fs.writeFileSync(file, body + `\nif [ -f .parkbench-controls-ready ]; then ${fault}; fi\n`);
      assert.match(h.run().stderr, /database_writer_health_unavailable/);
      const evidence = JSON.parse(
        fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8")
      );
      assert.equal(evidence.capture.outcome, "MALFORMED");
      assert.equal(evidence.observed, null);
      assert.equal(evidence.lastSuccessfulObservation.apwCount, 2);
    } finally {
      h.close();
    }
  });
test("unavailable process inspection fails current health without inventing writer loss", () => {
  const h = writerHarness();
  try {
    const file = path.join(h.root, "bin/ps"),
      body = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      body.replace("pid=$2;", "[ ! -f .parkbench-controls-ready ] || exit 1; pid=$2;")
    );
    assert.match(h.run().stderr, /database_writer_health_unavailable/);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(h.db, "database-run-controls.json"), "utf8")
    );
    assert.equal(evidence.processChecks[0].reason, "UNAVAILABLE");
    assert.equal(evidence.lastSuccessfulObservation.apwCount, 2);
  } finally {
    h.close();
  }
});
