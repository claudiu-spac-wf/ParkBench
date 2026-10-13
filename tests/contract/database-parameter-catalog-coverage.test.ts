import assert from "node:assert/strict";
import { it } from "node:test";
import inventory from "../fixtures/database-parameters/reference-inventory.json";
import catalog from "../../packages/contracts/src/database-startup-parameter-catalog.json";
import { databaseParameterOptions } from "../../packages/contracts/src/database-parameter-options";
it("accounts for all 163 listed and supplemental names with audited individual topics and concrete applicability", () => {
  const source = new Set(inventory.inventories.flatMap((i) => i.entries.map((e) => e.name)));
  assert.equal(source.size, 163);
  const definitions = new Map(catalog.parameters.map((d) => [d.name, d]));
  for (const name of source) {
    const definition = catalog.parameters.find((d) => d.sourceNames.includes(name));
    assert.ok(definition, name);
    assert.ok(
      definition.description &&
        definition.documentation.length &&
        definition.scope &&
        definition.valueKind,
      name
    );
    assert.equal(definition.auditStatus, "audited");
    for (const d of definition.documentation) {
      assert.match(d.url, /^https:\/\/docs\.progress\.com\/bundle\//);
      assert.ok(d.version);
    }
    for (const kind of ["minimum", "maximum", "default"] as const)
      assert.ok(
        ["documented", "not_specified", "not_applicable"].includes(
          definition.multiUser[kind].status
        ),
        name
      );
  }
  assert.equal(definitions.size, catalog.parameters.length);
  const options = databaseParameterOptions({ version: "12.8.11", features: [] });
  assert.equal(options.parameters.length, catalog.parameters.length);
  for (const entry of options.parameters) {
    if (!entry.available)
      assert.ok(
        entry.reason && !/allowlist|performance_only|not.authored|listing.only/.test(entry.reason)
      );
  }
});
