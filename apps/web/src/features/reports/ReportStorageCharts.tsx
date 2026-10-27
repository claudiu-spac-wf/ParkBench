import React from "react";
import { formatContentSize, formatDistribution } from "./reportPresentation";
function ratio(value: string, total: bigint) {
  try {
    return total === 0n ? 0 : Number((BigInt(value) * 10000n) / total) / 100;
  } catch {
    return 0;
  }
}
function Bars({ title, points }: { title: string; points: any[] }) {
  let total = 0n;
  for (const p of points)
    try {
      total += BigInt(p.value);
    } catch {}
  return (
    <section className="report-chart">
      <h3>{title}</h3>
      {total === 0n ? (
        <p>No measured content for this chart.</p>
      ) : (
        <table>
          <caption>
            Top 20 plus Other. Rounded content sizes (1MB = 1,000,000 bytes); exact bytes on hover.
            Distribution is the share of content in this chart.
          </caption>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Content size</th>
              <th>Distribution</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <th>
                  {p.datasetKind ? (
                    <a
                      href={
                        window.location.hash.split("?")[0] +
                        `?dataset=${p.datasetKind}` +
                        (p.objectKey !== undefined
                          ? `&objectKey=${encodeURIComponent(p.objectKey)}&row=${p.sourceRowOrdinal}`
                          : `&areaId=${encodeURIComponent(p.areaId)}`)
                      }
                    >
                      {p.label}
                    </a>
                  ) : (
                    p.label
                  )}
                </th>
                <td>
                  <span
                    title={`${p.value} bytes`}
                    aria-label={`${formatContentSize(p.value)} (${p.value} bytes)`}
                  >
                    {formatContentSize(p.value)}
                  </span>
                </td>
                <td>
                  <div className="report-distribution">
                    <span className="report-percentage">{formatDistribution(p.value, total)}</span>
                    <span className="report-bar-track">
                      <span
                        className="report-bar"
                        aria-hidden="true"
                        style={{ width: ratio(p.value, total) + "%" }}
                      />
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
export function ReportStorageCharts({ summary }: { summary: any }) {
  if (summary.status !== "READY")
    return <p>{summary.reason ?? "Summary unavailable; retained CSV remains available."}</p>;
  return (
    <section className="report-panel">
      <h2>Full report overview</h2>
      <p>{summary.scope}</p>
      <dl className="report-provenance">
        {summary.totals.map((t: any) => (
          <React.Fragment key={t.datasetKind}>
            <dt>{t.datasetKind} content</dt>
            <dd>
              <span title={`${t.value} ${t.unit}`}>
                {t.unit === "bytes" ? formatContentSize(t.value) : `${t.value} ${t.unit}`}
              </span>{" "}
              · {t.complete ? "Complete" : "Incomplete total"}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p>
        {summary.concernObjectCount} distinct objects flagged; {summary.findingCount} metric
        findings. No findings does not establish health.
      </p>
      <Bars title="Content by area" points={summary.areas} />
      <Bars title="Content by object" points={summary.objects} />
      {summary.blockCounts.length > 0 && (
        <details>
          <summary>Block counts — separate from bytes</summary>
          <ul>
            {summary.blockCounts.map((p: any, i: number) => (
              <li key={i}>
                {p.label}: {p.value ?? "Unavailable"} blocks
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
