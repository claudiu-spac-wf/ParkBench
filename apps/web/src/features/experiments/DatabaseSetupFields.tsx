import { getSetupScripts } from "./experimentApi";
import React from "react";
import {
  DatabaseSetup,
  DatabaseSetupStep,
  DATABASE_SETUP_DEFINITIONS,
  SetupDefinitionId
} from "../../../../../packages/contracts/src/database-setup";
import { FieldHelp } from "../../shared/FieldHelp";
import "./databaseSetup.css";

/** Native built-in tokens only: quotes group words, with no expansion or host execution. */
export function parseNativeTokens(text: string): string[] {
  const tokens: string[] = [];
  let word = "",
    quote = "",
    escaped = false,
    started = false;
  for (const ch of text) {
    if (escaped) {
      word += ch;
      escaped = false;
      started = true;
    } else if (ch === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(word);
        word = "";
        started = false;
      }
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote || escaped) throw new Error("Close the quote or complete the escaped token.");
  if (started) tokens.push(word);
  return tokens;
}
const freshId = () => crypto.randomUUID();
function freshSet(definition: SetupDefinitionId): any {
  return definition === "idxbuild"
    ? { id: freshId(), scope: "all" }
    : definition === "idxcompact"
      ? { id: freshId(), index: "" }
      : definition === "custom"
        ? { id: freshId(), input: "" }
        : { id: freshId(), table: "" };
}
function SetupFieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="setup-field-label">
      <span>{label}</span>
      <FieldHelp label={label}>{children}</FieldHelp>
    </span>
  );
}
function Tokens({
  value,
  onChange,
  disabled,
  onValidity
}: {
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  onValidity: (valid: boolean) => void;
}) {
  const [draft, setDraft] = React.useState(
    value.map((v) => "'" + v.replace(/'/g, "'\\''") + "'").join(" ")
  );
  const [error, setError] = React.useState("");
  React.useEffect(() => () => onValidity(true), []);
  return (
    <label>
      <SetupFieldLabel label="Additional native arguments">
        Space-separated literal tokens. Quotes group tokens; no shell expansion is performed.
        Unknown native options retain their utility errors.
      </SetupFieldLabel>
      <input
        aria-label="Additional native arguments"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            onChange(parseNativeTokens(e.target.value));
            setError("");
            onValidity(true);
          } catch (reason) {
            setError(String(reason));
            onValidity(false);
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </label>
  );
}
export function DatabaseSetupSummary({ setup }: { setup?: DatabaseSetup }) {
  if (!setup?.steps.length) return null;
  return (
    <div className="database-setup-summary">
      <strong>Database setup · {setup.steps.length} steps</strong>
      <ol>
        {setup.steps.map((step) => (
          <li key={step.id}>
            <strong>{step.definitionId}</strong>
            {step.definitionId === "custom" && <code>{step.scriptRef}</code>}
            <ol>
              {step.optionSets.map((set) => (
                <li key={set.id}>
                  <code>{JSON.stringify(set)}</code>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
export function DatabaseSetupFields({
  value,
  onChange,
  disabled,
  onValidity
}: {
  value?: DatabaseSetup;
  onChange: (v: DatabaseSetup | undefined) => void;
  disabled?: boolean;
  onValidity?: (valid: boolean) => void;
}) {
  const root = React.useRef(null as HTMLElement | null);
  const focusTarget = React.useRef(undefined as string | undefined);
  React.useLayoutEffect(() => {
    const selector = focusTarget.current;
    if (!selector) return;
    focusTarget.current = undefined;
    const target = root.current?.querySelector(selector) as HTMLElement | null;
    target?.focus();
  }, [value]);
  const [scripts, setScripts] = React.useState(
    undefined as Awaited<ReturnType<typeof getSetupScripts>> | undefined
  );
  const [scriptsError, setScriptsError] = React.useState("");
  const [scriptsLoading, setScriptsLoading] = React.useState(false);
  const loadScripts = () => {
    setScriptsLoading(true);
    setScriptsError("");
    void getSetupScripts()
      .then((result) => {
        setScripts(result);
        if (
          (value?.steps ?? []).some(
            (step) =>
              step.definitionId === "custom" &&
              !result.items.some(
                (item) => item.scriptRef === step.scriptRef && item.availability === "AVAILABLE"
              )
          )
        )
          onChange(value ? structuredClone(value) : undefined);
      })
      .catch((error) => setScriptsError(error.message))
      .finally(() => setScriptsLoading(false));
  };
  React.useEffect(() => {
    loadScripts();
  }, []);
  const [definition, setDefinition] = React.useState("idxbuild" as SetupDefinitionId);
  const invalid = React.useRef(new Set<string>());
  const validity = (id: string, valid: boolean) => {
    if (valid) invalid.current.delete(id);
    else invalid.current.add(id);
    onValidity?.(invalid.current.size === 0);
  };
  const steps = value?.steps ?? [];
  const update = (next: DatabaseSetupStep[]) =>
    onChange(next.length ? { contractVersion: "database-setup.v1", steps: next } : undefined);
  const edit = (id: string, fn: (step: any) => any) =>
    update(steps.map((step) => (step.id === id ? fn(structuredClone(step)) : step)));
  const move = (items: any[], index: number, delta: number) => {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    return next;
  };
  const field = (label: string, help: string, value: string, change: (v: string) => void) => (
    <label>
      <SetupFieldLabel label={label}>{help}</SetupFieldLabel>
      <input
        aria-label={label}
        value={value}
        onChange={(e) => change(e.target.value)}
        disabled={disabled}
      />
    </label>
  );
  return (
    <section className="database-setup-fields" aria-label="Database setup" ref={root}>
      <h2>
        Database setup{" "}
        <FieldHelp label="Database setup">
          Optional ordered operations on each run's copied database. Every setting runs before
          benchmark startup, without adding matrix runs. Table reorganization uses one temporary
          broker for all its settings, then shuts it down.
        </FieldHelp>
      </h2>
      <div className="setup-add">
        <label>
          <span className="setup-field-label">Setup operation</span>
          <select
            aria-label="Setup operation"
            value={definition}
            disabled={disabled}
            onChange={(e) => setDefinition(e.target.value as SetupDefinitionId)}
          >
            <option value="custom">Custom shell script</option>
            {DATABASE_SETUP_DEFINITIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            update([
              ...steps,
              {
                id: freshId(),
                definitionId: definition,
                ...(definition === "custom" ? { scriptRef: "" } : {}),
                optionSets: [freshSet(definition)]
              } as DatabaseSetupStep
            ])
          }
        >
          Add setup step
        </button>
      </div>
      {steps.map((step, si) => {
        const descriptor = DATABASE_SETUP_DEFINITIONS.find((d) => d.id === step.definitionId);
        const help = descriptor?.fields as Record<string, string> | undefined;
        return (
          <section key={step.id} className="database-setup-step" data-setup-step={step.id}>
            <div className="setup-row-heading">
              <h3>
                {si + 1}. {descriptor?.name ?? step.definitionId}
              </h3>
              <div>
                <button
                  type="button"
                  disabled={disabled || si === 0}
                  onClick={() => {
                    focusTarget.current = `[data-setup-step="${step.id}"] input`;
                    update(move(steps, si, -1));
                  }}
                >
                  Move step up
                </button>
                <button
                  type="button"
                  disabled={disabled || si === steps.length - 1}
                  onClick={() => {
                    focusTarget.current = `[data-setup-step="${step.id}"] input`;
                    update(move(steps, si, 1));
                  }}
                >
                  Move step down
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    focusTarget.current = ".setup-add button";
                    update(steps.filter((s) => s.id !== step.id));
                  }}
                >
                  Remove step
                </button>
              </div>
            </div>
            <p>{descriptor?.description}</p>
            {step.definitionId === "custom" && (
              <div className="setup-custom-source">
                <label>
                  <SetupFieldLabel label="Script file">
                    A readable .sh file from the configured scripts folder. The selected source is
                    copied for each run; its source permissions stay unchanged.
                  </SetupFieldLabel>
                  <select
                    aria-label="Script file"
                    value={step.scriptRef}
                    onChange={(e) => edit(step.id, (s) => ({ ...s, scriptRef: e.target.value }))}
                    disabled={disabled || scriptsLoading}
                  >
                    <option value="">Choose script</option>
                    {step.scriptRef &&
                      !scripts?.items.some((item) => item.scriptRef === step.scriptRef) && (
                        <option value={step.scriptRef}>{step.scriptRef} · unavailable</option>
                      )}
                    {(scripts?.items ?? []).map((item) => (
                      <option
                        key={item.scriptRef}
                        value={item.scriptRef}
                        disabled={item.availability !== "AVAILABLE"}
                      >
                        {item.displayName}
                        {item.availability !== "AVAILABLE" ? " · unavailable" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" disabled={scriptsLoading || disabled} onClick={loadScripts}>
                  {scriptsLoading ? "Loading scripts…" : "Refresh scripts"}
                </button>
                {scriptsError && <p role="alert">Scripts unavailable: {scriptsError}</p>}
                {scripts?.state === "EMPTY" && (
                  <p>
                    No scripts available. Add readable .sh files to the configured scripts folder,
                    then refresh.
                  </p>
                )}
                {scripts?.state === "FAILED" && (
                  <p role="alert">Scripts unavailable: {scripts.reason}</p>
                )}
                {scripts?.state === "DEGRADED" && (
                  <p role="status">
                    Some script sources are unavailable. Available files can still be selected.
                  </p>
                )}
              </div>
            )}

            {step.optionSets.map((set: any, oi) => (
              <fieldset
                className="database-setup-set"
                data-setup-set={set.id}
                tabIndex={-1}
                key={set.id}
                disabled={disabled}
              >
                <legend>Settings {oi + 1}</legend>
                <div className="setup-inputs">
                  {step.definitionId === "idxbuild" && (
                    <>
                      <label>
                        <SetupFieldLabel label="Scope">{help?.scope}</SetupFieldLabel>
                        <select
                          aria-label="Scope"
                          value={set.scope}
                          onChange={(e) =>
                            edit(step.id, (s) => ({
                              ...s,
                              optionSets: s.optionSets.map((item: any) =>
                                item.id === set.id
                                  ? {
                                      ...freshSet("idxbuild"),
                                      id: set.id,
                                      scope: e.target.value,
                                      ...(e.target.value === "table"
                                        ? { table: "" }
                                        : e.target.value === "indexes"
                                          ? { indexes: [{ table: "", index: "" }] }
                                          : {})
                                    }
                                  : item
                              )
                            }))
                          }
                        >
                          <option value="all">All indexes</option>
                          <option value="table">Table</option>
                          <option value="indexes">Selected indexes</option>
                        </select>
                      </label>
                    </>
                  )}
                  {(step.definitionId === "tablereorg" || set.scope === "table") &&
                    field("Table", help?.table ?? "Native table name.", set.table ?? "", (v) =>
                      edit(step.id, (s) => ({
                        ...s,
                        optionSets: s.optionSets.map((item: any) =>
                          item.id === set.id ? { ...item, table: v } : item
                        )
                      }))
                    )}
                  {step.definitionId === "tablereorg" &&
                    field("Ordering index", help?.useIndex ?? "", set.useIndex ?? "", (v) =>
                      edit(step.id, (s) => ({
                        ...s,
                        optionSets: s.optionSets.map((item: any) => {
                          if (item.id !== set.id) return item;
                          const next = { ...item };
                          if (v) next.useIndex = v;
                          else delete next.useIndex;
                          return next;
                        })
                      }))
                    )}
                  {step.definitionId === "idxcompact" && (
                    <>
                      {field("Index", help?.index ?? "", set.index, (v) =>
                        edit(step.id, (s) => ({
                          ...s,
                          optionSets: s.optionSets.map((item: any) =>
                            item.id === set.id ? { ...item, index: v } : item
                          )
                        }))
                      )}
                      <label>
                        <SetupFieldLabel label="Compaction percent">
                          {help?.compactionPercent}
                        </SetupFieldLabel>
                        <input
                          type="number"
                          aria-label="Compaction percent"
                          min={50}
                          max={100}
                          placeholder="80 (native default)"
                          disabled={set.mode === "unusedblocks"}
                          value={set.compactionPercent ?? ""}
                          onChange={(e) =>
                            edit(step.id, (s) => ({
                              ...s,
                              optionSets: s.optionSets.map((item: any) => {
                                if (item.id !== set.id) return item;
                                const next = { ...item };
                                if (e.target.value !== "")
                                  next.compactionPercent = Number(e.target.value);
                                else delete next.compactionPercent;
                                return next;
                              })
                            }))
                          }
                        />
                      </label>
                      <label className="setup-check">
                        <span className="setup-check-control">
                          <input
                            type="checkbox"
                            aria-label="Unused blocks"
                            checked={set.mode === "unusedblocks"}
                            onChange={(e) =>
                              edit(step.id, (s) => ({
                                ...s,
                                optionSets: s.optionSets.map((item: any) => {
                                  if (item.id !== set.id) return item;
                                  const next = { ...item };
                                  if (e.target.checked) {
                                    next.mode = "unusedblocks";
                                    delete next.compactionPercent;
                                  } else delete next.mode;
                                  return next;
                                })
                              }))
                            }
                          />
                          <SetupFieldLabel label="Unused blocks">{help?.mode}</SetupFieldLabel>
                        </span>
                      </label>
                    </>
                  )}
                  {step.definitionId === "custom" ? (
                    <label>
                      <SetupFieldLabel label="Script input">
                        Exact shell arguments or commands after the selected script name, run from
                        the database directory inside its container. Leave empty to invoke without
                        arguments. Quotes, whitespace and newlines are preserved.
                      </SetupFieldLabel>
                      <textarea
                        aria-label="Script input"
                        rows={3}
                        value={set.input}
                        onChange={(e) =>
                          edit(step.id, (s) => {
                            s.optionSets[oi].input = e.target.value;
                            return s;
                          })
                        }
                      />
                    </label>
                  ) : (
                    <Tokens
                      value={set.additionalArguments ?? []}
                      disabled={disabled}
                      onValidity={(valid) => validity(set.id, valid)}
                      onChange={(tokens) =>
                        edit(step.id, (s) => {
                          const item = s.optionSets.find((o: any) => o.id === set.id);
                          if (tokens.length) item.additionalArguments = tokens;
                          else delete item.additionalArguments;
                          return s;
                        })
                      }
                    />
                  )}{" "}
                  {set.scope === "indexes" && (
                    <div className="setup-index-targets">
                      <p>{help?.indexes}</p>
                      {set.indexes.map((target: any, ti: number) => (
                        <div className="setup-inputs setup-index-row" key={ti}>
                          {field(
                            `Index table ${ti + 1}`,
                            "Native table name for the Some dialogue.",
                            target.table,
                            (v) =>
                              edit(step.id, (s) => {
                                s.optionSets[oi].indexes[ti].table = v;
                                return s;
                              })
                          )}
                          {field(`Index name ${ti + 1}`, "Native index name.", target.index, (v) =>
                            edit(step.id, (s) => {
                              s.optionSets[oi].indexes[ti].index = v;
                              return s;
                            })
                          )}
                          <button
                            type="button"
                            disabled={set.indexes.length === 1}
                            onClick={() =>
                              edit(step.id, (s) => {
                                s.optionSets[oi].indexes.splice(ti, 1);
                                return s;
                              })
                            }
                          >
                            Remove index target
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          edit(step.id, (s) => {
                            s.optionSets[oi].indexes.push({ table: "", index: "" });
                            return s;
                          })
                        }
                      >
                        Add index target
                      </button>
                    </div>
                  )}
                </div>
                <div className="setup-actions">
                  <button
                    type="button"
                    disabled={oi === 0}
                    onClick={() =>
                      edit(step.id, (s) => ({ ...s, optionSets: move(s.optionSets, oi, -1) }))
                    }
                  >
                    Move settings up
                  </button>
                  <button
                    type="button"
                    disabled={oi === step.optionSets.length - 1}
                    onClick={() =>
                      edit(step.id, (s) => ({ ...s, optionSets: move(s.optionSets, oi, 1) }))
                    }
                  >
                    Move settings down
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      validity(set.id, true);
                      if (step.optionSets.length === 1)
                        update(steps.filter((s) => s.id !== step.id));
                      else
                        edit(step.id, (s) => ({
                          ...s,
                          optionSets: s.optionSets.filter((item: any) => item.id !== set.id)
                        }));
                    }}
                  >
                    Remove settings
                  </button>
                </div>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                edit(step.id, (s) => ({
                  ...s,
                  optionSets: [...s.optionSets, freshSet(step.definitionId)]
                }))
              }
            >
              Add settings
            </button>
          </section>
        );
      })}
    </section>
  );
}
