import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DatasetKind,
  ReportColumn,
  ReportRow
} from "../../../../packages/contracts/src/database-analysis-report";
import { nativeColumns } from "../../../../packages/contracts/src/database-analysis-definitions";
import { canonical } from "./exact-numeric";
import { csvRecord, csvRecords } from "./csv";
export function projectedRow(
  columns: ReportColumn[],
  values: string[],
  sourceRowOrdinal: number
): ReportRow {
  const context = [
    "Area #",
    "Partition Type",
    "Tenancy",
    "Partition",
    "Owner",
    "Table",
    "Table #",
    "Index",
    "Index #",
    "Object",
    "Field",
    "Tenancy #",
    "Partition Policy",
    "Partition #",
    "LOB Obj #",
    "Object #",
    "Block Type",
    "Chain Type"
  ];
  const value = (h: string) => values[columns.findIndex((c) => c.sourceHeader === h)] ?? "";
  return {
    sourceRowOrdinal,
    objectKey: JSON.stringify(context.map(value)),
    label: [
      value("Owner"),
      value("Table") || value("Object"),
      value("Index") || value("Field") || value("Block Type") || value("Chain Type")
    ]
      .filter(Boolean)
      .join("."),
    areaId: value("Area #"),
    concern: "none",
    cells: values.map((sourceText, i) => {
      const col = columns[i],
        exact =
          col.type === "text"
            ? null
            : col.type === "integer" && !/^\d+$/.test(sourceText)
              ? null
              : canonical(sourceText);
      return {
        columnId: i,
        originalHeader: col.sourceHeader,
        semanticType: col.type,
        availabilityReason:
          sourceText === "" || sourceText === "?"
            ? "Native missing/unknown marker"
            : col.type !== "text" && exact === null
              ? "Invalid nonnegative measurement"
              : null,
        sourceText,
        exact,
        unit: col.unit,
        availability:
          sourceText === "" || sourceText === "?"
            ? "MISSING"
            : col.type !== "text" && exact === null
              ? "INVALID"
              : "AVAILABLE"
      };
    })
  };
}
export async function parseNative(
  file: string,
  kind: DatasetKind,
  outputDirectory: string,
  onRow: (row: ReportRow, columns: ReportColumn[]) => Promise<void>
) {
  const staging = path.join(outputDirectory, randomUUID() + ".tmp"),
    handle = await fs.promises.open(staging, "wx", 0o600);
  let columns: ReportColumn[] = [],
    count = 0,
    error: Error | undefined;
  try {
    for await (const values of csvRecords(fs.createReadStream(file), 1048576, true)) {
      if (!columns.length) {
        if (!values.length || new Set(values).size !== values.length)
          throw new Error("report_output_invalid");
        columns = nativeColumns(kind, values);
        await handle.write(csvRecord(columns.map((c) => c.csvHeader)));
        continue;
      }
      if (values.length !== columns.length) throw new Error("report_output_invalid");
      const row = projectedRow(columns, values, ++count);
      await onRow(row, columns);
      await handle.write(csvRecord(values));
    }
    if (!columns.length) throw new Error("report_output_invalid");
  } catch (e) {
    error = ["ENOSPC", "EDQUOT", "EACCES", "EROFS", "EMFILE"].includes((e as any).code)
      ? new Error("report_storage_failed")
      : (e as any).code === "ERR_ENCODING_INVALID_ENCODED_DATA"
        ? new Error("report_output_encoding_unsupported")
        : (e as Error);
  } finally {
    await handle.sync();
    await handle.close();
  }
  return { staging, columns, rowCount: String(count), error };
}
