import React, { useEffect, useState, useRef } from "react";
import type { MetricSelection } from "../../../../../packages/contracts/src/comparison-metric-selection";
import {
  createMetricPresetStore,
  PRESET_STORAGE_KEY,
  presetWarnings,
  type MetricPreset
} from "./metricPresets";
export function MetricPresetControls({
  selection,
  onApply
}: {
  selection: MetricSelection[];
  onApply: (metrics: MetricSelection[]) => void;
}) {
  const store = useRef(createMetricPresetStore()),
    [presets, setPresets] = useState([] as MetricPreset[]),
    [chosen, setChosen] = useState(undefined as MetricPreset | undefined),
    [name, setName] = useState(""),
    [message, setMessage] = useState("");
  const refresh = () => {
    const r = store.current.read();
    setPresets(r.presets);
    setMessage(r.warning ?? "");
  };
  useEffect(() => {
    refresh();
    const listener = (e: StorageEvent) => {
      if (e.key === PRESET_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  const act = (fn: () => void) => {
    try {
      fn();
      refresh();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  return (
    <fieldset>
      <legend>Browser metric presets</legend>
      <p>Presets are saved in this browser. Apply a preset explicitly to reuse its metrics.</p>
      <label>
        Saved metric presets
        <select
          aria-label="Saved metric presets"
          value={chosen?.id ?? ""}
          onChange={(e) => setChosen(presets.find((p) => p.id === e.target.value))}
        >
          <option value="">Choose a preset</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!chosen}
        onClick={() => {
          if (chosen) {
            onApply(structuredClone(chosen.selections));
            setMessage(presetWarnings(chosen).join(" "));
          }
        }}
      >
        Apply preset
      </button>{" "}
      <button
        disabled={!chosen}
        onClick={() =>
          act(() => setChosen(store.current.replace(chosen!.id, chosen!.revision, selection)))
        }
      >
        Replace preset
      </button>{" "}
      <button
        disabled={!chosen}
        onClick={() =>
          act(() => {
            store.current.delete(chosen!.id, chosen!.revision);
            setChosen(undefined);
          })
        }
      >
        Delete preset
      </button>
      <label>
        Preset name
        <input
          aria-label="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      </label>
      <button
        onClick={() =>
          act(() => {
            setChosen(store.current.save(name, selection));
            setName("");
          })
        }
      >
        Save new preset
      </button>
      {message && (
        <p className="comparison-warning" role="status">
          {message}
        </p>
      )}
    </fieldset>
  );
}
