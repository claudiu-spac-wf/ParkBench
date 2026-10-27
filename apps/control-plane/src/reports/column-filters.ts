import { ReportColumn } from "../../../../packages/contracts/src/database-analysis-report";
import { sortComponents } from "./exact-numeric";

import { ColumnFilter } from "../../../../packages/contracts/src/database-analysis-query";
export { parseColumnFilters } from "../../../../packages/contracts/src/database-analysis-query";
const numericOperators: Record<string, string> = {
  equals: "=",
  greaterThan: ">",
  greaterThanOrEqualTo: ">=",
  lessThan: "<",
  lessThanOrEqualTo: "<="
};
export function appendColumnFilters(
  filters: ColumnFilter[],
  columns: ReportColumn[],
  where: string[],
  params: any[]
) {
  for (const filter of filters) {
    let condition: string;
    const values: any[] = [filter.column];
    if (columns[filter.column].type !== "text") {
      const { numericClass, exponent, digits } = sortComponents(filter.value);
      condition = `f.availability=0 AND f.numeric_class<2 AND (f.numeric_class,f.exponent,f.digits) ${numericOperators[filter.operator]} (?,?,?)`;
      values.push(numericClass, exponent, digits);
    } else if (["equals", "notEquals"].includes(filter.operator)) {
      condition = `f.text_value ${filter.operator === "equals" ? "=" : "!="} ? COLLATE NOCASE`;
      values.push(filter.value);
    } else {
      condition = "f.text_value LIKE ? ESCAPE '\\'";
      const literal = filter.value.replace(/[\\%_]/g, "\\$&");
      values.push(
        (filter.operator === "startsWith" ? "" : "%") +
          literal +
          (filter.operator === "endsWith" ? "" : "%")
      );
    }
    where.push(
      `EXISTS (SELECT 1 FROM report_cells f WHERE f.report_id=r.report_id AND f.kind=r.kind AND f.revision=r.revision AND f.ordinal=r.ordinal AND f.column_id=? AND ${condition})`
    );
    params.push(...values);
  }
}
