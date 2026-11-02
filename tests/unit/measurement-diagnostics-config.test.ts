import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../packages/contracts/src/config";
import {
  DIAGNOSTIC_DEFAULTS,
  freezeDiagnosticsConfig
} from "../../packages/contracts/src/measurement-diagnostics";
const names = [
  "SUMMARY_BYTES",
  "TRACE_BYTES",
  "PENDING_BYTES",
  "EVENT_BYTES",
  "FLUSH_MS",
  "TRACE_TTL_MS",
  "RETAINED_TRACE_BYTES"
];
test("operator defaults are bounded, summary is retained and a frozen run snapshot cannot change", () => {
  const settings = loadConfig({}).measurementDiagnostics;
  assert.deepEqual(settings, DIAGNOSTIC_DEFAULTS);
  const run = freezeDiagnosticsConfig(undefined, settings, 1000);
  Object.assign(settings, { summaryLimitBytes: 16384 });
  assert.equal(run.summaryLimitBytes, 8 * 1024 ** 2);
  assert.equal(run.mode, "summary");
  assert.equal(run.frozenAtMs, 1000);
  assert.equal(run.retentionControlBytes, 65536);
  assert.throws(() =>
    freezeDiagnosticsConfig(
      { contractVersion: "measurement-diagnostics-config.v1", mode: "off" },
      settings,
      1000
    )
  );
});
test("operator byte bounds fail before provisioning rather than silently clamp", () => {
  for (const name of names)
    for (const value of ["", "-1", "0", "NaN", "1.5", "Infinity", "5000000000000000000"]) {
      assert.throws(
        () => loadConfig({ [`PARKBENCH_DIAGNOSTICS_${name}`]: value }),
        undefined,
        `${name}=${value}`
      );
    }
  assert.throws(() =>
    loadConfig({ PARKBENCH_DIAGNOSTICS_SUMMARY_BYTES: String(64 * 1024 ** 2 + 1) })
  );
  assert.throws(() =>
    loadConfig({ PARKBENCH_DIAGNOSTICS_TRACE_BYTES: String(128 * 1024 ** 2 + 1) })
  );
  assert.throws(() => loadConfig({ PARKBENCH_DIAGNOSTICS_FLUSH_MS: "1001" }));
  assert.throws(() =>
    loadConfig({
      PARKBENCH_DIAGNOSTICS_PENDING_BYTES: "1024",
      PARKBENCH_DIAGNOSTICS_EVENT_BYTES: "4096"
    })
  );
});
test("validated operator settings accept hard ceilings and reject unknown diagnostics settings", () => {
  const settings = loadConfig({
    PARKBENCH_DIAGNOSTICS_SUMMARY_BYTES: String(64 * 1024 ** 2),
    PARKBENCH_DIAGNOSTICS_TRACE_BYTES: String(128 * 1024 ** 2),
    PARKBENCH_DIAGNOSTICS_FLUSH_MS: "50"
  }).measurementDiagnostics;
  assert.equal(settings.traceLimitBytes, 128 * 1024 ** 2);
  assert.equal(settings.flushIntervalMs, 50);
  assert.throws(() => loadConfig({ PARKBENCH_DIAGNOSTICS_BOGUS: "1" }));
});
