import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportHarness, request, eventually } from "../fixtures/reports/harness";
for (const empty of [true, false])
  test(
    empty
      ? "header-only LOB output is explicitly empty"
      : "missing LOB output fails without an invented exemption",
    async () => {
      const h = reportHarness();
      try {
        const original = h.runner.execute.bind(h.runner);
        h.runner.execute = async (...a: any[]) => {
          const result = await original(a[0], a[1], a[2]);
          const file = path.join(a[1].directory, "raw", "report.lob.txt");
          if (empty)
            fs.writeFileSync(file, fs.readFileSync(file, "utf8").split(/\r?\n/)[0] + "\r\n");
          else fs.unlinkSync(file);
          return result;
        };
        const r = h.service.create(request, "coverage");
        const done = await eventually(
          () => h.repo.get(r.id),
          (v) => v?.state === (empty ? "COMPLETED" : "FAILED")
        );
        const lob = done.datasets.find((d) => d.kind === "lob");
        assert.equal(lob.availability, empty ? "EMPTY" : "MISSING");
        assert.equal(lob.rowCount, "0");
        if (!empty) assert.equal(done.failure.code, "report_dataset_missing");
      } finally {
        h.close();
      }
    }
  );
