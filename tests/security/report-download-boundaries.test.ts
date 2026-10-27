import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportDownload } from "../../apps/control-plane/src/reports/downloads";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
test("registered downloads reject ownership, missing files, symlinks and special files", async () => {
  const h = reportHarness();
  try {
    const report = h.service.create(request, "download");
    const done = await eventually(
      () => h.repo.get(report.id),
      (r) => r?.state === "COMPLETED"
    );
    const a = done.artifacts.find((a) => a.kind === "CSV" && a.datasetKind === "block"),
      file = path.join(h.artifacts.root, a.relativePath);
    assert.throws(() => reportDownload(h.artifacts, "other", a.id), /not_found/);
    const download = reportDownload(h.artifacts, done.id, a.id);
    let text = "";
    for await (const chunk of download.stream) text += chunk;
    assert.ok(text.includes("[blocks]"));
    fs.unlinkSync(file);
    assert.throws(() => reportDownload(h.artifacts, done.id, a.id), /unavailable/);
    fs.symlinkSync(path.join(h.root, "state.db"), file);
    assert.throws(() => reportDownload(h.artifacts, done.id, a.id), /invalid/);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(() => reportDownload(h.artifacts, done.id, a.id), /invalid/);
  } finally {
    h.close();
  }
});
