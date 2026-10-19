import React, { useRef, useState } from "react";
import {
  COMPARISON_METRIC_CATALOG,
  type MetricSelection,
  type MetricStatistic
} from "../../../../../packages/contracts/src/comparison-metric-selection";
import {
  toggleMetricSelection,
  supportedMetricSelection,
  removeUnavailableMetricSelection,
  changeMetricStatistic
} from "./metricSelection";
import { MetricPresetControls } from "./MetricPresetControls";
import { FieldHelp } from "../../shared/FieldHelp";

const aggregateStatistics: Array<[MetricStatistic, string]> = [
  ["average", "Avg"],
  ["p90", "p90"],
  ["p95", "p95"],
  ["total", "Total"]
];

export function MetricSelectionPanel({
  selection,
  onChange,
  onDefaults
}: {
  selection: MetricSelection[];
  onChange: (metrics: MetricSelection[]) => void;
  onDefaults: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("all");
  const [search, setSearch] = useState("");
  const prefix = React.useId();
  const keys = useRef(new WeakMap<MetricSelection, number>());
  const nextKey = useRef(1);
  const pendingFocus = useRef(undefined as { target: string; fallback: string } | undefined);
  const keyFor = (entry: MetricSelection) => {
    let key = keys.current.get(entry);
    if (key === undefined) {
      key = nextKey.current++;
      keys.current.set(entry, key);
    }
    return `${prefix}-metric-${key}`;
  };
  React.useLayoutEffect(() => {
    const focus = pendingFocus.current;
    if (!focus) return;
    pendingFocus.current = undefined;
    (document.getElementById(focus.target) ?? document.getElementById(focus.fallback))?.focus();
  }, [selection]);
  const supported = supportedMetricSelection(selection);
  const valid = new Set(supported.metrics);
  const descriptors = COMPARISON_METRIC_CATALOG.filter(
    (descriptor) =>
      (domain === "all" || descriptor.domain === domain) &&
      descriptor.displayName.toLowerCase().includes(search.toLowerCase())
  );
  const visibleEntries = descriptors.flatMap((descriptor) =>
    selection.filter((entry) => entry.metricId === descriptor.metricId && valid.has(entry))
  );
  const keepKey = (old: MetricSelection, replacement: MetricSelection) => {
    keyFor(old);
    keys.current.set(replacement, keys.current.get(old)!);
  };

  return (
    <section aria-label="Comparison metrics" className="metric-selection">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Choose metrics
      </button>
      {open && (
        <>
          <p>{selection.length} selected metrics</p>
          <div className="button-row metric-selection-actions">
            <button onClick={() => onChange([])}>Clear metrics</button>
            <button onClick={onDefaults}>Restore default metrics</button>
          </div>
          <label>
            Metric domain
            <select value={domain} onChange={(event) => setDomain(event.target.value)}>
              <option value="all">All domains</option>
              {["resource", "database", "workload", "native_latch"].map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Find metrics
            <input value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          {descriptors.map((descriptor) => {
            const matching = selection
              .map((entry, index) => ({ entry, index }))
              .filter(({ entry }) => entry.metricId === descriptor.metricId);
            const entries = matching.filter(({ entry }) => valid.has(entry));
            const rows = entries.length ? entries : [{ entry: undefined, index: -1 }];
            const masterId = `${prefix}-${descriptor.metricId}-enable`;
            return (
              <fieldset
                className="metric-definition"
                key={descriptor.metricId}
                aria-label={`${descriptor.displayName} statistics`}
              >
                {rows.map(({ entry, index }, rowIndex) => {
                  const rowId = entry ? keyFor(entry) : `${prefix}-${descriptor.metricId}-inactive`;
                  const context = entry
                    ? Object.entries(entry.selectors)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(", ")
                    : "";
                  const suffix = entries.length > 1 ? ` (${context || "all recorded values"})` : "";
                  const statistics = descriptor.statistics.includes("value")
                    ? [...aggregateStatistics, ["value", "Value"] as [MetricStatistic, string]]
                    : aggregateStatistics;
                  return (
                    <div className="metric-entry" key={rowId}>
                      <div className="metric-choice-row" data-metric-id={descriptor.metricId}>
                        {rowIndex === 0 ? (
                          <label className="metric-name">
                            <input
                              id={masterId}
                              type="checkbox"
                              aria-label={descriptor.displayName}
                              checked={matching.length > 0}
                              onChange={(event) =>
                                onChange(
                                  toggleMetricSelection(
                                    selection,
                                    descriptor.metricId,
                                    event.target.checked
                                  )
                                )
                              }
                            />
                            <span>{descriptor.displayName}</span>
                          </label>
                        ) : (
                          <span className="metric-name">{descriptor.displayName}</span>
                        )}
                        {statistics.map(([statistic, label]) => {
                          const available = descriptor.statistics.includes(statistic);
                          const enabled = available && !!entry;
                          const name = `${descriptor.displayName} ${statistic}${suffix}`;
                          const reason = !available
                            ? `This metric does not support ${label}.`
                            : !entry
                              ? matching.length
                                ? "Remove or replace the unavailable recorded choice, then enable this metric to choose statistics."
                                : "Enable this metric to choose statistics."
                              : `Unit: ${descriptor.units[statistic] ?? "recorded units"}.`;
                          return (
                            <div className="metric-stat" key={statistic}>
                              <label htmlFor={`${rowId}-${statistic}`}>
                                <span>{label}:</span>
                                <input
                                  id={`${rowId}-${statistic}`}
                                  type="checkbox"
                                  aria-label={name}
                                  checked={enabled && entry!.statistics.includes(statistic)}
                                  disabled={!enabled}
                                  onChange={(event) => {
                                    const next = changeMetricStatistic(
                                      selection,
                                      index,
                                      statistic,
                                      event.target.checked
                                    );
                                    if (next === selection) return;
                                    if (next.length === selection.length)
                                      keepKey(entry!, next[index]);
                                    else {
                                      const position = visibleEntries.indexOf(entry!);
                                      const neighbour =
                                        visibleEntries[position + 1] ??
                                        visibleEntries[position - 1];
                                      const firstStatistic = descriptors.find(
                                        (item) => item.metricId === neighbour?.metricId
                                      )?.statistics[0];
                                      pendingFocus.current = {
                                        target: neighbour
                                          ? `${keyFor(neighbour)}-${firstStatistic}`
                                          : masterId,
                                        fallback: masterId
                                      };
                                    }
                                    onChange(next);
                                  }}
                                />
                              </label>
                              <FieldHelp label={name}>{reason}</FieldHelp>
                            </div>
                          );
                        })}
                      </div>
                      {entry && (
                        <>
                          <small className="metric-context">
                            {descriptor.scope}
                            {context ? ` · ${context}` : ""}
                          </small>
                          {descriptor.selectors.length > 0 && (
                            <div className="metric-selectors">
                              {descriptor.selectors.map((key) => (
                                <label key={key}>
                                  {descriptor.displayName} {key}
                                  {suffix}
                                  <input
                                    aria-label={`${descriptor.displayName} ${key}${suffix}`}
                                    value={entry.selectors[key] ?? ""}
                                    placeholder="All recorded values"
                                    onChange={(event) => {
                                      const selectors = { ...entry.selectors };
                                      if (event.target.value) selectors[key] = event.target.value;
                                      else delete selectors[key];
                                      const replacement = { ...entry, selectors };
                                      keepKey(entry, replacement);
                                      onChange(
                                        selection.map((item, itemIndex) =>
                                          itemIndex === index ? replacement : item
                                        )
                                      );
                                    }}
                                  />
                                </label>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            );
          })}
          {supported.unavailable.map((choice) => (
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
