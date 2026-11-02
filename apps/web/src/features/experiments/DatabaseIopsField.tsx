import React from "react";
import { FieldHelp } from "../../shared/FieldHelp";
import {
  DATABASE_IOPS_CATALOG,
  DatabaseIopsPresetId
} from "../../../../../packages/contracts/src/database-iops";
export function DatabaseIopsField({
  catalog,
  values,
  onChange,
  disabled = false
}: {
  catalog?: typeof DATABASE_IOPS_CATALOG;
  values: DatabaseIopsPresetId[];
  onChange: (v: DatabaseIopsPresetId[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const trigger = React.useRef(null as HTMLButtonElement | null);
  const selected = catalog?.presets.filter((p) => values.includes(p.id)) ?? [];
  const error = !!catalog && !values.length;
  return (
    <div
      className="database-iops-field"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
          e.stopPropagation();
        }
      }}
    >
      <span className="database-iops-label" id={id + "-label"}>
        Database disk IOPS{" "}
        <FieldHelp label="Database disk IOPS">
          Each backing device gets separate read and write ceilings. Copy and setup finish before
          limits are applied. Caches, request sizes, host capacity and other limits still affect
          performance. This does not simulate disk access latency or set a bandwidth ceiling. Shared
          storage contention can affect other services.
        </FieldHelp>
      </span>
      <button
        ref={trigger}
        type="button"
        className="database-iops-trigger"
        aria-label={`Database disk IOPS: ${selected.map((p) => p.label).join(", ") || "Choose presets"}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id + "-options"}
        aria-describedby={id + "-help" + (error ? " " + id + "-error" : "")}
        aria-invalid={error || undefined}
        disabled={disabled || !catalog}
        onClick={() => setOpen((v) => !v)}
      >
        {catalog ? selected.map((p) => p.label).join(", ") || "Choose presets" : "Loading presets…"}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && catalog && (
        <div
          id={id + "-options"}
          className="database-iops-options"
          role="dialog"
          aria-label="Database disk IOPS options"
        >
          {catalog.presets.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={values.includes(p.id)}
                disabled={disabled}
                onChange={(e) => {
                  const next = new Set(values);
                  if (e.target.checked) next.add(p.id);
                  else next.delete(p.id);
                  onChange(catalog.presets.filter((p) => next.has(p.id)).map((p) => p.id));
                }}
              />
              <span>
                {p.label}
                <small>
                  {p.readIopsPerDevice === null
                    ? "No added cap"
                    : `${p.readIopsPerDevice.toLocaleString()} read / ${p.writeIopsPerDevice.toLocaleString()} write IOPS per device`}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      <small id={id + "-help"}>
        Select one or more presets. Each selection creates a separate run condition. Unlimited adds
        no ParkBench cap.
      </small>
      {error && (
        <small role="alert" id={id + "-error"}>
          Select at least one disk preset.
        </small>
      )}
    </div>
  );
}
export function DatabaseIopsPreview({ condition }: { condition: any }) {
  return condition ? (
    <span className="database-iops-preview">
      {condition.label} —{" "}
      {condition.readIopsPerDevice === null
        ? "no added cap"
        : `${condition.readIopsPerDevice.toLocaleString()} read / ${condition.writeIopsPerDevice.toLocaleString()} write IOPS per device`}{" "}
      <small>({condition.catalogVersion})</small>
    </span>
  ) : null;
}
