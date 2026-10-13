import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qualifyRunServiceUrl } from "../../apps/control-plane/src/runs/coordinator";

describe("run observer service routing", () => {
  const bundle = {
    projectName: "parkbench-run-routing",
    observerPorts: { loadgen: 43123 }
  } as any;

  it("uses the shared metrics network alias from the control-plane container", () => {
    assert.equal(
      qualifyRunServiceUrl("http://loadgen:9100", bundle, {
        PARKBENCH_CONTAINER_PATH_ROOT: "/var/lib/parkbench"
      }),
      "http://parkbench-run-routing-loadgen:9100"
    );
  });

  it("uses the published localhost port for a host-side control plane", () => {
    assert.equal(
      qualifyRunServiceUrl("http://loadgen:9100", bundle, {}),
      "http://127.0.0.1:43123"
    );
  });
});
