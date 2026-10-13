import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("platform image settings", () => {
  it("allows the ParkBench Grafana dashboard to render in the UI iframe", () => {
    const compose = fs.readFileSync("deploy/platform-compose.yml", "utf8");
    const grafanaService =
      compose.split(/^  grafana:\s*$/m)[1]?.split(/^  [a-z0-9_-]+:\s*$/m)[0] ?? "";
    assert.match(grafanaService, /GF_SECURITY_ALLOW_EMBEDDING:\s*["']?true["']?/);
    assert.match(grafanaService, /GF_AUTH_ANONYMOUS_ENABLED:\s*["']?true["']?/);
    assert.match(grafanaService, /GF_AUTH_ANONYMOUS_ORG_ROLE:\s*["']?Viewer["']?/);
  });

  it("uses environment-backed images and build arguments for every platform base", () => {
    const compose = fs.readFileSync("deploy/platform-compose.yml", "utf8");
    for (const key of [
      "PARKBENCH_IMAGE_TAG",
      "PARKBENCH_PROMETHEUS_IMAGE",
      "PARKBENCH_GRAFANA_IMAGE",
      "PARKBENCH_CADVISOR_IMAGE",
      "PARKBENCH_NODE_EXPORTER_IMAGE",
      "PARKBENCH_NODE_BASE_IMAGE",
      "PARKBENCH_NGINX_IMAGE",
      "PARKBENCH_LOADGEN_IMAGE",
      "PARKBENCH_OBSERVER_IMAGE"
    ])
      assert.match(compose, new RegExp(`\\$\\{${key}[:?]`));
    assert.doesNotMatch(compose, /image:\s+(?:prom|grafana|gcr\.io|quay\.io)\//);
    assert.match(compose, /NODE_BASE_IMAGE:/);
    assert.match(compose, /NGINX_IMAGE:/);
    assert.match(compose, /image: parkbench\/control-plane:\$\{PARKBENCH_IMAGE_TAG/);
    assert.match(compose, /image: parkbench\/web:\$\{PARKBENCH_IMAGE_TAG/);
    assert.match(
      compose,
      /PARKBENCH_OPENEDGE_OBSERVER_IMAGE: \$\{PARKBENCH_OPENEDGE_OBSERVER_IMAGE:-\}/
    );
  });

  it("declares every FROM argument before the first build stage", () => {
    for (const file of [
      "docker/control-plane/Dockerfile",
      "docker/web/Dockerfile",
      "docker/loadgen/Dockerfile",
      "docker/observer/Dockerfile",
      "docker/openedge-db/Dockerfile",
      "docker/openedge-pasoe/Dockerfile",
      "docker/openedge-observer/Dockerfile"
    ]) {
      const globalArgs = new Map<string, string | undefined>();
      let reachedFirstFrom = false;
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const arg = line.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?\s*$/);
        if (!reachedFirstFrom && arg) globalArgs.set(arg[1], arg[2]);
        if (/^\s*FROM\b/.test(line)) {
          reachedFirstFrom = true;
          for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
            assert.equal(
              Boolean(globalArgs.get(match[1])),
              true,
              `${file}: ${match[1]} must have a valid default before the first FROM`
            );
        }
      }
    }
  });

  it("installs Docker Compose as a CLI plugin in the control-plane image", () => {
    const dockerfile = fs.readFileSync("docker/control-plane/Dockerfile", "utf8");
    assert.match(dockerfile, /docker-compose-linux-\$\{compose_arch\}/);
    assert.match(dockerfile, /\/usr\/local\/lib\/docker\/cli-plugins\/docker-compose/);
    assert.match(dockerfile, /docker compose version/);
  });

  it("copies contracts sources imported by the browser into the web image build context", () => {
    const dockerfile = fs.readFileSync("docker/web/Dockerfile", "utf8");
    const matrixEditor = fs.readFileSync("apps/web/src/features/experiments/MatrixExperimentPage.tsx", "utf8");
    assert.match(dockerfile, /COPY packages\/contracts\/src packages\/contracts\/src/);
    assert.doesNotMatch(matrixEditor, /packages\/contracts\/src\/allowed-parameters/);
    assert.match(matrixEditor, /getUiOptions/);
  });
});
