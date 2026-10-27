import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { csvRecords, csvRecord } from "../../apps/control-plane/src/reports/csv";
import { nativeColumns } from "../../packages/contracts/src/database-analysis-definitions";
test("stream quoted UTF8 records across every byte boundary", async () => {
  const values = ["a,b", 'quote "yes"', "line\nnext", "日本語", "9007199254740993", "?"];
  const encoded = Buffer.from(csvRecord(values));
  const rows = [];
  for await (const r of csvRecords(Readable.from([...encoded].map((x) => Buffer.from([x])))))
    rows.push(r);
  assert.deepEqual(rows, [values]);
});
test("reject invalid encoding, truncated quotes and column/record overflow", async () => {
  for (const input of [
    Buffer.from([255]),
    Buffer.from('"bad'),
    Buffer.from(Array(257).fill("a").join(",")),
    Buffer.from("a".repeat(1048577))
  ])
    await assert.rejects(async () => {
      for await (const r of csvRecords(Readable.from([input]))) void r;
    });
});
test("standalone headers carry units and unknown semantics", () => {
  const c = nativeColumns("table", ["Size", "Records", "Frag Factor", "Mystery"]);
  assert.deepEqual(
    c.map((x) => x.csvHeader),
    ["Size [bytes]", "Records [records]", "Frag Factor [ratio]", "Mystery [unit unknown]"]
  );
});
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseNative } from "../../apps/control-plane/src/reports/native-parser";
test("native conversion retains only complete records, unknown fields and source lexemes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-csv-"));
  try {
    const file = path.join(dir, "raw.txt");
    fs.writeFileSync(file, 'Size,Mystery\r\n9007199254740993,"a,b"\r\n123,"unfinished');
    const rows = [];
    const result = await parseNative(file, "table", dir, async (row) => {
      rows.push(row);
    });
    assert.equal(result.rowCount, "1");
    assert.ok(result.error);
    assert.ok(fs.readFileSync(result.staging, "utf8").includes('"Mystery [unit unknown]"'));
    assert.equal(rows[0].cells[0].exact, "9007199254740993");
    assert.equal(rows[0].cells[1].sourceText, "a,b");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("total CSV output can exceed old buffered-process limits while each record stays bounded", async () => {
  let records = 0;
  async function* chunks() {
    const row = Buffer.from('"9007199254740993","field text"\r\n');
    for (let i = 0; i < 160000; i++) yield row;
  }
  for await (const row of csvRecords(chunks())) {
    records++;
    assert.equal(row[0], "9007199254740993");
  }
  assert.equal(records, 160000);
});
