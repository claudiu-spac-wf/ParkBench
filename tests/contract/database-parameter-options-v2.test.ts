import assert from "node:assert/strict";
import { it } from "node:test";
import {
  databaseParameterOptions,
  validateDatabaseParameterValue,
  databaseParameterTokens,
  legacyDatabaseParameterOptions
} from "../../packages/contracts/src/database-parameter-options";
it("provides distinct concise summaries and operational explanations for every catalog entry", () => {
  const options = databaseParameterOptions({ version: "12.8.11", features: [] });
  for (const p of options.parameters) {
    assert.ok(p.explanation && p.explanation !== p.description, p.name);
    assert.ok(p.explanation.split(/\s+/).length >= 18, p.name);
    assert.doesNotMatch(
      p.explanation,
      /registry version|argument token|verification contract|source precedence/i,
      p.name
    );
  }
  const entry = (name: string) => options.parameters.find((p) => p.name === name)!;
  assert.equal(entry("-B").description, "Database memory cache size in blocks");
  assert.match(entry("-B").explanation!, /cache/i);
  assert.match(entry("-B").explanation!, /memory/i);
  assert.match(entry("-B").explanation!, /disk/i);
  assert.match(entry("-bibufs").explanation!, /before.image/i);
  assert.match(entry("-spin").explanation!, /latch/i);
  assert.match(entry("-lgTruncateFrequency").explanation!, /daily/i);
  assert.match(entry("-threadedServer").explanation!, /thread/i);
  assert.match(entry("-clstmtcachedir").explanation!, /statement/i);
  assert.match(entry("-ipver").explanation!, /IPv4/i);
});
it("publishes audited forms and bound states while retaining an explicit v1 adapter", () => {
  const options = databaseParameterOptions({ version: "12.8.11", features: [] });
  assert.equal(options.contractVersion, "database-parameter-options.v2");
  assert.ok(options.registryVersion);
  const bibufs = options.parameters.find((p) => p.name === "-bibufs")!;
  assert.deepEqual(bibufs.multiUser.minimum, { status: "documented", value: 3 });
  assert.equal(bibufs.multiUser.maximum.status, "not_specified");
  assert.equal(
    legacyDatabaseParameterOptions({ version: "12.8.11" }).contractVersion,
    "database-parameter-options.v1"
  );
  for (const p of options.parameters) {
    assert.ok(
      p.documentation.length && p.description && p.argumentForm && p.scope && p.observability
    );
  }
});
it("validates all audited applicable numeric limits, enums and real boolean forms", () => {
  const options = databaseParameterOptions({
    version: "12.8.11",
    features: [
      "enterprise",
      "after_imaging",
      "sql",
      "replication",
      "encryption",
      "multitenancy",
      "cdc"
    ]
  });
  for (const p of options.parameters.filter(
    (p) => p.available && ["integer", "decimal"].includes(p.valueKind)
  )) {
    const step = p.increment ?? (p.valueKind === "integer" ? 1 : 0.01);
    if (
      p.multiUser.minimum.status === "documented" &&
      typeof p.multiUser.minimum.value === "number"
    ) {
      const min = p.multiUser.minimum.value;
      validateDatabaseParameterValue(p.name, min);
      if (!p.allowedValues?.includes(min - step))
        assert.throws(() => validateDatabaseParameterValue(p.name, min - step), p.name);
    }
    if (
      p.multiUser.maximum.status === "documented" &&
      typeof p.multiUser.maximum.value === "number"
    ) {
      const max = p.multiUser.maximum.value;
      validateDatabaseParameterValue(p.name, max);
      assert.throws(() => validateDatabaseParameterValue(p.name, max + step), p.name);
    }
  }
  assert.deepEqual(databaseParameterTokens("-threadedServer", false), ["-threadedServer", "0"]);
  assert.deepEqual(databaseParameterTokens("-ssj", false), ["-ssj", "0"]);
  assert.deepEqual(databaseParameterTokens("-directio", false), []);
  assert.throws(() => validateDatabaseParameterValue("-ipver", "invalid"));
  assert.throws(() => validateDatabaseParameterValue("-bibufs", 2));
  assert.throws(() => validateDatabaseParameterValue("-bibufs", 3.5));
});

it("supports the documented buffer hash latch percentage at primary broker startup", () => {
  const parameter = databaseParameterOptions({ version: "12.8.11" }).parameters.find(
    (p) => p.name === "-hashLatchFactor"
  );
  assert.ok(parameter, "-hashLatchFactor must be listed");
  assert.equal(parameter.available, true);
  assert.equal(parameter.scope, "primary_database_broker");
  assert.equal(parameter.unit, "%");
  assert.equal(parameter.valueKind, "integer");
  assert.deepEqual(parameter.multiUser, {
    minimum: { status: "documented", value: 5 },
    maximum: { status: "documented", value: 100 },
    default: { status: "documented", value: 10 }
  });
  assert.match(parameter.explanation!, /percentage/);
  assert.match(parameter.explanation!, /at least two/);
  assert.match(parameter.explanation!, /restart/);
  assert.match(
    parameter.documentation[0].url,
    /openedge-startup-and-parameter-reference-128.*Buffer-Hash-Latch-Factor/
  );
  for (const value of [5, 10, 100])
    assert.deepEqual(databaseParameterTokens(parameter.name, value), [
      parameter.name,
      String(value)
    ]);
  for (const value of [4, 101, 5.5, "10", NaN, Infinity])
    assert.throws(
      () => validateDatabaseParameterValue(parameter.name, value),
      /database_parameter_invalid/
    );
});
