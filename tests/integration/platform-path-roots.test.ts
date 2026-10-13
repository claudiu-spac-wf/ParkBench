import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { loadConfig } from "../../packages/contracts/src/config";
import { createTemporaryPathFixture, withWorkingDirectory } from "../helpers/environment-fixture";

const requireFromRepository = createRequire(path.join(process.cwd(), "package.json"));
const { resolveHostPath } = requireFromRepository(
  path.join(process.cwd(), "scripts/lib/resolve-paths.cjs")
) as {
  resolveHostPath(
    input: string,
    options?: { root?: string; allowedRoot?: string; requireExisting?: boolean }
  ): string;
};
const repositoryRoot = process.cwd();

describe("repository-root path resolution", () => {
  it("resolves relative data, input, and output settings from the repository when called elsewhere", async () => {
    const fixture = createTemporaryPathFixture("parkbench-path-cwd-");
    try {
      const config = await withWorkingDirectory(fixture.root, () =>
        loadConfig({
          PARKBENCH_DB_PATH: "Data Root/parkbench.sqlite",
          PARKBENCH_ARTIFACT_ROOT: "Data Root/artifacts",
          PARKBENCH_PROMETHEUS_TARGET_DIR: "Data Root/targets",
          PARKBENCH_DISCOVERY_WORKLOADS_ROOT: "openedge/workloads/Workloads",
          PARKBENCH_OPENEDGE_PROGRESS_ROOT: "../IMAGES",
          PARKBENCH_OPENEDGE_OUTPUT_ROOT: "Data Root/generated"
        })
      );
      assert.equal(config.dbPath, path.join(repositoryRoot, "Data Root/parkbench.sqlite"));
      assert.equal(config.artifactRoot, path.join(repositoryRoot, "Data Root/artifacts"));
      assert.equal(config.prometheusTargetDir, path.join(repositoryRoot, "Data Root/targets"));
      assert.equal(
        config.discoveryRoots?.workloads,
        path.join(repositoryRoot, "openedge/workloads/Workloads")
      );
      assert.equal(config.openedge.progressRoot, path.resolve(repositoryRoot, "../IMAGES"));
      assert.equal(config.openedge.outputRoot, path.join(repositoryRoot, "Data Root/generated"));
    } finally {
      fixture.cleanup();
    }
  });

  it("canonicalizes in-root symlinks and nearest existing ancestors for missing outputs", () => {
    const fixture = createTemporaryPathFixture("parkbench-path-space-");
    try {
      const dataRoot = fixture.resolve("data root");
      const real = path.join(dataRoot, "real");
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync("real", path.join(dataRoot, "alias"), "dir");

      assert.equal(
        resolveHostPath("data root/alias/output/run.json", {
          root: fixture.root,
          allowedRoot: dataRoot
        }),
        path.join(real, "output/run.json")
      );
      assert.equal(
        resolveHostPath("data root/alias/not-created/target", {
          root: fixture.root,
          allowedRoot: dataRoot
        }),
        path.join(real, "not-created/target")
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects dangling or root-escaping symlinks before returning a path", () => {
    const fixture = createTemporaryPathFixture("parkbench-path-boundary-");
    const outside = createTemporaryPathFixture("parkbench-path-outside-");
    try {
      const dataRoot = fixture.resolve("data");
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.symlinkSync("missing-target", path.join(dataRoot, "dangling"));
      fs.symlinkSync(outside.root, path.join(dataRoot, "escape"), "dir");

      assert.throws(
        () => resolveHostPath("data/dangling/private.dat", { root: fixture.root }),
        /path_symlink_dangling/
      );
      assert.throws(
        () =>
          resolveHostPath("data/escape/private.dat", {
            root: fixture.root,
            allowedRoot: dataRoot
          }),
        /path_outside_allowed_root/
      );
    } finally {
      outside.cleanup();
      fixture.cleanup();
    }
  });

  it("preserves Ubuntu case-sensitive input names", () => {
    const fixture = createTemporaryPathFixture("parkbench-path-case-");
    try {
      const upper = fixture.resolve("openedge/workloads/Workloads");
      const lower = fixture.resolve("openedge/workloads/workloads");
      fs.mkdirSync(upper, { recursive: true });
      fs.mkdirSync(lower, { recursive: true });
      assert.notEqual(
        resolveHostPath("openedge/workloads/Workloads", { root: fixture.root }),
        resolveHostPath("openedge/workloads/workloads", { root: fixture.root })
      );
    } finally {
      fixture.cleanup();
    }
  });
});
