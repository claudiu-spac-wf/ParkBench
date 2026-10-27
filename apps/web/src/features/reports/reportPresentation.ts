import {
  ReportCell,
  ReportColumn
} from "../../../../../packages/contracts/src/database-analysis-report";
/** Decimal SI units; preserve authoritative bytes as strings outside these display labels. */
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
function hundredths(value: bigint) {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return whole.toString() + (fraction ? "." + fraction : "");
}
export function formatContentSize(value: string): string {
  if (!/^\d+$/.test(value)) return "Unavailable";
  return sizedBytes(value, "B");
}
function sizedBytes(value: string, byteUnit: string): string {
  const [whole, fraction = ""] = value.split(".");
  const bytes = BigInt(whole + fraction);
  let divisor = 10n ** BigInt(fraction.length),
    unit = 0;
  while (bytes >= divisor * 1000n && unit < UNITS.length - 1) {
    divisor *= 1000n;
    unit++;
  }
  let rounded = (bytes * 100n + divisor / 2n) / divisor;
  if (rounded >= 100000n && unit < UNITS.length - 1) {
    divisor *= 1000n;
    unit++;
    rounded = (bytes * 100n + divisor / 2n) / divisor;
  }
  return hundredths(rounded) + (unit === 0 ? byteUnit : UNITS[unit]);
}
export function reportColumnLabel(column: ReportColumn): string {
  return column.sourceHeader;
}
export function formatReportCell(cell: ReportCell, column: ReportColumn): string {
  const raw = column.type === "text" ? cell.sourceText : cell.sourceText.trim();
  if (!raw) return "Missing";
  if (cell.availability !== "AVAILABLE" || cell.exact === null) return raw;
  if (column.unit === "%") return raw + "%";
  if (column.unit === "bytes") return sizedBytes(cell.exact, "b");
  return raw;
}
export function formatDistribution(value: string, total: bigint): string {
  if (!/^\d+$/.test(value) || total <= 0n) return "0%";
  const amount = BigInt(value);
  const rounded = (amount * 10000n + total / 2n) / total;
  return amount > 0n && rounded === 0n ? "<0.01%" : hundredths(rounded) + "%";
}
