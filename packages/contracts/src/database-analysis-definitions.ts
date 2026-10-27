import { DatasetKind, ReportColumn, ReportType, REPORT_VERSIONS } from "./database-analysis-report";
export const NATIVE_SUFFIX: Record<DatasetKind, string> = {
  chain: ".ch.txt",
  index: ".ix.txt",
  table: ".tab.txt",
  block: ".block.txt",
  lob: ".lob.txt"
};
export const COVERAGE: Record<ReportType, DatasetKind[]> = {
  DBANALYS: ["chain", "index", "table", "block", "lob"],
  IDXANALYS: ["index", "block"],
  TABANALYS: ["table", "block", "lob"]
};
const identifiers = [
  "Time Stamp",
  "DBUID",
  "DB name",
  "Area",
  "Area #",
  "Partition Type",
  "Tenancy",
  "Tenancy #",
  "Partition Policy",
  "Partition",
  "Partition #",
  "Object type",
  "Owner",
  "Object",
  "Object #",
  "Chain Type",
  "Table",
  "Table #",
  "Index",
  "Index #",
  "State",
  "Field",
  "LOB Obj #",
  "Block Type"
];
const measurements: Record<string, [string, "integer" | "decimal", string]> = {
  "Num Blocks": ["blocks", "integer", "Number of native blocks in this category."],
  Blocks: ["blocks", "integer", "Index blocks."],
  Size: ["bytes", "integer", "Reported object content bytes; not allocated database file size."],
  Utilization: ["%", "decimal", "Index block utilization percentage."],
  Factor: ["ratio", "decimal", "Native index factor; distinct from table fragmentation."],
  Fields: ["fields", "integer", "Index fields."],
  Levels: ["levels", "integer", "Index levels."],
  Records: ["records", "integer", "Table records."],
  LOBs: ["LOBs", "integer", "Large objects."],
  Min: ["bytes", "integer", "Minimum record or LOB size."],
  Max: ["bytes", "integer", "Maximum record or LOB size."],
  Mean: ["bytes", "integer", "Mean record or LOB size."],
  "Frag Count": ["fragments", "integer", "Native record fragments."],
  "Frag Factor": ["ratio", "decimal", "Record fragmentation factor."],
  "Scatter Factor": ["ratio", "decimal", "Record scattering factor."]
};
export function nativeColumns(kind: DatasetKind, headers: string[]): ReportColumn[] {
  return headers.map((sourceHeader, ordinal) => {
    const m = measurements[sourceHeader];
    const known = identifiers.includes(sourceHeader);
    return {
      ordinal,
      sourceHeader,
      csvHeader: m
        ? `${sourceHeader} [${m[0]}]`
        : known
          ? sourceHeader
          : `${sourceHeader} [unit unknown]`,
      type: m?.[1] ?? "text",
      unit: m?.[0] ?? null,
      description:
        m?.[2] ??
        (known
          ? `Native ${sourceHeader} identity/context.`
          : "Unknown native semantics; retained without reinterpretation.")
    };
  });
}
export const REPORT_RULES = [
  {
    id: "table-fragmentation",
    dataset: "table",
    metric: "Frag Factor",
    minimumColumn: "Records",
    minimum: "1",
    review: "1.5",
    higher: "2",
    direction: "high",
    source: "Progress guidance",
    explanation:
      "Nonempty tables: review at 1.5, higher concern at 2. A review priority, not evidence of corruption."
  },
  {
    id: "table-scatter",
    dataset: "table",
    metric: "Scatter Factor",
    minimumColumn: "Records",
    minimum: "1000",
    review: "1.5",
    higher: "2",
    direction: "high",
    source: "ParkBench heuristic",
    explanation:
      "Only tables with at least 1,000 records. Review at 1.5; higher concern at 2. Compare workload and baseline."
  },
  {
    id: "index-utilization",
    dataset: "index",
    metric: "Utilization",
    minimumColumn: "Blocks",
    minimum: "100",
    review: "50",
    higher: "25",
    direction: "low",
    source: "ParkBench heuristic",
    explanation:
      "Only indexes with at least 100 blocks. Below 50%: review; below 25%: higher concern. Growth patterns matter."
  }
] as const;
export const REPORT_GUIDANCE = {
  scope:
    "DBANALYS includes chain, index, table, block and applicable LOB data. IDXANALYS includes index and block data. TABANALYS includes table, block and applicable LOB data.",
  execution:
    "ParkBench copies the read-only seed into report-owned storage, prepares extent paths and starts a temporary database using the experiment DB entrypoint. Analysis runs inside that container. Cleanup stops the database and removes the copy; retained report files remain available.",
  queue:
    "Reports take priority over waiting experiments, FIFO. Active work finishes uninterrupted. Analyses have no automatic time limit. Cancel explicitly when needed.",
  cleanup:
    "Unconfirmed cleanup keeps the report RUNNING and capacity reserved. One worker retries five seconds after each failed attempt finishes, without a retry cutoff. Recovery needs no controller restart.",
  csv: "Download full dataset always contains all retained rows, independent of filters. Quantitative headers carry units. Unknown columns say [unit unknown]. Source precision and missing markers are preserved; incomplete evidence is labeled.",
  missing:
    "Missing, empty, not collected, unsupported and not applicable are distinct. No findings does not establish health. Source markers such as ? are unavailable, not zero.",
  references: [
    "https://docs.progress.com/bundle/openedge-database-management-128/page/Output-file-format.html",
    "https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-DBANALYS-qualifier.html",
    "https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-IDXANALYS-qualifier.html",
    "https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-TABANALYS-qualifier.html"
  ]
};
export function reportDefinitions(
  columnsVersion = REPORT_VERSIONS.columnsVersion as string,
  rulesVersion = REPORT_VERSIONS.rulesVersion as string
) {
  if (
    columnsVersion !== REPORT_VERSIONS.columnsVersion ||
    rulesVersion !== REPORT_VERSIONS.rulesVersion
  )
    throw new Error("report_definitions_version_unavailable");
  return {
    ...REPORT_VERSIONS,
    coverage: COVERAGE,
    rules: REPORT_RULES,
    guidance: REPORT_GUIDANCE,
    columns: nativeColumns("table", [...identifiers, ...Object.keys(measurements)])
  };
}
