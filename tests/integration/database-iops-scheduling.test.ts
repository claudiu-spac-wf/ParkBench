import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scenario from "../../examples/scenarios/crud-rest.json";
import { createPlatform } from "../../apps/control-plane/src/platform";
test("preview pagination and idempotent submission freeze the same IOPS condition", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iops-scheduling-"));
  const p = createPlatform(
    {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      artifactRoot: root,
      prometheusUrl: "http://localhost:9090",
      prometheusRetention: "7d",
      openedge: {}
    },
    { testMode: true }
  );
  try {
    await p.startupRecovery;
    p.scenarios.register(scenario);
    p.controlUi.syncExistingScenarios();
    const request: any = {
      runName: "iops-scheduling",
      scenario: { id: scenario.id, version: scenario.version },
      dimensions: [
        { name: "storage.databaseIopsPreset", values: ["hdd", "unlimited"] },
        { name: "network.databaseLatencyMs", values: [0, 5] }
      ],
      repetitions: 2
    };
    const first = p.controlUi.preview(request, undefined, 3);
    assert.equal(first.cellCount, 4);
    assert.equal(first.runCount, 8);
    assert.equal(first.cells.items[0].databaseIops?.readIopsPerDevice, 150);
    let page = first;
    while (page.cells.hasMore)
      page = p.controlUi.previewCells(first.previewId, page.cells.nextPageToken, 3);
    const ex = p.controlUi.submit({ previewId: first.previewId, confirm: true }, "iops-idempotent");
    assert.equal(
      p.controlUi.submit({ previewId: first.previewId, confirm: true }, "iops-idempotent").id,
      ex.id
    );
    assert.equal(ex.runs.length, 8);
    for (const r of ex.runs) {
      const saved = p.repositories.getRun(r.id)!;
      const v: any = saved.environmentSnapshot;
      assert.deepEqual(v.databaseIops, v.requestedConfiguration.databaseIops);
      assert.deepEqual(v.databaseIops, v.variant.databaseIops);
      assert.deepEqual(
        v.databaseIops,
        (p.controlRepository.getRunMetadata(r.id)!.snapshot as any).databaseIops
      );
    }
    const omitted = p.controlUi.preview({
      ...request,
      runName: "iops-omitted",
      dimensions: [],
      repetitions: 1
    });
    assert.equal(omitted.cells.items[0].databaseIops?.presetId, "unlimited");
  } finally {
    p.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
