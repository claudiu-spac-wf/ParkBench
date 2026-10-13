import { FieldHelp } from "../../shared/FieldHelp";
import { DatabaseParameterHelp } from "./DatabaseParameterHelp";
import React, { useState } from "react";
import type { DatabaseParameterOption } from "../../../../../packages/contracts/src/database-parameter-options";
import {
  databaseParameterInput,
  validateDatabaseParameterValue
} from "../../../../../packages/contracts/src/database-parameter-options";
export function DatabaseParameterCatalog({
  options,
  values,
  onChange,
  disabled = false,
  dimensions = []
}: {
  options: DatabaseParameterOption[];
  values: Record<string, string | number | boolean>;
  onChange: (values: Record<string, string | number | boolean>) => void;
  disabled?: boolean;
  dimensions?: string[];
}) {
  const [search, setSearch] = useState(""),
    [name, setName] = useState(""),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  const summaryId = React.useId();
  const option = options.find((p) => p.name === name);
  const add = () => {
    if (!option?.available) return;
    try {
      const value = databaseParameterInput(option.name, text);
      validateDatabaseParameterValue(option.name, value);
      if (dimensions.includes(option.name))
        throw new Error("This parameter already has a matrix dimension.");
      onChange({ ...values, [option.name]: value });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <details className="database-parameter-catalog">
      <summary>Database startup parameters ({options.length})</summary>
      <label>
        Find startup parameter
        <input
          aria-label="Find startup parameter"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <label>
        <span>
          Startup parameter{" "}
          <FieldHelp label="Startup parameter">
            <DatabaseParameterHelp option={option} />
          </FieldHelp>
        </span>
        <select
          aria-label="Startup parameter"
          aria-describedby={summaryId}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setText("");
            setError("");
          }}
        >
          <option value="">Choose parameter</option>
          {options
            .filter(
              (p) =>
                `${p.name} ${p.description}`.toLowerCase().includes(search.toLowerCase()) ||
                p.name === name
            )
            .map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.available ? "" : " — unavailable"}
              </option>
            ))}
        </select>
        <small id={summaryId} className="parameter-summary">
          {option?.description ?? "Choose a database startup parameter."}
        </small>
      </label>
      {option && !option.available && <p role="status">Unavailable: {option.reason}</p>}
      {option && (
        <>
          <label>
            Fixed parameter value
            {option.kind === "flag" ? (
              <select
                aria-label="Fixed parameter value"
                value={text}
                disabled={disabled || !option.available}
                onChange={(e) => setText(e.target.value)}
              >
                <option value="">Choose value</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            ) : option.valueKind === "enum" ? (
              <select
                aria-label="Fixed parameter value"
                value={text}
                disabled={disabled || !option.available}
                onChange={(e) => setText(e.target.value)}
              >
                <option value="">Choose value</option>
                {option.allowedValues?.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Fixed parameter value"
                type={option.kind === "integer" || option.kind === "decimal" ? "number" : "text"}
                min={option.minimum}
                max={option.maximum}
                step={option.increment ?? (option.kind === "integer" ? 1 : "any")}
                value={text}
                disabled={disabled || !option.available}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </label>
          <button
            type="button"
            disabled={disabled || !option.available || text === ""}
            onClick={add}
          >
            {Object.hasOwn(values, name) ? "Replace fixed parameter" : "Add fixed parameter"}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {Object.keys(values).length > 0 && (
        <table aria-label="Fixed startup parameters">
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(values).map(([key, value]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>{String(value)}</td>
                <td>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove fixed ${key}`}
                    onClick={() => {
                      const next = { ...values };
                      delete next[key];
                      onChange(next);
                    }}
                  >
                    Remove fixed
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
/** JSON arrays preserve literal text; ordinary text values are one per line. */
export function parseStartupDimension(
  text: string,
  option?: DatabaseParameterOption
): Array<string | number | boolean> {
  if (text.trimStart().startsWith("[")) {
    const values = JSON.parse(text);
    if (!Array.isArray(values)) throw new Error("Use a JSON array for dimension values.");
    return values;
  }
  if (option?.valueKind === "string") return text.split("\n").filter((value) => value !== "");
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) =>
      option?.valueKind === "enum"
        ? v
        : v === "true"
          ? true
          : v === "false"
            ? false
            : /^-?\d+(\.\d+)?$/.test(v)
              ? Number(v)
              : v
    );
}
