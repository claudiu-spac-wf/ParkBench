import { Readable } from "node:stream";
export function csvRecord(values: string[]): string {
  return values.map((v) => '"' + v.replace(/"/g, '""') + '"').join(",") + "\r\n";
}
/** Strict incremental RFC4180 decoder; bounded even for hostile native output. */
export async function* csvRecords(
  input: AsyncIterable<Uint8Array | string>,
  maxRecord = 1048576,
  requireRecordTerminator = false
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let row: string[] = [],
    field = "",
    mode: "start" | "plain" | "quoted" | "closed" = "start",
    bytes = 0,
    pendingCR = false,
    dirty = false;
  function finishField() {
    row.push(field);
    field = "";
    mode = "start";
    if (row.length > 256) throw new Error("report_csv_columns_limit");
  }
  function* consume(text: string): Generator<string[]> {
    for (const c of text) {
      if (pendingCR) {
        pendingCR = false;
        if (c === "\n") continue;
      }
      bytes += Buffer.byteLength(c);
      if (bytes > maxRecord) throw new Error("report_csv_record_limit");
      dirty = true;
      if (mode === "quoted") {
        if (c === '"') mode = "closed";
        else field += c;
        continue;
      }
      if (mode === "closed" && c === '"') {
        field += '"';
        mode = "quoted";
        continue;
      }
      if (c === ",") {
        finishField();
        continue;
      }
      if (c === "\n" || c === "\r") {
        finishField();
        const out = row;
        row = [];
        bytes = 0;
        dirty = false;
        pendingCR = c === "\r";
        yield out;
        continue;
      }
      if (mode === "closed") throw new Error("report_csv_invalid_quote");
      if (c === '"') {
        if (mode !== "start") throw new Error("report_csv_invalid_quote");
        mode = "quoted";
      } else {
        field += c;
        mode = "plain";
      }
    }
  }
  for await (const chunk of input) {
    yield* consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  }
  yield* consume(decoder.decode());
  if ((mode as string) === "quoted") throw new Error("report_csv_truncated");
  if (dirty) {
    if (requireRecordTerminator) throw new Error("report_csv_truncated");
    finishField();
    yield row;
  }
}
