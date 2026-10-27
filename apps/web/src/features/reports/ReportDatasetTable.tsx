import React, { useEffect, useRef, useState } from "react";
import {
  MaterialReactTable,
  useMaterialReactTable,
  MRT_ColumnDef,
  MRT_ColumnFiltersState,
  MRT_SortingState
} from "material-react-table";
import {
  ReportCell,
  ReportDataset,
  ReportRow
} from "../../../../../packages/contracts/src/database-analysis-report";
import { reportsApi } from "./reportsApi";
import { ReportMetricHelp } from "./ReportMetricHelp";
import { loadReportDatasetRows } from "./reportDatasetRows";
import { queryLoadedReportRows } from "./reportLoadedQuery";
const EMPTY_ROWS: ReportRow[] = [];
function concernLabel(value: string) {
  return value === "higher_concern"
    ? "Higher concern"
    : value === "review"
      ? "Review"
      : value === "unavailable"
        ? "Unavailable"
        : value === "not_assessed"
          ? "Not assessed"
          : "Neutral";
}
function MetricCell({ cell }: { cell: ReportCell }) {
  if (!cell) return <span>Missing</span>;
  return (
    <>
      {cell.sourceText === "" ? <span>Missing</span> : cell.sourceText}
      {cell.assessments?.map((a) => (
        <small key={a.ruleId} className={"report-concern " + a.severity}>
          {concernLabel(a.severity)}
        </small>
      ))}
      {cell.availability === "INVALID" && <small> Unavailable: invalid measurement</small>}
    </>
  );
}
export function ReportDatasetTable({
  reportId,
  dataset,
  objectKey,
  guideHref,
  sourceAreaId
}: {
  reportId: string;
  dataset: ReportDataset;
  key?: string;
  objectKey?: string;
  guideHref?: string;
  sourceAreaId?: string;
}) {
  const [search, setSearch] = useState(""),
    [area, setArea] = useState(sourceAreaId ?? ""),
    [concern, setConcern] = useState("all"),
    [sorting, setSorting] = useState([] as MRT_SortingState),
    [columnFilters, setColumnFilters] = useState([] as MRT_ColumnFiltersState),
    [columnFilterFns, setColumnFilterFns] = useState(() =>
      Object.fromEntries(
        dataset.columns.map((c) => [String(c.ordinal), c.type === "text" ? "contains" : "equals"])
      )
    ),
    [result, setResult] = useState(undefined as any),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [loading, setLoading] = useState(false);
  const rowVirtualizer = useRef(null);
  const loadedDataset = useRef(undefined as any);
  const columns = React.useMemo(
    () => [
      {
        id: "object",
        header: "Object / concern",
        accessorFn: (row) => row.label,
        enableSorting: false,
        enableColumnFilter: false,
        enablePinning: false,
        enableHiding: false,
        enableColumnOrdering: false,
        enableColumnDragging: false,
        enableColumnActions: false,
        size: 260,
        Cell: ({ row }) => (
          <>
            {row.original.label || "Native row " + row.original.sourceRowOrdinal}
            <span className={"report-concern " + row.original.concern}>
              {row.original.concern === "none"
                ? "Neutral / not assessed"
                : concernLabel(row.original.concern)}
            </span>
          </>
        )
      },
      ...dataset.columns.map((c): MRT_ColumnDef<ReportRow> => ({
        id: String(c.ordinal),
        header: c.csvHeader,
        accessorFn: (row) => row.cells[c.ordinal]?.sourceText ?? "",
        Header: () => (
          <span className="report-column-label">
            {c.csvHeader}
            <span onClick={(e) => e.stopPropagation()}>
              <ReportMetricHelp column={c} guideHref={guideHref} />
            </span>
          </span>
        ),
        Cell: ({ row }) => <MetricCell cell={row.original.cells[c.ordinal]} />,
        filterFn: c.type === "text" ? "contains" : "equals",
        columnFilterModeOptions:
          c.type === "text"
            ? ["contains", "startsWith", "endsWith", "equals", "notEquals"]
            : ["equals", "greaterThan", "greaterThanOrEqualTo", "lessThan", "lessThanOrEqualTo"],
        // Keep filter input as text: a number input can round values above 2^53.
        muiFilterTextFieldProps: {
          type: "text",
          slotProps: { htmlInput: { maxLength: 256 } }
        },
        size: c.sourceHeader.includes("Factor") ? 230 : 180
      }))
    ],
    [dataset.columns, guideHref]
  );
  const initialVisibility = React.useMemo(
    () =>
      Object.fromEntries(
        dataset.columns
          .filter((c) =>
            [
              "timestamp",
              "dbuid",
              "dbname",
              "tenancy",
              "tenancy#",
              "partitionpolicy",
              "partition",
              "partition#",
              "owner",
              "table#",
              "index#",
              "area#"
            ].includes(c.sourceHeader.toLowerCase().replace(/[\s_]/g, ""))
          )
          .map((c) => [String(c.ordinal), false])
      ),
    [dataset.columns]
  );
  const nativeFilters = columnFilters
    .filter((f) => String(f.value ?? "") !== "")
    .map((f) => ({
      column: f.id,
      operator: columnFilterFns[f.id] ?? "contains",
      value: String(f.value)
    }));
  const queryKey = JSON.stringify([
    reportId,
    dataset.kind,
    objectKey,
    search,
    area,
    concern,
    sorting,
    nativeFilters
  ]);
  useEffect(() => {
    setSearch("");
    setArea(sourceAreaId ?? "");
    setConcern("all");
    setColumnFilters([]);
  }, [objectKey, sourceAreaId]);
  useEffect(() => {
    if (!["AVAILABLE", "EMPTY"].includes(dataset.availability)) return;
    const c = new AbortController();
    setLoading(true);
    setResult(undefined);
    setError("");
    rowVirtualizer.current?.scrollToIndex(0);
    const q = new URLSearchParams({ search, concern });
    if (objectKey) q.set("objectKey", objectKey);
    if (area) q.set("areaId", area);
    if (sorting[0]) {
      q.set("sortColumn", sorting[0].id);
      q.set("sortDirection", sorting[0].desc ? "desc" : "asc");
    }
    if (nativeFilters.length) q.set("columnFilters", JSON.stringify(nativeFilters));
    const scope = reportId + ":" + dataset.kind;
    if (loadedDataset.current?.scope === scope) {
      try {
        setResult(queryLoadedReportRows(loadedDataset.current.result, q));
      } catch (e) {
        setError((e as Error).message);
      }
      setLoading(false);
      return () => c.abort();
    }
    loadReportDatasetRows(
      (query) => reportsApi.result(reportId, `datasets/${dataset.kind}/rows?${query}`, c.signal),
      q,
      c.signal,
      (r) => {
        if (!c.signal.aborted) {
          if (
            !r.hasMore &&
            !search &&
            !area &&
            !objectKey &&
            concern === "all" &&
            !nativeFilters.length &&
            !sorting.length
          )
            loadedDataset.current = { scope, result: r };
          setResult(r);
        }
      }
    )
      .then(() => {
        if (!c.signal.aborted) setLoading(false);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => c.abort();
  }, [queryKey, attempt, dataset.availability]);
  useEffect(() => {
    if (objectKey && result?.rows.length) {
      const row = document.getElementById(`${dataset.kind}-row-${result.rows[0].sourceRowOrdinal}`);
      row?.scrollIntoView({ block: "center" });
      row?.focus();
    }
  }, [objectKey, result]);
  const captionId = `${dataset.kind}-grid-caption`;
  const table = useMaterialReactTable({
    columns,
    data: result?.rows ?? EMPTY_ROWS,
    getRowId: (row) => String(row.sourceRowOrdinal),
    enableColumnOrdering: true,
    enableColumnResizing: true,
    enableColumnPinning: true,
    enableColumnFilterModes: true,
    enableMultiSort: false,
    enableGlobalFilter: false,
    manualFiltering: true,
    manualSorting: true,
    enablePagination: false,
    enableRowVirtualization: true,
    rowVirtualizerInstanceRef: rowVirtualizer,
    rowVirtualizerOptions: { overscan: 10, estimateSize: () => 48 },
    initialState: {
      density: "compact",
      columnVisibility: initialVisibility,
      columnPinning: { left: ["object"] }
    },
    state: { sorting, columnFilters, columnFilterFns, showProgressBars: loading },
    onSortingChange: (value) => {
      setSorting(value);
    },
    onColumnFiltersChange: (value) => {
      setColumnFilters(value);
    },
    onColumnFilterFnsChange: (value) => {
      setColumnFilterFns(value);
    },
    muiTableProps: { "aria-describedby": captionId },
    muiTableBodyRowProps: ({ row }) => ({
      id: `${dataset.kind}-row-${row.original.sourceRowOrdinal}`,
      tabIndex: -1
    }),
    muiTableContainerProps: { sx: { maxHeight: "65vh" } },
    enableStickyHeader: true,
    muiTablePaperProps: { elevation: 0, variant: "outlined" },
    localization: { noRecordsToDisplay: "No matching rows" }
  });
  return (
    <section className="report-panel" id={"dataset-" + dataset.kind}>
      <h2>{dataset.kind} dataset</h2>
      {(objectKey || sourceAreaId) && (
        <p>
          Source object filter active.{" "}
          <a href={window.location.hash.split("?")[0] + `?view=${dataset.kind}`}>
            Show all objects
          </a>
        </p>
      )}
      <p>
        {dataset.availability.replace(/_/g, " ")} · {dataset.rowCount} retained rows ·{" "}
        {dataset.complete ? "Complete collection" : "Incomplete evidence"}. {dataset.reason}
      </p>
      {["AVAILABLE", "EMPTY"].includes(dataset.availability) && (
        <>
          <div className="report-form">
            <label>
              Search {dataset.kind} names
              <input
                value={search}
                maxLength={256}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
              />
            </label>
            <label>
              Area ID
              <input
                value={area}
                onChange={(e) => {
                  setArea(e.target.value);
                }}
              />
            </label>
            <label>
              Concern
              <select
                value={concern}
                onChange={(e) => {
                  setConcern(e.target.value);
                }}
              >
                {["all", "review", "higher_concern", "unavailable", "none"].map((v) => (
                  <option key={v} value={v}>
                    {v.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert">
              {error}. Could not finish loading all rows. The rows below may be incomplete. Full CSV
              remains available.{" "}
              <button onClick={() => setAttempt((v) => v + 1)}>Retry rows</button>
            </p>
          )}
          {loading && (
            <p role="status">
              Loading all matching rows…
              {result ? ` ${result.rows.length} loaded of ${result.matchingRowCount}.` : ""}
            </p>
          )}
          <p id={captionId}>
            {dataset.kind}: showing {result?.rows.length ?? 0} of {result?.matchingRowCount ?? 0}{" "}
            matching rows{loading ? " (loading the rest)" : error ? " (incomplete load)" : ""};
            exact source precision. Missing markers are unavailable, not zero.
          </p>
          <div className="report-grid" aria-busy={loading}>
            <MaterialReactTable table={table} />
          </div>
        </>
      )}
    </section>
  );
}
