import { DatabaseParameterHelp } from "./DatabaseParameterHelp";
import { DATABASE_RUN_CONTROL_HELP } from "../../../../../packages/contracts/src/database-run-control-help";
import { databaseParameterDefinition } from "../../../../../packages/contracts/src/database-parameter-options";
import React from "react";
import { FieldHelp } from "../../shared/FieldHelp";

export const runControlFields = [
  {
    name: "-bibufs",
    label: "BI buffers (-bibufs)",
    description: databaseParameterDefinition("-bibufs")!.description,
    minimum: 3,
    step: 1,
    helpOption: databaseParameterDefinition("-bibufs")!
  },
  {
    name: "database.apwCount",
    label: "APW count",
    description: DATABASE_RUN_CONTROL_HELP["database.apwCount"].description,
    minimum: 0,
    maximum: 9,
    step: 1,
    helpOption: { name: "database.apwCount", ...DATABASE_RUN_CONTROL_HELP["database.apwCount"] }
  },
  {
    name: "database.biClusterSizeMiB",
    label: "BI cluster size (MiB)",
    description: DATABASE_RUN_CONTROL_HELP["database.biClusterSizeMiB"].description,
    minimum: 0.015625,
    maximum: 255.984375,
    step: 0.015625,
    helpOption: {
      name: "database.biClusterSizeMiB",
      ...DATABASE_RUN_CONTROL_HELP["database.biClusterSizeMiB"]
    }
  },
  {
    name: "database.biwEnabled",
    label: "BIW process",
    description: DATABASE_RUN_CONTROL_HELP["database.biwEnabled"].description,
    helpOption: { name: "database.biwEnabled", ...DATABASE_RUN_CONTROL_HELP["database.biwEnabled"] }
  }
] as const;
export type RunControlsInput = Record<string, string>;
export const runControlValues = (values: RunControlsInput, dimensions: string[] = []) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([name, value]) => value.trim() !== "" && !dimensions.includes(name))
      .map(([name, value]) => [
        name,
        name === "database.biwEnabled" ? value === "true" : Number(value)
      ])
  );
export function mergeRunControlValues(
  parameters: Record<string, unknown>,
  values: RunControlsInput,
  dimensions: string[] = []
) {
  const controls = runControlValues(values, dimensions);
  for (const [name, value] of Object.entries(controls)) {
    if (Object.hasOwn(parameters, name) && parameters[name] !== value) {
      throw new Error(
        `Conflicting values for ${name}. Set it in one editor or use the same value.`
      );
    }
  }
  return { ...parameters, ...controls };
}
export const validRunControlsInput = (values: RunControlsInput, dimensions: string[] = []) =>
  runControlFields.every((field) => {
    const value = values[field.name]?.trim() ?? "";
    if (!value || dimensions.includes(field.name)) return true;
    if (field.name === "database.biwEnabled") return value === "true" || value === "false";
    const numeric = Number(value);
    return (
      Number.isFinite(numeric) &&
      numeric >= field.minimum &&
      (!("maximum" in field) || numeric <= field.maximum) &&
      Number.isSafeInteger(numeric / field.step)
    );
  });

export function RunControlsFields({
  values,
  onChange,
  dimensions = [],
  disabled = false
}: {
  values: RunControlsInput;
  onChange: (name: string, value: string) => void;
  dimensions?: string[];
  disabled?: boolean;
}) {
  const summaryId = React.useId();
  return (
    <fieldset>
      <legend>Database run controls</legend>
      {runControlFields.map((field) => {
        const swept = dimensions.includes(field.name);
        return (
          <label key={field.name}>
            <span>
              {field.label}{" "}
              <FieldHelp label={field.label}>
                <DatabaseParameterHelp option={field.helpOption} />
              </FieldHelp>
            </span>
            {field.name === "database.biwEnabled" ? (
              <select
                aria-label={field.label}
                aria-describedby={`${summaryId}-${field.name}`}
                value={swept ? "" : (values[field.name] ?? "")}
                disabled={disabled || swept}
                onChange={(event) => onChange(field.name, event.target.value)}
              >
                <option value="">Inherit scenario / disabled</option>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            ) : (
              <input
                type="number"
                aria-label={field.label}
                aria-describedby={`${summaryId}-${field.name}`}
                min={field.minimum}
                max={"maximum" in field ? field.maximum : undefined}
                step={field.step}
                placeholder="Inherit"
                value={swept ? "" : (values[field.name] ?? "")}
                disabled={disabled || swept}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            )}
            <small id={`${summaryId}-${field.name}`} className="parameter-summary">
              {field.description}
            </small>
            {swept && <small>Set as a matrix dimension below.</small>}
          </label>
        );
      })}
      {!validRunControlsInput(values, dimensions) && (
        <small role="alert">Enter database controls within the documented range and step.</small>
      )}
    </fieldset>
  );
}

export function RunControlsSummary({ controls, evidence }: { controls?: any; evidence?: any }) {
  if (!controls) return null;
  return (
    <div aria-label="Database run controls summary">
      <div>
        APWs: {controls.apwCount} <span className="status">{controls.sources?.apwCount}</span>
      </div>
      <div>
        BIW: {controls.biwEnabled ? "enabled" : "disabled"}{" "}
        <span className="status">{controls.sources?.biwEnabled}</span>
      </div>
      <div>
        BI cluster:{" "}
        {controls.biCluster?.mode === "override"
          ? `${controls.biCluster.requestedMiB} MiB (${controls.biCluster.nativeKiB} KiB)`
          : evidence?.observed
            ? `Inherited ${evidence.observed.nativeClusterKiB / 1024} MiB (native)`
            : "Inherited — pending native observation"}{" "}
        <span className="status">{controls.sources?.biClusterSizeMiB}</span>
      </div>
      <small>
        {evidence
          ? `Native verification: ${evidence.verification}; writer health: ${evidence.writerHealth}; captured ${evidence.capturedAt}.`
          : "Native verification pending before measurement."}
      </small>
      {evidence?.observed && (
        <div>
          Observed: {evidence.observed.apwCount} APWs; {evidence.observed.biwCount} BIW;{" "}
          {evidence.observed.biBuffers} BI buffers; {evidence.observed.nativeClusterKiB / 1024} MiB
          BI cluster.
        </div>
      )}
      {evidence?.reason && <div role="status">{evidence.reason}</div>}
    </div>
  );
}
