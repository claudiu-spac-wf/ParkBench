import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStorage } from "../../apps/control-plane/src/artifacts/storage";
import {
  mapContainerPath,
  ownershipLabels,
  selectOwnedResources,
  checkImageReference,
  generateRunCompose
} from "../../packages/compose-runner/src";
import scenario from "../../examples/scenarios/crud-rest.json";
import {
  privateInputValues,
  redactSecrets,
  runtimeSecretValues
} from "../../packages/contracts/src";
describe("security boundaries", () => {
  it("rejects artifact traversal and protects unrelated resources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-security-"));
    const storage = new ArtifactStorage(root);
    assert.throws(() => storage.safePath("../secret"), /artifact_path_outside_root/);
    const owned = {
      resourceType: "container" as const,
      resourceId: "one",
      labels: ownershipLabels("run-1", "exp-1", "db"),
      createdAt: new Date().toISOString()
    };
    const unrelated = {
      ...owned,
      resourceId: "two",
      labels: ownershipLabels("run-2", "exp-1", "db")
    };
    assert.equal(selectOwnedResources([owned, unrelated], "run-1").length, 1);
  });

  it("maps only control-plane paths below the host-shared root", () => {
    assert.equal(
      mapContainerPath("/var/lib/parkbench/runs/run.yml", "/var/lib/parkbench", "/srv/parkbench"),
      "/srv/parkbench/runs/run.yml"
    );
    assert.equal(
      mapContainerPath("/etc/passwd", "/var/lib/parkbench", "/srv/parkbench"),
      "/etc/passwd"
    );
    assert.throws(
      () => mapContainerPath("/var/lib/parkbench/run.yml", "/var/lib/parkbench", "relative"),
      /docker_host_path_mapping_required/
    );
  });

  it("keeps symlink-escape errors free of private path details", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-path-error-"));
    const containerRoot = path.join(root, "container-data");
    const outside = path.join(root, "private-license-inputs");
    fs.mkdirSync(containerRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(containerRoot, "escape"), "dir");
    const privatePath = path.join(containerRoot, "escape", "private-seed-credential.zip");
    try {
      assert.throws(
        () => mapContainerPath(privatePath, containerRoot, path.join(root, "docker-host")),
        (error: unknown) => {
          assert.match(String(error), /path_outside_allowed_root/);
          assert.doesNotMatch(String(error), /private-license-inputs|private-seed-credential/);
          return true;
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires explicit non-latest support-image tags and propagates them into run bundles", () => {
    assert.doesNotThrow(() => checkImageReference("parkbench/loadgen:0.1.0"));
    assert.throws(
      () => checkImageReference("parkbench/loadgen:latest"),
      /image_reference_latest_forbidden/
    );
    assert.throws(() => checkImageReference("parkbench/loadgen"), /image_reference_tag_required/);
    assert.throws(
      () =>
        generateRunCompose("run-unpinned", "exp-unpinned", scenario as any, {
          db: "db",
          pas: "pas"
        }),
      /image_reference_tag_required/
    );
    const loadgen = "parkbench/loadgen:0.1.0";
    const observer = "parkbench/observer:0.1.0";
    assert.doesNotThrow(() => checkImageReference(loadgen));
    const bundle = generateRunCompose(
      "run-support",
      "exp-support",
      scenario as any,
      { db: loadgen, pas: observer },
      { loadgenImage: loadgen, observerImage: observer }
    );
    assert.match(bundle.file, new RegExp(`image: ${loadgen}`));
    assert.match(bundle.file, new RegExp(`image: ${observer}`));
    assert.match(
      bundle.file,
      /run-private:\n    name: parkbench-run-support_run-private\n    labels:/
    );
    assert.match(
      bundle.file,
      /run-db-data:\n    name: parkbench-run-support_run-db-data\n    labels:/
    );
    assert.match(bundle.file, /parkbench\.run_id: "run-support"/);
  });

  it("preserves safe credential references while redacting runtime values", () => {
    const value = redactSecrets(
      {
        credentialRef: "credential:pas-readonly",
        password: "runtime-secret",
        message: "Authorization: Bearer runtime-secret"
      },
      ["runtime-secret"]
    ) as any;
    assert.equal(value.credentialRef, "credential:pas-readonly");
    assert.equal(value.password, "[REDACTED]");
    assert.doesNotMatch(value.message, /runtime-secret/);
  });

  it("redacts environment-backed credentials and private input contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parkbench-redaction-"));
    const credentialFile = path.join(root, "credential.txt");
    const privateInput = path.join(root, "seed.txt");
    fs.writeFileSync(credentialFile, "file-backed-secret");
    fs.writeFileSync(privateInput, "private-seed-content");
    const runtimeValues = runtimeSecretValues({
      PARKBENCH_CREDENTIAL_DEMO: "environment-secret",
      PARKBENCH_CREDENTIAL_FILE_DEMO: credentialFile
    });
    const privateValues = privateInputValues([privateInput]);
    const redacted = redactSecrets(`environment-secret file-backed-secret private-seed-content`, [
      ...runtimeValues,
      ...privateValues
    ]) as string;
    assert.equal(redacted, "[REDACTED] [REDACTED] [REDACTED]");
  });
});
