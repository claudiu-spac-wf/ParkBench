import fs from "node:fs";
import path from "node:path";
export function nativeFixture(kind: string): string {
  const local = path.join(__dirname, "openedge-12.8", kind + ".csv");
  return fs.readFileSync(
    fs.existsSync(local)
      ? local
      : path.resolve(__dirname, "../../../../tests/fixtures/reports/openedge-12.8", kind + ".csv"),
    "utf8"
  );
}
/** Documentary 12.8 samples, not licensed-runtime evidence. */
export function tenThousandTables(): string {
  const [header, row] = nativeFixture("table").trim().split(/\r?\n/);
  return (
    header +
    "\r\n" +
    Array.from({ length: 10000 }, (_, i) =>
      row.replace("Customer", `Table_${String(i).padStart(5, "0")}`)
    ).join("\r\n") +
    "\r\n"
  );
}
