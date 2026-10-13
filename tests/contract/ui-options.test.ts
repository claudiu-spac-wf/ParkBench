import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import { createControlUiFixture } from "../fixtures/control-ui";

const schema = JSON.parse(
  fs.readFileSync(path.resolve("packages/contracts/src/schemas/ui-options-v1.schema.json"), "utf8")
);
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

describe("ui-options.v1", () => {
  it("returns applicable database options without credential choices", async () => {
    const fixture = await createControlUiFixture();
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/v1/ui-options" });
      assert.equal(response.statusCode, 200);
      const options = response.json();
      assert.equal(validate(options), true, JSON.stringify(validate.errors));
      assert.equal(options.databaseParameters.contractVersion, "database-parameter-options.v2");
      assert.equal(
        options.databaseParameters.parameters.find((item: any) => item.name === "-B")?.available,
        true
      );
      assert.equal(
        options.databaseParameters.parameters.some((item: any) => item.name === "-s"),
        false
      );
      const buffers = options.databaseParameters.parameters.find((item: any) => item.name === "-B");
      assert.match(buffers.explanation, /cache.*disk/i);
      assert.ok(
        options.runParameters
          .filter((p: any) => p.canonicalName.startsWith("database."))
          .every((p: any) => p.explanation && p.description.length < p.explanation.length)
      );
      assert.equal(
        validate({
          ...options,
          databaseParameters: {
            ...options.databaseParameters,
            parameters: [{ ...buffers, explanation: 42 }]
          }
        }),
        false
      );
      const legacy = structuredClone(options);
      for (const p of [...legacy.databaseParameters.parameters, ...legacy.runParameters])
        delete p.explanation;
      assert.equal(validate(legacy), true);
      assert.equal("credentialReferences" in options, false);
      const latency = options.runParameters.find(
        (item: any) => item.canonicalName === "network.databaseLatencyMs"
      );
      assert.equal(latency?.matrixAllowed, true);
      assert.equal(latency?.maximum, 1000);
    } finally {
      await fixture.close();
    }
  });

  it("does not return a configured credential name or value", async () => {
    const fixture = await createControlUiFixture();
    fixture.platform.config.openedge.credentialRef = "credential:fixture-readonly";
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/v1/ui-options" });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.includes("fixture-readonly"), false);
      assert.equal(validate(response.json()), true);
    } finally {
      await fixture.close();
    }
  });
});
