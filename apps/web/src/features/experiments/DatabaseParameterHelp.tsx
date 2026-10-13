import React from "react";
import type { ParameterBound } from "../../../../../packages/contracts/src/database-parameter-options";

/** Also accepts retained options and non-broker controls without importing runtime adapters. */
export interface ParameterHelpOption {
  name: string;
  description: string;
  explanation?: string;
  kind?: "integer" | "decimal" | "string" | "enum" | "flag" | "boolean";
  unit?: string;
  minimum?: number | boolean;
  maximum?: number | boolean;
  defaultValue?: string | number | boolean;
  multiUser?: { minimum: ParameterBound; maximum: ParameterBound; default: ParameterBound };
  documentation?: readonly { url: string; version: string }[];
}

const boundConditionText: Record<string, string> = {
  "64-bit sum of -B and -B2; 32-bit sum is 125000000.":
    "Combined limit for -B and -B2 on 64-bit systems; 125,000,000 blocks on 32-bit systems",
  "Sufficient system memory.": "Requires enough system memory",
  "-1 is a PROMON/VST-only disabled state, not a permitted startup value.":
    "0 selects daily truncation; -1 disables truncation in PROMON but cannot be used at startup",
  "12.8 syntax table; narrative also describes 0 as default. No default override is injected.":
    "The documentation lists 100 in its parameter table and 0 in its description",
  "Enterprise syntax-table default; observe the native effective value because prose also mentions 0.":
    "With Enterprise Edition; the documentation lists 100 in its parameter table and 0 in its description",
  "Published minimum is >0.": "Must be greater than zero",
  "64-bit target, in MB; 32-bit minimum is 128 MB.":
    "On 64-bit systems; the minimum on 32-bit systems is 128 MB"
};

const boundValueText: Record<string, string> = {
  "2000 if CDC is enabled. 200 if CDC is not enabled.":
    "2,000 kbytes when change data capture is enabled; 200 kbytes otherwise",
  "5 users/server (table); -n / -Mn (description)":
    "The documentation lists 5 clients per server in its table and the connection limit (-n) divided by the server limit (-Mn) in its description",
  "32 kilobytes + padding based on the number of users":
    "32 KB plus extra space based on the number of users",
  "Configuration and system dependent. 2":
    "Depends on configuration and the operating system; OpenEdge first tries to allocate one segment for all required memory",
  "10000 for one CPU; 6000 × CPU count for multiple CPUs":
    "10,000 retries with one CPU; 6,000 × the CPU count with multiple CPUs",
  "0 — for non-threaded server 1 — for threaded server":
    "0 with a non-threaded server; 1 with a threaded server"
};

export const parameterBoundText = (bound: ParameterBound, unit?: string) => {
  if (bound.status === "not_specified") return "Not specified in documentation";
  if (bound.status === "not_applicable") return "Not applicable";
  const value =
    typeof bound.value === "number"
      ? bound.value.toLocaleString("en-US", { maximumFractionDigits: 12 })
      : typeof bound.value === "boolean"
        ? bound.value
          ? "Enabled"
          : "Disabled"
        : (boundValueText[bound.value] ?? bound.value);
  const units = unit && typeof bound.value === "number" ? ` ${unit}` : "";
  return `${value}${units}${bound.condition ? ` (${boundConditionText[bound.condition] ?? bound.condition})` : ""}`;
};

export function DatabaseParameterHelp({ option }: { option?: ParameterHelpOption }) {
  if (!option) return <span>Choose a parameter to see what it does.</span>;
  const absentLimit: ParameterBound =
    ["string", "enum", "flag", "boolean"].includes(option.kind) ||
    typeof option.minimum === "boolean"
      ? { status: "not_applicable" }
      : { status: "not_specified" };
  const bounds = option.multiUser ?? {
    minimum:
      typeof option.minimum === "number"
        ? ({ status: "documented", value: option.minimum } as const)
        : absentLimit,
    maximum:
      typeof option.maximum === "number"
        ? ({ status: "documented", value: option.maximum } as const)
        : absentLimit,
    default:
      option.defaultValue !== undefined
        ? ({ status: "documented", value: option.defaultValue } as const)
        : ({ status: "not_specified" } as const)
  };
  const displayDefault =
    option.name === "-B" &&
    bounds.default.status === "documented" &&
    bounds.default.value === "max(8 × -n, 3000)"
      ? "Larger of 8 × the connection limit (-n) and 3,000 blocks"
      : parameterBoundText(bounds.default, option.unit);
  return (
    <div className="parameter-help" aria-label={`About ${option.name}`}>
      <strong>{option.name}</strong>
      <p>{option.explanation ?? option.description}</p>
      <dl>
        <dt>Multi-user minimum</dt>
        <dd>{parameterBoundText(bounds.minimum, option.unit)}</dd>
        <dt>Multi-user maximum</dt>
        <dd>{parameterBoundText(bounds.maximum, option.unit)}</dd>
        <dt>Multi-user default</dt>
        <dd>{displayDefault}</dd>
      </dl>
      {option.documentation?.[0] && (
        <a href={option.documentation[0].url} target="_blank" rel="noreferrer">
          OpenEdge reference
        </a>
      )}
    </div>
  );
}
