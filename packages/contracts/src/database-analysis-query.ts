import { ReportColumn } from "./database-analysis-report";
import { canonical } from "./exact-numeric";

export interface ColumnFilter {
  column: number;
  operator: string;
  value: string;
}
const numericOperators: Record<string, string> = {
  equals: "=",
  greaterThan: ">",
  greaterThanOrEqualTo: ">=",
  lessThan: "<",
  lessThanOrEqualTo: "<="
};
const textOperators = ["contains", "startsWith", "endsWith", "equals", "notEquals"];
export function parseColumnFilters(input: unknown, columns: ReportColumn[]): ColumnFilter[] {
  if (input === undefined) return [];
  try {
    if (typeof input !== "string" || input.length > 16384) throw new Error();
    const filters = JSON.parse(input);
    if (!Array.isArray(filters) || filters.length > 16) throw new Error();
    return filters.map((f) => {
      if (
        !f ||
        typeof f !== "object" ||
        Object.keys(f).some((k) => !["column", "operator", "value"].includes(k)) ||
        typeof f.column !== "string" ||
        typeof f.value !== "string" ||
        f.value.length > 256
      )
        throw new Error();
      const column = columns.findIndex(
        (c) => String(c.ordinal) === f.column || c.sourceHeader === f.column
      );
      if (column < 0) throw new Error();
      const numeric = columns[column].type !== "text";
      if (
        numeric ? !Object.hasOwn(numericOperators, f.operator) : !textOperators.includes(f.operator)
      )
        throw new Error();
      const value = numeric ? canonical(f.value) : f.value;
      if (value === null) throw new Error();
      return { column, operator: f.operator, value };
    });
  } catch {
    throw new Error("report_filter_invalid");
  }
}
