import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  privateInputValues,
  redactSecrets,
  runtimeSecretValues
} from "../../packages/contracts/src/redaction";

const { parseEnvFile } = require(path.resolve("scripts/lib/load-env.cjs"));

describe("image identity redaction", () => {
  it("keeps safe image identity while redacting environment and private-input secrets", () => {
    const privateFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-redaction-")),
      "license.txt"
    );
    fs.writeFileSync(privateFile, "private-license-material");
    const env = { PARKBENCH_CREDENTIAL_PAS_TOMCAT: "tomcat-password" };
    const secrets = [...runtimeSecretValues(env), ...privateInputValues([privateFile])];
    const output = redactSecrets(
      {
        imageIdentity: { configuredReference: "parkbench/loadgen:local", identityStrength: "tag" },
        credential: env.PARKBENCH_CREDENTIAL_PAS_TOMCAT,
        privatePath: privateFile,
        privateContents: "private-license-material"
      },
      secrets
    ) as any;
    assert.equal(output.imageIdentity.configuredReference, "parkbench/loadgen:local");
    assert.equal(JSON.stringify(output).includes("tomcat-password"), false);
    assert.equal(JSON.stringify(output).includes("private-license-material"), false);
  });

  it("does not include private values in malformed environment diagnostics", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-env-error-")),
      ".env.local"
    );
    fs.writeFileSync(file, "PARKBENCH_SECRET=quoted-value\nBROKEN LINE\n");
    assert.throws(
      () => parseEnvFile(file),
      (error: any) => {
        assert.match(error.message, /env_assignment_malformed/);
        assert.doesNotMatch(error.message, /quoted-value|PARKBENCH_SECRET/);
        return true;
      }
    );
  });
});
