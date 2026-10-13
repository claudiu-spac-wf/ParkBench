import React, { useEffect, useRef, useState } from "react";
import {
  getAllCatalog,
  getControlScenario,
  getControlScenarios,
  refreshCatalogDiscovery,
  saveControlScenario
} from "../../shared/control-ui-client";
import { FieldHelp } from "../../shared/FieldHelp";
import { WorkflowState } from "../../shared/workflow-state";
import {
  choiceStatus,
  configuredImageReference,
  defaultChoice,
  eligibleImageOptions,
  eligibleScenarioCompatibility,
  eligibleWorkloadOptions,
  hasConfiguredDefault,
  isStaleAssetError
} from "../../shared/asset-options";
import { ALLOWED_PARAMETERS } from "../../../../../packages/contracts/src/allowed-parameters";

function nextVersion(version: string): string {
  const parts = version.split(".").map(Number);
  return `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

function parseParameterValue(definition: any, raw: string): string | number | boolean | undefined {
  if (raw === "") return undefined;
  if (definition.type === "boolean") return raw === "true";
  if (definition.type === "integer") return Number.parseInt(raw, 10);
  if (definition.type === "number") return Number(raw);
  return raw;
}

function parseAllowedValues(
  definition: any,
  raw: string
): Array<string | number | boolean> | undefined {
  if (!raw.trim()) return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseParameterValue(definition, value) ?? value);
}

export function ScenarioEditorPage() {
  const [scenarios, setScenarios] = useState([] as any[]);
  const [selected, setSelected] = useState(undefined as any);
  const [draft, setDraft] = useState(undefined as any);
  const [definitions, setDefinitions] = useState([] as any[]);
  const [newParameterName, setNewParameterName] = useState("");
  const [assets, setAssets] = useState([] as any[]);
  const [staleAssetFields, setStaleAssetFields] = useState([] as string[]);
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState([] as any[]);
  const [saved, setSaved] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingScenario, setLoadingScenario] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorSource, setErrorSource] = useState("sources" as "sources" | "scenario" | "save");
  const scenarioRequestId = useRef(0);

  const loadScenario = (summary: any) => {
    const requestId = ++scenarioRequestId.current;
    setError("");
    setErrorSource("scenario");
    setLoadingScenario(true);
    setFieldErrors([]);
    void getControlScenario(summary.id, summary.version)
      .then((value) => {
        if (requestId !== scenarioRequestId.current) return;
        setSelected(value);
        setDraft(structuredClone(value.document));
        setDefinitions(
          structuredClone(value.parameterDefinitions ?? []).map((definition: any) => ({
            ...definition,
            allowedValuesText:
              definition.allowedValues === undefined
                ? ""
                : definition.allowedValues.map(String).join(", "),
            dependencies: structuredClone(definition.dependencies ?? [])
          }))
        );
        setVersion(nextVersion(value.version));
      })
      .catch((reason) => {
        if (requestId !== scenarioRequestId.current) return;
        setError(reason.message);
        setFieldErrors(reason.fields ?? []);
      })
      .finally(() => {
        if (requestId === scenarioRequestId.current) setLoadingScenario(false);
      });
  };

  const loadSources = async (refreshSources = false) => {
    setError("");
    setErrorSource("sources");
    setLoadingSources(true);
    try {
      if (refreshSources) await refreshCatalogDiscovery();
      const [scenarioResult, assetResult] = await Promise.allSettled([
        getControlScenarios(),
        getAllCatalog()
      ]);
      if (scenarioResult.status === "fulfilled") {
        const items = scenarioResult.value.scenarios ?? [];
        setScenarios(items);
        if (!draft) {
          const initial = defaultChoice(items)?.choice;
          if (initial) loadScenario(initial);
        }
      } else setError(scenarioResult.reason.message);
      if (assetResult.status === "fulfilled") {
        const nextAssets = assetResult.value.items ?? [];
        if (refreshSources && draft) {
          const refs = draft.assetRefs ?? {};
          const invalidated = [
            ["workload", refs.workload, eligibleWorkloadOptions(nextAssets)],
            [
              "databaseImage",
              refs.databaseImage,
              eligibleImageOptions(
                nextAssets,
                "database_image",
                eligibleScenarioCompatibility(draft)
              )
            ],
            [
              "pasImage",
              refs.pasImage,
              eligibleImageOptions(nextAssets, "pas_image", eligibleScenarioCompatibility(draft))
            ]
          ].flatMap(([field, reference, choices]: any[]) =>
            reference && !choices.some((asset: any) => asset.id === reference) ? [field] : []
          );
          setStaleAssetFields(invalidated);
        }
        setAssets(nextAssets);
      } else setError((current) => current || assetResult.reason.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingSources(false);
    }
  };

  useEffect(() => {
    loadSources();
  }, []);

  const compatibility = eligibleScenarioCompatibility(draft);
  const workloadChoices = eligibleWorkloadOptions(assets);
  const databaseChoices = eligibleImageOptions(assets, "database_image", compatibility);
  const pasChoices = eligibleImageOptions(assets, "pas_image", compatibility);
  const compatibilityKey = JSON.stringify(compatibility);
  useEffect(() => {
    if (!draft) return;
    setDraft((current: any) => {
      if (!current) return current;
      const refs = current.assetRefs ?? {};
      const choose = (field: string, choices: any[], selectedId: string | undefined) => {
        if (staleAssetFields.includes(field)) return "";
        if (choices.some((asset) => asset.id === selectedId)) return selectedId;
        return defaultChoice(choices)?.choice.id ?? "";
      };
      return {
        ...current,
        assetRefs: {
          ...refs,
          workload: choose("workload", workloadChoices, refs.workload),
          databaseImage: choose("databaseImage", databaseChoices, refs.databaseImage),
          pasImage: choose("pasImage", pasChoices, refs.pasImage)
        }
      };
    });
  }, [assets, selected?.id, selected?.version, compatibilityKey, staleAssetFields]);

  const updateDefinition = (index: number, patch: Record<string, unknown>) =>
    setDefinitions((current) =>
      current.map((definition, itemIndex) =>
        itemIndex === index ? { ...definition, ...patch } : definition
      )
    );

  const addParameter = () => {
    const contract = ALLOWED_PARAMETERS[newParameterName];
    if (!contract || definitions.some((item) => item.canonicalName === newParameterName)) return;
    const type =
      contract.type === "number" && Number.isInteger(contract.min) && Number.isInteger(contract.max)
        ? "integer"
        : contract.type;
    setDefinitions((current) => [
      ...current,
      {
        id: `param_${newParameterName.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        canonicalName: newParameterName,
        type,
        minimum: contract.min,
        maximum: contract.max,
        step: type === "integer" ? 1 : undefined,
        description: `Validated ParkBench parameter ${newParameterName}`,
        source: "foundation-runtime-contract",
        matrixAllowed: true,
        secret: false,
        definitionVersion: "1",
        allowedValuesText: "",
        dependencies: []
      }
    ]);
    setNewParameterName("");
  };

  const updateDependency = (
    definitionIndex: number,
    ruleIndex: number,
    patch: Record<string, unknown>
  ) => {
    const dependencies = definitions[definitionIndex]?.dependencies ?? [];
    updateDefinition(definitionIndex, {
      dependencies: dependencies.map((rule: any, index: number) =>
        index === ruleIndex ? { ...rule, ...patch } : rule
      )
    });
  };

  const save = () => {
    if (!draft || !selected || saving) return;
    setError("");
    setErrorSource("save");
    setSaving(true);
    setFieldErrors([]);
    setSaved("");
    let parameterDefinitions: any[];
    try {
      parameterDefinitions = definitions.map((definition) => {
        const { allowedValuesText, ...rest } = definition;
        return {
          ...rest,
          allowedValues: parseAllowedValues(definition, allowedValuesText ?? ""),
          dependencies: definition.dependencies?.length ? definition.dependencies : undefined,
          secret: false
        };
      });
    } catch {
      setError("Parameter values must match the selected type and declared choices.");
      return;
    }
    const requiredMeasurements: any[] | undefined = draft.requiredMeasurements?.length
      ? draft.requiredMeasurements
      : undefined;
    void saveControlScenario(selected.id, {
      scenario: { ...draft, id: selected.id, version, requiredMeasurements },
      parameterDefinitions
    })
      .then((value) => {
        setSelected(value);
        setDraft(structuredClone(value.document));
        setDefinitions(
          structuredClone(value.parameterDefinitions ?? []).map((definition: any) => ({
            ...definition,
            allowedValuesText:
              definition.allowedValues === undefined
                ? ""
                : definition.allowedValues.map(String).join(", "),
            dependencies: structuredClone(definition.dependencies ?? [])
          }))
        );
        setVersion(nextVersion(value.version));
        setScenarios((current) => [...current, value]);
        setSaved(`Saved ${value.id}@${value.version}`);
      })
      .catch((reason) => {
        setError(reason.message);
        setFieldErrors(reason.fields ?? []);
        if (isStaleAssetError(reason)) void loadSources(true);
      })
      .finally(() => setSaving(false));
  };

  const assetOptions = (kind: string) =>
    kind === "workload"
      ? workloadChoices
      : kind === "database_image"
        ? databaseChoices
        : kind === "pas_image"
          ? pasChoices
          : assets.filter((asset) => asset.kind === kind);
  const assetRefs = draft?.assetRefs ?? {};
  const updateAssetRefs = (patch: Record<string, unknown>) => {
    setDraft((current: any) => ({
      ...current,
      assetRefs: { ...(current.assetRefs ?? {}), ...patch }
    }));
    setStaleAssetFields((current) => current.filter((field) => !(field in patch)));
  };
  const staleFieldLabel: Record<string, string> = {
    workload: "Workload",
    databaseImage: "Database image",
    pasImage: "PAS image"
  };
  const updateMeasurement = (index: number, patch: Record<string, unknown>) =>
    setDraft((current: any) => ({
      ...current,
      requiredMeasurements: (current.requiredMeasurements ?? []).map(
        (item: any, itemIndex: number) => (itemIndex === index ? { ...item, ...patch } : item)
      )
    }));
  const requiredMeasurements = draft?.requiredMeasurements ?? [];

  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CONFIGURE / SCENARIOS</p>
          <h1>Scenario configurations</h1>
          <p>Versioned benchmark definitions and typed database parameters.</p>
        </div>
        <div className="button-row">
          <button
            type="button"
            disabled={loadingSources || loadingScenario || saving}
            onClick={() => void loadSources(true)}
          >
            {loadingSources ? "Refreshing…" : "Refresh choices"}
          </button>
          <button
            className="button"
            onClick={save}
            disabled={
              !draft || !version || saving || loadingScenario || staleAssetFields.length > 0
            }
          >
            {saving ? "Saving…" : "Save new version"}
          </button>
        </div>
      </header>
      {staleAssetFields.length > 0 && (
        <WorkflowState
          state="invalid"
          message={`${staleAssetFields.map((field) => staleFieldLabel[field]).join(", ")} selection is no longer ready. Choose a current option before saving this scenario.`}
        />
      )}
      {error && (
        <WorkflowState
          state="error"
          message={error}
          action={
            errorSource === "sources"
              ? "Retry loading"
              : errorSource === "scenario"
                ? "Reload scenario"
                : "Retry save"
          }
          onAction={
            errorSource === "sources"
              ? loadSources
              : errorSource === "scenario"
                ? () => selected && loadScenario(selected)
                : save
          }
        />
      )}
      {loadingSources && <WorkflowState state="loading" message="Loading scenarios and assets…" />}
      {loadingScenario && <WorkflowState state="loading" message="Loading scenario version…" />}
      {!loadingSources && !scenarios.length && !error && (
        <WorkflowState
          state="empty"
          message="No scenarios are available yet. Add or import a scenario before editing."
          action="Reload"
          onAction={loadSources}
        />
      )}
      {fieldErrors.length > 0 && (
        <ul className="notice error" role="alert">
          {fieldErrors.map((field) => (
            <li key={`${field.path}-${field.code}`}>
              {field.path}: {field.message ?? field.code}
            </li>
          ))}
        </ul>
      )}
      {saved && (
        <p className="notice success" role="status">
          {saved}
        </p>
      )}
      <section className="card-grid">
        <section className="panel">
          <h2>Scenario versions</h2>
          <div className="stack-list">
            {scenarios.map((scenario) => (
              <button
                className={
                  selected?.id === scenario.id && selected?.version === scenario.version
                    ? "list-item active"
                    : "list-item"
                }
                key={`${scenario.id}@${scenario.version}`}
                onClick={() => loadScenario(scenario)}
                disabled={saving}
              >
                <strong>{scenario.name ?? scenario.id}</strong>
                <span>
                  {scenario.id}@{scenario.version}
                </span>
                <span>{scenario.state ?? "READY"}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel">
          <h2>{draft?.name ?? "Scenario detail"}</h2>
          {draft ? (
            <>
              <label>
                <span>
                  New version{" "}
                  <FieldHelp label="New version">
                    Saving creates a new immutable scenario version; existing runs keep their
                    original snapshot.
                  </FieldHelp>
                </span>
                <input
                  aria-label="New version"
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                />
              </label>
              <label>
                <span>
                  Description{" "}
                  <FieldHelp label="Description">
                    A human-readable explanation of the scenario and its intended benchmark use.
                  </FieldHelp>
                </span>
                <textarea
                  value={draft.description ?? ""}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <h3>Target topology</h3>
              <div className="scenario-target-grid">
                {(["restPath", "databaseService", "pasService"] as const).map((field) => (
                  <label key={field}>
                    <span>
                      {field}{" "}
                      <FieldHelp label={field}>
                        The scenario target setting used to construct the run topology.
                      </FieldHelp>
                    </span>
                    <input
                      value={draft.target?.[field] ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          target: { ...draft.target, [field]: event.target.value }
                        })
                      }
                    />
                  </label>
                ))}
                <label>
                  <span>
                    pasReplicas{" "}
                    <FieldHelp label="pasReplicas">
                      The number of PAS replicas to start for each run.
                    </FieldHelp>
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={draft.target?.pasReplicas ?? 1}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        target: { ...draft.target, pasReplicas: Number(event.target.value) }
                      })
                    }
                  />
                </label>
              </div>
              <h3>Approved asset references</h3>
              <label>
                <span>
                  Workload{" "}
                  <FieldHelp label="Workload">
                    Select a discovered, verified workload asset for this scenario.
                  </FieldHelp>
                </span>
                <select
                  value={assetRefs.workload ?? ""}
                  onChange={(event) => updateAssetRefs({ workload: event.target.value })}
                >
                  <option value="">Select a verified workload</option>
                  {assetOptions("workload").map((asset: any) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </select>
                <small>
                  {staleAssetFields.includes("workload")
                    ? "The previous workload is no longer ready. Choose a current option."
                    : choiceStatus(workloadChoices, assetRefs.workload ?? "", (asset) => asset.id)}
                </small>
              </label>
              <label>
                <span>
                  Database image{" "}
                  <FieldHelp label="Database image">
                    Select a discovered non-latest database image.
                  </FieldHelp>
                </span>
                <select
                  value={assetRefs.databaseImage ?? ""}
                  onChange={(event) => updateAssetRefs({ databaseImage: event.target.value })}
                >
                  <option value="">Select a verified database image</option>
                  {assetOptions("database_image").map((asset: any) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                      {asset.version ? ` — ${asset.version}` : ""}
                    </option>
                  ))}
                </select>
                <small>
                  {staleAssetFields.includes("databaseImage")
                    ? "The previous database image is no longer ready. Choose a current option."
                    : choiceStatus(
                        databaseChoices,
                        assetRefs.databaseImage ?? "",
                        (asset) => asset.id
                      )}
                </small>
              </label>
              <label>
                <span>
                  PAS image{" "}
                  <FieldHelp label="PAS image">Select a discovered non-latest PAS image.</FieldHelp>
                </span>
                <select
                  value={assetRefs.pasImage ?? ""}
                  onChange={(event) => updateAssetRefs({ pasImage: event.target.value })}
                >
                  <option value="">Select a verified PAS image</option>
                  {assetOptions("pas_image").map((asset: any) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                      {asset.version ? ` — ${asset.version}` : ""}
                    </option>
                  ))}
                </select>
                <small>
                  {staleAssetFields.includes("pasImage")
                    ? "The previous PAS image is no longer ready. Choose a current option."
                    : choiceStatus(pasChoices, assetRefs.pasImage ?? "", (asset) => asset.id)}
                </small>
              </label>
              <label>
                <span>
                  Lifecycle phases (seconds){" "}
                  <FieldHelp label="Lifecycle phases">
                    Warmup and cooldown establish boundaries; measurement seconds are the evidence
                    window.
                  </FieldHelp>
                </span>
                <div className="scenario-phase-grid">
                  {(["warmupSeconds", "measurementSeconds", "cooldownSeconds"] as const).map(
                    (phase) => (
                      <input
                        key={phase}
                        aria-label={phase}
                        type="number"
                        min={phase === "measurementSeconds" ? 1 : 0}
                        value={draft.phases?.[phase] ?? 0}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            phases: { ...draft.phases, [phase]: Number(event.target.value) }
                          })
                        }
                      />
                    )
                  )}
                </div>
              </label>
              <label>
                <span>
                  Observer assets{" "}
                  <FieldHelp label="Observer assets">
                    Observers collect required measurements and report health for the run.
                  </FieldHelp>
                </span>
                <div className="check-list">
                  {assets
                    .filter((asset: any) => ["observer", "observer_image"].includes(asset.kind))
                    .map((asset: any) => {
                      const checked = (assetRefs.observers ?? []).includes(asset.id);
                      return (
                        <label key={asset.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) =>
                              updateAssetRefs({
                                observers: event.target.checked
                                  ? [...new Set([...(assetRefs.observers ?? []), asset.id])]
                                  : (assetRefs.observers ?? []).filter(
                                      (id: string) => id !== asset.id
                                    )
                              })
                            }
                          />
                          {asset.name}
                        </label>
                      );
                    })}
                </div>
              </label>
              <section className="parameter-editor" aria-label="Required measurements">
                <div className="panel-heading">
                  <div>
                    <h3>Required measurements</h3>
                    <p className="muted">
                      Measurements marked required determine the run's recorded measurement quality.
                      Available results can still be compared when required measurements are
                      missing.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((current: any) => ({
                        ...current,
                        requiredMeasurements: [
                          ...(current.requiredMeasurements ?? []),
                          {
                            id: `measurement-${(current.requiredMeasurements ?? []).length + 1}`,
                            metricName: "",
                            source: "workload",
                            phases: ["measurement"]
                          }
                        ]
                      }))
                    }
                  >
                    Add required measurement
                  </button>
                </div>
                {requiredMeasurements.map((measurement: any, index: number) => (
                  <div className="dimension-row" key={`${measurement.id}-${index}`}>
                    <label>
                      <span>Identifier</span>
                      <input
                        value={measurement.id}
                        onChange={(event) => updateMeasurement(index, { id: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Metric</span>
                      <input
                        value={measurement.metricName}
                        onChange={(event) =>
                          updateMeasurement(index, { metricName: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Source</span>
                      <select
                        value={measurement.source}
                        onChange={(event) =>
                          updateMeasurement(index, {
                            source: event.target.value,
                            observerId:
                              event.target.value === "observer" ? measurement.observerId : undefined
                          })
                        }
                      >
                        {["workload", "database", "pas", "observer"].map((source) => (
                          <option key={source}>{source}</option>
                        ))}
                      </select>
                    </label>
                    {measurement.source === "observer" && (
                      <label>
                        <span>Observer</span>
                        <select
                          value={measurement.observerId ?? ""}
                          onChange={(event) =>
                            updateMeasurement(index, { observerId: event.target.value })
                          }
                        >
                          <option value="">Choose an observer</option>
                          {(draft.observers ?? []).map((observer: any) => (
                            <option key={observer.id} value={observer.id}>
                              {observer.id}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <fieldset>
                      <legend>Phases</legend>
                      {(["warmup", "measurement", "cooldown"] as const).map((phase) => (
                        <label key={phase}>
                          <input
                            type="checkbox"
                            checked={(measurement.phases ?? []).includes(phase)}
                            onChange={(event) =>
                              updateMeasurement(index, {
                                phases: event.target.checked
                                  ? [...new Set([...(measurement.phases ?? []), phase])]
                                  : (measurement.phases ?? []).filter(
                                      (item: string) => item !== phase
                                    )
                              })
                            }
                          />
                          {phase}
                        </label>
                      ))}
                    </fieldset>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current: any) => ({
                          ...current,
                          requiredMeasurements: (current.requiredMeasurements ?? []).filter(
                            (_item: any, itemIndex: number) => itemIndex !== index
                          )
                        }))
                      }
                    >
                      Remove measurement
                    </button>
                  </div>
                ))}
                {requiredMeasurements.length === 0 && (
                  <p className="muted">No required measurements are declared for this scenario.</p>
                )}
              </section>
              <dl className="details">
                <dt>Workload operations</dt>
                <dd>{draft.workload?.operations?.length ?? 0}</dd>
                <dt>Target</dt>
                <dd className="mono">{JSON.stringify(draft.target)}</dd>
                <dt>Phases</dt>
                <dd className="mono">{JSON.stringify(draft.phases)}</dd>
                <dt>Observers</dt>
                <dd className="mono">{JSON.stringify(draft.observers)}</dd>
              </dl>
              <h3>
                Database parameters{" "}
                <FieldHelp label="Database parameters">
                  Typed definitions control valid overrides and matrix dimensions exposed to the
                  scheduler.
                </FieldHelp>
              </h3>
              <section className="parameter-editor">
                {definitions.map((definition: any, index) => {
                  const allowedValues =
                    parseAllowedValues(definition, definition.allowedValuesText ?? "") ??
                    (definition.type === "boolean" ? [true, false] : []);
                  const isNumeric = definition.type === "integer" || definition.type === "number";
                  return (
                    <article className="panel parameter-definition" key={definition.id}>
                      <div className="panel-heading">
                        <label>
                          <span>
                            Parameter name{" "}
                            <FieldHelp label="Parameter name">
                              Choose a parameter supported by the current ParkBench runtime.
                            </FieldHelp>
                          </span>
                          <select
                            aria-label={`${definition.canonicalName} parameter name`}
                            value={definition.canonicalName}
                            onChange={(event) =>
                              updateDefinition(index, { canonicalName: event.target.value })
                            }
                          >
                            {!Object.hasOwn(ALLOWED_PARAMETERS, definition.canonicalName) && (
                              <option>{definition.canonicalName}</option>
                            )}
                            {Object.keys(ALLOWED_PARAMETERS).map((name) => (
                              <option key={name}>{name}</option>
                            ))}
                          </select>
                        </label>
                        <div>
                          <strong>
                            Default: {definition.defaultValue ?? "not set"}
                            {definition.unit ? ` ${definition.unit}` : ""}
                          </strong>
                          <button
                            type="button"
                            onClick={() =>
                              setDefinitions((current) =>
                                current.filter((_item, itemIndex) => itemIndex !== index)
                              )
                            }
                          >
                            Remove parameter
                          </button>
                        </div>
                      </div>
                      <div className="dimension-row">
                        <label>
                          <span>Type</span>
                          <select
                            value={definition.type}
                            onChange={(event) =>
                              updateDefinition(index, { type: event.target.value })
                            }
                          >
                            {["integer", "number", "string", "boolean", "enum"].map((type) => (
                              <option key={type}>{type}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Default value</span>
                          {definition.type === "boolean" ||
                          (definition.type === "enum" && allowedValues.length > 0) ? (
                            <select
                              aria-label={`${definition.canonicalName} default`}
                              value={String(definition.defaultValue ?? "")}
                              onChange={(event) =>
                                updateDefinition(index, {
                                  defaultValue: parseParameterValue(definition, event.target.value)
                                })
                              }
                            >
                              <option value="">No default</option>
                              {(definition.type === "boolean" ? [true, false] : allowedValues).map(
                                (value: any) => (
                                  <option key={String(value)} value={String(value)}>
                                    {String(value)}
                                  </option>
                                )
                              )}
                            </select>
                          ) : (
                            <input
                              aria-label={`${definition.canonicalName} default`}
                              type={isNumeric ? "number" : "text"}
                              min={isNumeric ? definition.minimum : undefined}
                              max={isNumeric ? definition.maximum : undefined}
                              step={isNumeric ? definition.step : undefined}
                              value={String(definition.defaultValue ?? "")}
                              onChange={(event) =>
                                updateDefinition(index, {
                                  defaultValue: parseParameterValue(definition, event.target.value)
                                })
                              }
                            />
                          )}
                        </label>
                        <label>
                          <span>Units</span>
                          <input
                            aria-label={`${definition.canonicalName} units`}
                            value={definition.unit ?? ""}
                            onChange={(event) =>
                              updateDefinition(index, { unit: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      {isNumeric && (
                        <div className="dimension-row">
                          <label>
                            <span>Minimum</span>
                            <input
                              type="number"
                              value={definition.minimum ?? ""}
                              onChange={(event) =>
                                updateDefinition(index, {
                                  minimum: event.target.value
                                    ? Number(event.target.value)
                                    : undefined
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Maximum</span>
                            <input
                              type="number"
                              value={definition.maximum ?? ""}
                              onChange={(event) =>
                                updateDefinition(index, {
                                  maximum: event.target.value
                                    ? Number(event.target.value)
                                    : undefined
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Step</span>
                            <input
                              type="number"
                              min="0.000001"
                              value={definition.step ?? ""}
                              onChange={(event) =>
                                updateDefinition(index, {
                                  step: event.target.value ? Number(event.target.value) : undefined
                                })
                              }
                            />
                          </label>
                        </div>
                      )}
                      {definition.type === "enum" && (
                        <label>
                          <span>Allowed values</span>
                          <input
                            aria-label={`${definition.canonicalName} allowed values`}
                            placeholder="Comma-separated choices"
                            value={definition.allowedValuesText ?? ""}
                            onChange={(event) =>
                              updateDefinition(index, { allowedValuesText: event.target.value })
                            }
                          />
                        </label>
                      )}
                      <label>
                        <span>Definition source</span>
                        <input
                          value={definition.source ?? ""}
                          onChange={(event) =>
                            updateDefinition(index, { source: event.target.value })
                          }
                        />
                      </label>
                      <section aria-label={`${definition.canonicalName} dependencies`}>
                        <div className="panel-heading">
                          <h4>Dependencies</h4>
                          <button
                            type="button"
                            onClick={() =>
                              updateDefinition(index, {
                                dependencies: [
                                  ...(definition.dependencies ?? []),
                                  {
                                    parameter:
                                      definitions.find((item, itemIndex) => itemIndex !== index)
                                        ?.canonicalName ?? "",
                                    operator: "eq",
                                    value: ""
                                  }
                                ]
                              })
                            }
                          >
                            Add dependency
                          </button>
                        </div>
                        {(definition.dependencies ?? []).map((rule: any, ruleIndex: number) => {
                          const dependency = definitions.find(
                            (item) => item.canonicalName === rule.parameter
                          );
                          const dependencyValues = dependency
                            ? (parseAllowedValues(dependency, dependency.allowedValuesText ?? "") ??
                              dependency.allowedValues ??
                              (dependency.type === "boolean" ? [true, false] : []))
                            : [];
                          const listOperator = rule.operator === "in" || rule.operator === "notIn";
                          return (
                            <div className="dimension-row" key={`${rule.parameter}-${ruleIndex}`}>
                              <select
                                aria-label={`${definition.canonicalName} dependency parameter`}
                                value={rule.parameter}
                                onChange={(event) =>
                                  updateDependency(index, ruleIndex, {
                                    parameter: event.target.value
                                  })
                                }
                              >
                                <option value="">Choose parameter</option>
                                {definitions
                                  .filter((item, itemIndex) => itemIndex !== index)
                                  .map((item) => (
                                    <option key={item.id} value={item.canonicalName}>
                                      {item.canonicalName}
                                    </option>
                                  ))}
                              </select>
                              <select
                                aria-label={`${definition.canonicalName} dependency operator`}
                                value={rule.operator}
                                onChange={(event) =>
                                  updateDependency(index, ruleIndex, {
                                    operator: event.target.value
                                  })
                                }
                              >
                                {["eq", "neq", "in", "notIn", "gt", "gte", "lt", "lte"].map(
                                  (operator) => (
                                    <option key={operator}>{operator}</option>
                                  )
                                )}
                              </select>
                              {dependencyValues.length > 0 ? (
                                <select
                                  aria-label={`${definition.canonicalName} dependency value`}
                                  multiple={listOperator}
                                  value={
                                    listOperator
                                      ? (Array.isArray(rule.value) ? rule.value : [rule.value]).map(
                                          String
                                        )
                                      : String(rule.value ?? "")
                                  }
                                  onChange={(event) => {
                                    const rawValues = listOperator
                                      ? [...event.currentTarget.selectedOptions].map(
                                          (option) => option.value
                                        )
                                      : [event.target.value];
                                    updateDependency(index, ruleIndex, {
                                      value: listOperator
                                        ? rawValues.map((raw) =>
                                            parseParameterValue(dependency, raw)
                                          )
                                        : parseParameterValue(dependency, rawValues[0])
                                    });
                                  }}
                                >
                                  {dependencyValues.map((value: any) => (
                                    <option key={String(value)} value={String(value)}>
                                      {String(value)}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  aria-label={`${definition.canonicalName} dependency value`}
                                  type={
                                    dependency && ["integer", "number"].includes(dependency.type)
                                      ? "number"
                                      : "text"
                                  }
                                  value={
                                    Array.isArray(rule.value)
                                      ? rule.value.join(", ")
                                      : String(rule.value ?? "")
                                  }
                                  onChange={(event) => {
                                    const values = event.target.value
                                      .split(",")
                                      .map((item) => item.trim());
                                    updateDependency(index, ruleIndex, {
                                      value: listOperator
                                        ? values.map((raw) =>
                                            dependency ? parseParameterValue(dependency, raw) : raw
                                          )
                                        : dependency
                                          ? parseParameterValue(dependency, event.target.value)
                                          : event.target.value
                                    });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  updateDefinition(index, {
                                    dependencies: definition.dependencies.filter(
                                      (_item: any, itemIndex: number) => itemIndex !== ruleIndex
                                    )
                                  })
                                }
                              >
                                Remove rule
                              </button>
                            </div>
                          );
                        })}
                      </section>
                    </article>
                  );
                })}
                <div className="dimension-row">
                  <label>
                    <span>Add supported parameter</span>
                    <select
                      value={newParameterName}
                      onChange={(event) => setNewParameterName(event.target.value)}
                    >
                      <option value="">Choose a parameter</option>
                      {Object.keys(ALLOWED_PARAMETERS)
                        .filter((name) => !definitions.some((item) => item.canonicalName === name))
                        .map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                    </select>
                  </label>
                  <button type="button" disabled={!newParameterName} onClick={addParameter}>
                    Add parameter
                  </button>
                </div>
              </section>
            </>
          ) : (
            <p className="muted">Choose a scenario version.</p>
          )}
        </section>
      </section>
    </main>
  );
}
