import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseClient } from "../../apps/control-plane/src/db/client";
import { ReportRepository } from "../../apps/control-plane/src/reports/repository";
import { ReportArtifacts } from "../../apps/control-plane/src/reports/artifacts";
import { reportDownload } from "../../apps/control-plane/src/reports/downloads";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("same seed reruns have isolated files retained after seed removal and reopening SQLite", async () => {
  const h = reportHarness();
  try {
    const first = h.service.create(request, "one"),
      second = h.service.create(request, "two");
    const a = await eventually(
        () => h.repo.get(first.id),
        (r) => r?.state === "COMPLETED"
      ),
      b = await eventually(
        () => h.repo.get(second.id),
        (r) => r?.state === "COMPLETED"
      );
    assert.notEqual(a.artifacts[0].relativePath, b.artifacts[0].relativePath);
    fs.rmSync(path.join(h.root, "seeds"), { recursive: true });
    const reopened = new DatabaseClient(path.join(h.root, "state.db"));
    try {
      const storage = new ReportArtifacts(
        path.join(h.root, "artifacts"),
        new ReportRepository(reopened)
      );
      const download = reportDownload(storage, a.id, a.artifacts.find((a) => a.kind === "CSV").id);
      let bytes = 0;
      for await (const c of download.stream) bytes += c.length;
      assert.ok(bytes > 0);
    } finally {
      reopened.close();
    }
  } finally {
    h.close();
  }
});
