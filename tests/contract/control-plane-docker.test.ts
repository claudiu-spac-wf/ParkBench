import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createPlatform } from "../../apps/control-plane/src/platform";
import { DockerDiscoveryProvider } from "../../apps/control-plane/src/catalog/docker-discovery";

describe("containerized control-plane Docker wiring", () => {
  it("packages the shared environment loader in every Node runtime image", () => {
    const runtimeDockerfiles = [
      "docker/control-plane/Dockerfile",
      "docker/loadgen/Dockerfile",
      "docker/observer/Dockerfile",
      "docker/openedge-observer/Dockerfile"
    ];

    for (const relativePath of runtimeDockerfiles) {
      const dockerfile = fs.readFileSync(path.resolve(relativePath), "utf8");
      assert.match(
        dockerfile,
        /COPY scripts\/lib\/load-env\.cjs scripts\/lib\/load-env\.cjs/,
        `${relativePath} must package the runtime environment loader`
      );
      assert.match(
        dockerfile,
        /COPY scripts\/lib\/resolve-paths\.cjs scripts\/lib\/resolve-paths\.cjs/,
        `${relativePath} must package the shared path resolver`
      );
    }
  });

  it("packages the Docker CLI and mounts the Docker Engine socket", () => {
    const dockerfile = fs.readFileSync(path.resolve("docker/control-plane/Dockerfile"), "utf8");
    const compose = fs.readFileSync(path.resolve("deploy/platform-compose.yml"), "utf8");

    assert.match(dockerfile, /apt-get install[^\n]*docker\.io/);
    assert.match(
      dockerfile,
      /COPY scripts\/lib\/docker-target\.cjs scripts\/lib\/docker-target\.cjs/
    );
    assert.match(dockerfile, /COPY scripts\/lib\/cpuset\.cjs scripts\/lib\/cpuset\.cjs/);
    assert.match(compose, /\$\{PARKBENCH_DOCKER_SOCKET_PATH[^}]*\}:\/var\/run\/docker\.sock/);
    assert.match(compose, /\$\{PARKBENCH_ENV_FILE[^}]*\}:\/app\/config\/operator\.env:ro/);
    assert.match(compose, /PARKBENCH_OPENEDGE_DB_IMAGE:/);
    assert.match(compose, /PARKBENCH_OPENEDGE_PAS_IMAGE:/);
  });

  it("packages built-in discovery roots and mounts managed roots from persistent storage", () => {
    const dockerfile = fs.readFileSync(path.resolve("docker/control-plane/Dockerfile"), "utf8");
    const compose = fs.readFileSync(path.resolve("deploy/platform-compose.yml"), "utf8");
    assert.match(dockerfile, /COPY examples\/scenarios \.\/examples\/scenarios/);
    assert.match(
      dockerfile,
      /COPY openedge\/workloads\/Workloads \.\/openedge\/workloads\/Workloads/
    );
    assert.match(compose, /PARKBENCH_DISCOVERY_SCENARIOS_ROOT: \/var\/lib\/parkbench\/scenarios/);
    assert.match(
      compose,
      /PARKBENCH_DISCOVERY_WORKLOADS_ROOT: \/var\/lib\/parkbench\/workloads/
    );
    for (const root of ["observers", "seeds", "archives"])
      assert.match(
        compose,
        new RegExp(`PARKBENCH_DISCOVERY_${root.toUpperCase()}_ROOT: \/var\/lib\/parkbench\/${root}`)
      );
    assert.match(compose, /\$\{PARKBENCH_HOST_DATA_ROOT[^}]*\}:\/var\/lib\/parkbench/);
    for (const root of ["scenarios", "workloads", "observers", "seeds", "archives"])
      assert.match(compose, new RegExp(`PARKBENCH_HOST_DISCOVERY_${root.toUpperCase()}_ROOT[^}]*}:/var/lib/parkbench/${root}`));
  });

  it("keeps configured DB and PAS images out of the disk catalog", async () => {
    const databaseImage = `parkbench/database:fixture@sha256:${"ab".repeat(32)}`;
    const pasImage = `parkbench/pas:fixture@sha256:${"cd".repeat(32)}`;
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-plane-docker",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: { dbImage: databaseImage, pasImage },
        discoveryRoots: {
          scenarios: ".parkbench/missing-scenarios",
          workloads: ".parkbench/missing-workloads",
          observers: ".parkbench/missing-observers",
          seeds: ".parkbench/missing-seeds",
          archives: ".parkbench/missing-archives"
        }
      },
      { testMode: true }
    );

    try {
      await platform.discoveryReady;
      await platform.startupRecovery;
      assert.equal(platform.config.openedge.dbImage, databaseImage);
      assert.equal(platform.config.openedge.pasImage, pasImage);
      assert.equal(platform.controlUi.listAssets({ category: "docker_images" }).length, 0);
    } finally {
      platform.close();
    }
  });

  it("keeps Docker image discovery tied to the configured tag", async () => {
    const provider = new DockerDiscoveryProvider({
      async listLocalImages() {
        return [
          {
            id: "sha256:image-id",
            repository: "parkbench/database",
            tag: "latest",
            digest: "<none>",
            labels: { "com.parkbench.role": "database" }
          },
          {
            id: "sha256:image-id",
            repository: "parkbench/database",
            tag: "stable",
            digest: "<none>",
            labels: { "com.parkbench.role": "database" }
          }
        ];
      },
      async inspectImageDetails() {
        return { RepoDigests: [], Config: { Labels: {} } };
      }
    });

    const result = await provider.discover("2026-09-19T00:00:00.000Z");
    assert.equal(result.itemCount, 2);
    assert.deepEqual(result.items.map((item) => item.name), ["parkbench/database:latest", "parkbench/database:stable"]);
  });

  it("does not persist or list Docker assets", async () => {
    const platform = createPlatform(
      {
        host: "127.0.0.1",
        port: 0,
        dbPath: ":memory:",
        artifactRoot: ".parkbench/test-control-plane-docker-filter",
        prometheusUrl: "http://localhost:9090",
        prometheusRetention: "7d",
        openedge: {}
      },
      { testMode: true }
    );
    try {
      await platform.discoveryReady;
      await platform.startupRecovery;
      assert.throws(() => platform.controlUi.registerAsset({
        kind: "docker_image",
        name: "postgres:18",
        immutableRef: "postgres:fixture@sha256:" + "c".repeat(64),
        discoverySource: "docker",
        provenance: { source: "docker", repository: "postgres" },
        verificationState: "FAILED"
      }), /operation_retired/);

      const visible = platform.controlUi
        .listAssets({ category: "docker_images" })
        .map((asset) => asset.id);
      assert.deepEqual(visible, []);
    } finally {
      platform.close();
    }
  });
});
