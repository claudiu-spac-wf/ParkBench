import React, { useState } from "react";
import {
  COMPARISON_METRIC_CATALOG,
  DEFAULT_COMPARISON_METRICS,
  type MetricSelection
} from "../../../../../packages/contracts/src/comparison-metric-selection";
import {
  toggleMetricSelection,
  supportedMetricSelection,
  removeUnavailableMetricSelection
} from "./metricSelection";
import { MetricPresetControls } from "./MetricPresetControls";
export function MetricSelectionPanel({
  selection,
  onChange,
  onDefaults
}: {
  selection: MetricSelection[];
  onChange: (metrics: MetricSelection[]) => void;
  onDefaults: () => void;
}) {
  const [open, setOpen] = useState(false),
    [domain, setDomain] = useState("all"),
    [search, setSearch] = useState("");
  return (
    <section aria-label="Comparison metrics">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Choose metrics
      </button>
      {open && (
        <>
          <p>{selection.length} selected metrics</p>
          <button onClick={() => onChange([])}>Clear metrics</button>{" "}
          <button onClick={onDefaults}>Restore default metrics</button>
          <label>
            Metric domain
            <select value={domain} onChange={(e) => setDomain(e.target.value)}>
              <option value="all">All domains</option>
              {["resource", "database", "workload", "native_latch"].map((d) => (
                <option key={d} value={d}>
                  {d.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Find metrics
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {COMPARISON_METRIC_CATALOG.filter(
            (d) =>
              (domain === "all" || d.domain === domain) &&
              d.displayName.toLowerCase().includes(search.toLowerCase())
          ).map((d) => {
            const entries = selection.filter((m) => m.metricId === d.metricId);
            return (
              <fieldset key={d.metricId}>
                <label>
                  <input
                    type="checkbox"
                    checked={!!entries.length}
                    onChange={(e) =>
                      onChange(toggleMetricSelection(selection, d.metricId, e.target.checked))
                    }
                  />
                  {d.displayName}
                </label>
                {entries.map((entry, index) => (
                  <div key={index}>
                    <span>{d.scope}</span>
                    {d.statistics.map((stat) => (
                      <label key={stat}>
                        <input
                          type="checkbox"
                          aria-label={`${d.displayName} ${stat}`}
                          checked={entry.statistics.includes(stat)}
                          onChange={(e) => {
                            const stats = e.target.checked
                              ? [...entry.statistics, stat]
                              : entry.statistics.filter((s) => s !== stat);
                            if (stats.length)
                              onChange(
                                selection.map((m) =>
                                  m === entry ? { ...m, statistics: stats } : m
                                )
                              );
                          }}
                        />
                        {stat} ({d.units[stat]})
                      </label>
                    ))}
                    {d.selectors.map((key) => (
                      <label key={key}>
                        {d.displayName} {key}
                        <input
                          aria-label={`${d.displayName} ${key}`}
                          value={entry.selectors[key] ?? ""}
                          placeholder="All recorded values"
                          onChange={(e) => {
                            const selectors = { ...entry.selectors };
                            if (e.target.value) selectors[key] = e.target.value;
                            else delete selectors[key];
                            onChange(selection.map((m) => (m === entry ? { ...m, selectors } : m)));
                          }}
                        />
                      </label>
                    ))}
                  </div>
                ))}
              </fieldset>
            );
          })}
          {supportedMetricSelection(selection).unavailable.map((choice) => (
            <p key={choice.index} className="comparison-warning">
              {choice.message}
              <button
                onClick={() => onChange(removeUnavailableMetricSelection(selection, choice.index))}
              >
                Remove unavailable choice
              </button>
            </p>
          ))}
          <MetricPresetControls selection={selection} onApply={onChange} />
        </>
      )}
    </section>
  );
}
