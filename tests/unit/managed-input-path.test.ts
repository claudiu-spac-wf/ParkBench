import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalogAsset } from "../../packages/contracts/src/control-ui";
import { resolveManagedInputPath } from "../../apps/control-plane/src/catalog/managed-input-path";
import { createSeedFixture } from "../helpers/seed";

function discoveredAsset(rootKey: "seeds" | "archives", relativePath: string, content: string) {
  void content;
  return {
    id: `discovered-${rootKey}`,
    kind: rootKey === "seeds" ? "seed" : "archive",
    name: path.basename(relativePath),
    immutableRef: `input:${rootKey}/${relativePath}`,
    sourceRef: `input:${rootKey}/${relativePath}`,
    provenance: { source: "filesystem", rootKey, relativePath },
    verificationState: "VERIFIED",
    availability: "AVAILABLE",
    readiness: "READY",
    classificationState: "CLASSIFIED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as CatalogAsset;
}

describe("managed catalog input paths", () => {
  it("resolves a selected seed identity to its seed directory inside the seeds root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-managed-seed-"));
    try {
      const seed = createSeedFixture(root);
      const asset = discoveredAsset("seeds", "one_gb_lnx", "seed");
      assert.equal(asset.immutableRef, "input:seeds/one_gb_lnx");
      assert.equal(resolveManagedInputPath(asset, asset.immutableRef!, "seed", { seeds: root }), seed);

      // A folder without a <db>.db file is not a seed; a loose file is never a seed either.
      fs.mkdirSync(path.join(root, "not-a-seed"));
      fs.writeFileSync(path.join(root, "loose.tar.gz"), "archive");
      for (const relative of ["not-a-seed", "loose.tar.gz"]) {
        const candidate = discoveredAsset("seeds", relative, "x");
        assert.throws(
          () => resolveManagedInputPath(candidate, candidate.immutableRef!, "seed", { seeds: root }),
          /managed_input_path_unavailable/
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts changed file contents while rejecting unready assets and escaped paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-managed-archive-"));
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.zip`);
    try {
      const file = path.join(root, "oepas1.zip");
      fs.writeFileSync(file, "original archive");
      const asset = discoveredAsset("archives", path.basename(file), "original archive");
      fs.writeFileSync(file, "changed archive");
      assert.equal(resolveManagedInputPath(asset, asset.immutableRef!, "archive", { archives: root }), file);

      fs.writeFileSync(file, "original archive");
      const unready = { ...asset, readiness: "NOT_READY" } as CatalogAsset;
      assert.throws(
        () => resolveManagedInputPath(unready, asset.immutableRef!, "archive", { archives: root }),
        /asset_not_selectable:archive/
      );

      fs.writeFileSync(outside, "outside archive");
      fs.symlinkSync(outside, path.join(root, "escaped.zip"));
      const escaped = discoveredAsset("archives", "escaped.zip", "outside archive");
      assert.throws(
        () => resolveManagedInputPath(escaped, escaped.immutableRef!, "archive", { archives: root }),
        /managed_input_path_unavailable/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });
});
