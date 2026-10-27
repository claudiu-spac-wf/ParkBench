/** Fill the scrolling grid automatically while preserving bounded API responses. */
export async function loadReportDatasetRows(
  fetchPage: (query: URLSearchParams) => Promise<any>,
  input: URLSearchParams,
  signal: AbortSignal,
  publish: (result: any) => void
): Promise<any> {
  const query = new URLSearchParams(input);
  query.set("limit", "250");
  query.delete("cursor");
  const rows: any[] = [],
    ordinals = new Set<number>(),
    cursors = new Set<string>();
  let first: any,
    result: any,
    lastPublished = 0;
  function checkAbort() {
    if (signal.aborted) throw new DOMException("Grid loading cancelled", "AbortError");
  }
  for (;;) {
    checkAbort();
    const page = await fetchPage(query);
    checkAbort();
    if (!first) first = page;
    if (page.revision !== first.revision) throw new Error("report_revision_changed");
    if (
      !/^\d+$/.test(page.matchingRowCount) ||
      page.matchingRowCount !== first.matchingRowCount ||
      !Array.isArray(page.rows) ||
      (page.hasMore &&
        (!page.rows.length ||
          typeof page.nextCursor !== "string" ||
          !page.nextCursor ||
          cursors.has(page.nextCursor)))
    )
      throw new Error("report_rows_inconsistent");
    for (const row of page.rows) {
      if (
        !Number.isSafeInteger(row.sourceRowOrdinal) ||
        row.sourceRowOrdinal < 0 ||
        ordinals.has(row.sourceRowOrdinal)
      )
        throw new Error("report_rows_inconsistent");
      ordinals.add(row.sourceRowOrdinal);
      rows.push(row);
    }
    if (
      BigInt(rows.length) > BigInt(first.matchingRowCount) ||
      (!page.hasMore && BigInt(rows.length) !== BigInt(first.matchingRowCount))
    )
      throw new Error("report_rows_inconsistent");
    result = { ...page, rows: rows.slice() };
    // Publish the first batch immediately; batch subsequent render updates.
    if (!lastPublished || !page.hasMore || Date.now() - lastPublished >= 1000) {
      checkAbort();
      publish(result);
      lastPublished = Date.now();
    }
    if (!page.hasMore) break;
    cursors.add(page.nextCursor);
    query.set("cursor", page.nextCursor);
  }
  checkAbort();
  return result;
}
