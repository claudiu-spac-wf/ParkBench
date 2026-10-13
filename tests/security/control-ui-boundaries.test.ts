import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../../packages/contracts/src/redaction";
import { assertControlledOperationInput } from "../../apps/control-plane/src/image-operations/image-operation-service";
import { isSelectableAsset } from "../../apps/control-plane/src/catalog/asset-state";
import { DockerDiscoveryProvider } from "../../apps/control-plane/src/catalog/docker-discovery";

describe("control UI security boundaries", () => {
  it("redacts private input keys before UI responses", () => {
    const redacted: any = redactSecrets({
      password: "secret",
      credential: "secret",
      token: "secret",
      reference: "credential:readonly"
    });
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.reference, "credential:readonly");
    assert.equal(JSON.stringify(redacted).includes("secret"), false);
  });

  it("rejects arbitrary image commands and unsupported operation profiles", () => {
    assert.throws(
      () =>
        assertControlledOperationInput({
          kind: "BUILD",
          inputAssetIds: ["asset_db"],
          outputProfile: "database",
          command: "docker rm -f everything"
        }),
      /arbitrary_operation_input_forbidden/
    );
    assert.throws(
      () =>
        assertControlledOperationInput({
          kind: "BUILD",
          inputAssetIds: ["asset_db"],
          outputProfile: "arbitrary"
        }),
      (error: any) => error?.fields?.[0]?.code === "operation_profile_invalid"
    );
  });

  it("keeps Docker metadata safe and blocks stale or unclassified selection", async () => {
    const provider = new DockerDiscoveryProvider({
      async listLocalImages() {
        return [
          {
            repository: "parkbench/unknown-image",
            tag: "latest",
            digest: `sha256:${"c".repeat(64)}`,
            labels: { "com.parkbench.role": "unknown", password: "secret" }
          }
        ];
      }
    });
    const discovered = (await provider.discover()).items[0];
    assert.equal(discovered.classificationState, "UNCLASSIFIED");
    assert.equal(JSON.stringify(discovered).includes("secret"), false);
    assert.equal(isSelectableAsset(discovered as any), false);
    assert.equal(
      isSelectableAsset({
        ...discovered,
        classificationState: "CLASSIFIED",
        readiness: "READY",
        verificationState: "VERIFIED",
        availability: "STALE"
      } as any),
      false
    );
  });
});
