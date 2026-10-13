import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CatalogAsset } from "../../packages/contracts/src/control-ui";
import {
  imageAssetMatchesReference,
  findSelectableImageAsset,
  isSelectableAsset
} from "../../apps/control-plane/src/catalog/asset-state";
import { fakeControlUiAssets } from "../../packages/test-support/src/control-ui";

describe("control UI catalog contract", () => {
  it("selects verified assets with either immutable or explicit tag identity", () => {
    assert.equal(
      isSelectableAsset({
        ...fakeControlUiAssets[0],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }),
      true
    );
    assert.equal(
      isSelectableAsset({
        ...fakeControlUiAssets[0],
        verificationState: "UNVERIFIED",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }),
      false
    );
    assert.equal(
      isSelectableAsset({
        ...fakeControlUiAssets[0],
        immutableRef: undefined,
        category: "docker_images",
        provenance: { reference: "parkbench/database:fixture", identityStrength: "tag" },
        readiness: "READY",
        availability: "AVAILABLE",
        classificationState: "CLASSIFIED",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }),
      true
    );
    assert.equal(
      isSelectableAsset({
        ...fakeControlUiAssets[0],
        immutableRef: undefined,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }),
      false
    );
  });

  it("matches configured images by repository and tag", () => {
    const asset = {
      ...fakeControlUiAssets[0],
      kind: "loadgen_image",
      category: "docker_images",
      immutableRef: `parkbench/loadgen:dev@sha256:${"0123456789abcdef".repeat(4)}`,
      provenance: {
        source: "docker",
        repository: "parkbench/loadgen",
        reference: `parkbench/loadgen:dev@sha256:${"0123456789abcdef".repeat(4)}`
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z"
    } as CatalogAsset;
    assert.equal(imageAssetMatchesReference(asset, "parkbench/loadgen:dev"), true);
    assert.equal(
      imageAssetMatchesReference(
        asset,
        `parkbench/loadgen:dev@sha256:${"abcdef0123456789".repeat(4)}`
      ),
      true
    );
  });

  it("selects the ready image when a stale record for the same tag comes first", () => {
    const reference = `parkbench/loadgen:dev@sha256:${"0123456789abcdef".repeat(4)}`;
    const stale = { ...fakeControlUiAssets[0], kind: "loadgen_image", immutableRef: reference, provenance: { reference }, availability: "STALE", readiness: "NOT_READY", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as CatalogAsset;
    const ready = { ...stale, id: "current-loadgen", availability: "AVAILABLE", readiness: "READY" } as CatalogAsset;
    assert.equal(findSelectableImageAsset([stale, ready], "parkbench/loadgen:dev")?.id, "current-loadgen");
  });
});
