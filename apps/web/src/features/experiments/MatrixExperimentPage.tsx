import { DatabaseParameterHelp } from "./DatabaseParameterHelp";
import { DATABASE_RUN_CONTROL_HELP } from "../../../../../packages/contracts/src/database-run-control-help";
import { DatabaseParameterCatalog, parseStartupDimension } from "./DatabaseParameterCatalog";
import React, { useEffect, useState } from "react";
import {
  getAllCatalog,
  getPreviewCells,
  getUiOptions,
  previewMatrix,
  refreshCatalogDiscovery,
  submitPreview
} from "../../shared/control-ui-client";
import { FieldHelp } from "../../shared/FieldHelp";
import { WorkflowState } from "../../shared/workflow-state";
import {
  choiceStatus,
  defaultChoice,
  eligibleManagedInputOptions,
  isStaleAssetError,
  managedAssetReference
} from "../../shared/asset-options";

import {
  RunControlsFields,
  RunControlsSummary,
  runControlFields,
  mergeRunControlValues,
  validRunControlsInput
} from "./RunControlsFields";

type Dimension = { id: number; name: string; values: string };
const LATENCY_PARAMETER = "network.databaseLatencyMs";
/** Matrix cells show a non-zero Database Latency with its round-trip effect. */
export const latencyLabel = (value: unknown) =>
  typeof value === "number" && value > 0 ? `Latency ${value} ms (≈${2 * value} ms RTT)` : "";
const cellIdentity = (cell: any) => `${cell.ordinal}:${cell.repetition}`;
const allCellsUnique = (cells: any[]) => new Set(cells.map(cellIdentity)).size === cells.length;
const assetFieldLabels: Record<string, string> = {
  seed: "Seed",
  applicationArchive: "Application archive"
};

export function MatrixExperimentPage() {
  const parameterSummaryId = React.useId();
  const nextDimensionId = React.useRef(2);
  const dimensionSelectors = React.useRef(new Map<number, HTMLSelectElement>());
  const addDimensionButton = React.useRef(null as HTMLButtonElement | null);
  const pendingDimensionFocus = React.useRef(undefined as number | "add" | undefined);
  const [runName, setRunName] = useState("");
  const [scenarios, setScenarios] = useState([] as any[]);
  const [scenario, setScenario] = useState(undefined as any);
  const [assets, setAssets] = useState([] as any[]);
  const [seed, setSeed] = useState("");
  const [applicationArchive, setApplicationArchive] = useState("");
  const [fixedStartup, setFixedStartup] = useState({} as Record<string, string | number | boolean>);
  const [parameterOptions, setParameterOptions] = useState([] as any[]);
  const [dimensions, setDimensions] = useState([
    { id: 1, name: "-B", values: "500, 1000, 1500, 2000" }
  ] as Dimension[]);
  React.useLayoutEffect(() => {
    const target = pendingDimensionFocus.current;
    if (target === undefined) return;
    pendingDimensionFocus.current = undefined;
    if (target === "add") addDimensionButton.current?.focus();
    else dimensionSelectors.current.get(target)?.focus();
  }, [dimensions]);
  const [repetitions, setRepetitions] = useState(1);
  const [databaseLatency, setDatabaseLatency] = useState("");
  const [runControls, setRunControls] = useState({} as Record<string, string>);
  const [preview, setPreview] = useState(undefined as any);
  const [previewCells, setPreviewCells] = useState([] as any[]);
  const [nextPreviewToken, setNextPreviewToken] = useState(undefined as string | undefined);
  const [result, setResult] = useState(undefined as any);
  const [error, setError] = useState("");
  const [staleAssetFields, setStaleAssetFields] = useState([] as string[]);
  const [pending, setPending] = useState(false);
  const [loadingChoices, setLoadingChoices] = useState(true);
  const [errorAction, setErrorAction] = useState(
    "choices" as "choices" | "preview" | "review" | "submit"
  );
  const normalizedRunName = runName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const validRunName =
    normalizedRunName.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedRunName);
  const latencyAsDimension = dimensions.some(
    (dimension) => dimension.name.trim() === LATENCY_PARAMETER
  );
  const latencyText = databaseLatency.trim();
  const latencyValue = latencyText === "" ? 0 : Number(latencyText);
  const latencyValid =
    latencyAsDimension ||
    latencyText === "" ||
    (/^\d+$/.test(latencyText) && latencyValue >= 0 && latencyValue <= 1000);
  const loadChoices = async (refreshSources = false) => {
    setError("");
    setErrorAction("choices");
    setLoadingChoices(true);
    try {
      if (refreshSources) await refreshCatalogDiscovery();
      const results = await Promise.allSettled([
        getAllCatalog("category=scenarios"),
        getAllCatalog(),
        getUiOptions()
      ]);
      const [scenarioResult, assetResult, optionsResult] = results;
      let nextScenarios = scenarios;
      if (scenarioResult.status === "fulfilled") {
        const scenarioValue = scenarioResult.value;
        const availableScenarios = (scenarioValue.items ?? []).filter(
          (item: any) => item.sourceStatus === "AVAILABLE"
        );
        nextScenarios = availableScenarios;
        setScenarios(availableScenarios);
        setScenario((current: any) =>
          current && availableScenarios.some((item: any) => item.id === current.id)
            ? current
            : defaultChoice<any>(availableScenarios)?.choice
        );
      } else setError(scenarioResult.reason.message);
      if (assetResult.status === "fulfilled") {
        const available = assetResult.value.items ?? [];
        if (refreshSources) {
          const activeScenario =
            (scenario && nextScenarios.some((item: any) => item.id === scenario.id)
              ? scenario
              : defaultChoice<any>(nextScenarios)?.choice) ?? undefined;
          const invalidated = [
            ["seed", seed, eligibleManagedInputOptions(available, "seed"), managedAssetReference],
            [
              "applicationArchive",
              applicationArchive,
              eligibleManagedInputOptions(available, "archive"),
              managedAssetReference
            ]
          ].flatMap(([key, value, choices, getReference]: any[]) =>
            value && !choices.some((asset: any) => getReference(asset) === value) ? [key] : []
          );
          setStaleAssetFields(invalidated);
          if (invalidated.length) invalidatePreview();
        }
        setAssets(available);
      } else setError((current) => current || assetResult.reason.message);
      if (optionsResult.status === "fulfilled")
        setParameterOptions([
          ...(optionsResult.value.databaseParameters?.parameters ?? []),
          ...(optionsResult.value.runParameters ?? []).map((definition: any) => ({
            ...(DATABASE_RUN_CONTROL_HELP[
              definition.canonicalName as keyof typeof DATABASE_RUN_CONTROL_HELP
            ] ?? {}),
            name: definition.canonicalName,
            label:
              runControlFields.find((field) => field.name === definition.canonicalName)?.label ??
              "Database latency (ms)",
            description: definition.description,
            explanation: definition.explanation,
            unit: definition.unit,
            minimum: definition.minimum,
            maximum: definition.maximum,
            kind: definition.type,
            available: true
          }))
        ]);
      else setError((current) => current || optionsResult.reason.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingChoices(false);
    }
  };
  useEffect(() => {
    loadChoices();
  }, []);
  const seedChoices = eligibleManagedInputOptions(assets, "seed");
  const archiveChoices = eligibleManagedInputOptions(assets, "archive");
  useEffect(() => {
    const selectDefault = (
      field: string,
      choices: any[],
      current: string,
      setter: (value: string) => void,
      getReference: (asset: any) => string | undefined
    ) => {
      if (staleAssetFields.includes(field)) {
        setter("");
        return;
      }
      if (choices.some((asset) => getReference(asset) === current)) return;
      const selected = defaultChoice<any>(choices)?.choice;
      setter(selected ? (getReference(selected) ?? "") : "");
    };
    selectDefault("seed", seedChoices, seed, setSeed, managedAssetReference);
    selectDefault(
      "applicationArchive",
      archiveChoices,
      applicationArchive,
      setApplicationArchive,
      managedAssetReference
    );
  }, [scenario, assets, staleAssetFields]);
  const request = () => ({
    runName,
    scenarioSourceId: scenario.id,
    dimensions: dimensions.map((dimension) => ({
      name: dimension.name.trim(),
      values: parseStartupDimension(
        dimension.values,
        parameterOptions.find((p) => p.name === dimension.name)
      )
    })),
    repetitions,
    fixedOverrides: {
      ...mergeRunControlValues(
        fixedStartup,
        runControls,
        dimensions.map((d) => d.name.trim())
      ),
      ...(!latencyAsDimension && latencyText !== "" ? { [LATENCY_PARAMETER]: latencyValue } : {})
    },
    inputs: Object.fromEntries(
      Object.entries({ seed, applicationArchive }).filter(([, value]) => Boolean(value))
    )
  });
  const previewNow = () => {
    if (pending || loadingChoices) return;
    invalidatePreview();
    setError("");
    setErrorAction("preview");
    setPending(true);
    let prepared;
    try {
      prepared = request();
    } catch (e) {
      setError((e as Error).message);
      setPending(false);
      return;
    }
    void previewMatrix(prepared)
      .then((value) => {
        if (!allCellsUnique(value.cells?.items ?? []))
          throw new Error("Preview contained repeated cells. Preview the matrix again.");
        setPreview(value);
        setPreviewCells(value.cells?.items ?? []);
        setNextPreviewToken(value.cells?.nextPageToken);
      })
      .catch((reason) => {
        setError(reason.message);
        if (isStaleAssetError(reason)) void loadChoices(true);
      })
      .finally(() => setPending(false));
  };
  const reviewComplete = Boolean(
    preview &&
    !nextPreviewToken &&
    previewCells.length === Number(preview.runCount ?? 0) &&
    allCellsUnique(previewCells)
  );
  const loadMorePreviewCells = () => {
    if (!preview?.previewId || !nextPreviewToken || pending) return;
    setError("");
    setErrorAction("review");
    setPending(true);
    void getPreviewCells(preview.previewId, nextPreviewToken)
      .then((value) => {
        const combined = [...previewCells, ...(value.cells?.items ?? [])];
        if (!allCellsUnique(combined))
          throw new Error(
            "Preview contained repeated cells. Retry loading cells or preview the matrix again."
          );
        if (!value.cells?.nextPageToken && combined.length !== Number(preview.runCount ?? 0))
          throw new Error("Preview ended before every run was reviewed. Preview the matrix again.");
        setPreviewCells(combined);
        setNextPreviewToken(value.cells?.nextPageToken);
      })
      .catch((reason) => {
        setError(reason.message);
        if (isStaleAssetError(reason)) void loadChoices(true);
      })
      .finally(() => setPending(false));
  };
  const submit = () => {
    if (!preview || !reviewComplete || pending) return;
    setPending(true);
    setError("");
    setErrorAction("submit");
    void submitPreview({
      previewId: preview.previewId,
      confirm: true
    })
      .then(setResult)
      .catch((reason) =>
        setError(
          reason.message === "run_name_conflict_repreview"
            ? "These run names were used while you reviewed the preview. Preview the matrix again to get the next available names."
            : reason.message
        )
      )
      .finally(() => setPending(false));
  };
  const invalidatePreview = () => {
    setPreview(undefined);
    setPreviewCells([]);
    setNextPreviewToken(undefined);
    setResult(undefined);
    setError("");
  };
  const selectedLabel = (
    choices: any[],
    value: string,
    getReference: (asset: any) => string | undefined
  ) => {
    const selected = choices.find((asset) => getReference(asset) === value);
    return selected
      ? `${selected.name}${selected.version ? ` — ${selected.version}` : ""}`
      : "Not selected";
  };
  const updateAssetChoice = (field: string, setter: (value: string) => void, value: string) => {
    setter(value);
    setStaleAssetFields((current) => current.filter((item) => item !== field));
    invalidatePreview();
  };
  const statusForAssetChoice = (
    field: string,
    choices: any[],
    value: string,
    getReference: (asset: any) => string | undefined
  ) =>
    staleAssetFields.includes(field)
      ? `The previous ${assetFieldLabels[field].toLowerCase()} is no longer ready. Choose a current option.`
      : choiceStatus(choices, value, getReference);
  return (
    <main className="control-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SCHEDULE / MATRIX</p>
          <h1>Schedule an experiment</h1>
          <p>Expand parameter dimensions on the server and review every run before queueing.</p>
        </div>
        <div className="button-row">
          <button
            type="button"
            disabled={loadingChoices || pending}
            onClick={() => void loadChoices(true)}
          >
            {loadingChoices ? "Refreshing…" : "Refresh choices"}
          </button>
          <a className="button secondary" href="#queue">
            Open queue
          </a>
        </div>
      </header>
      {staleAssetFields.length > 0 && (
        <WorkflowState
          state="invalid"
          message={`${staleAssetFields.map((field) => assetFieldLabels[field]).join(", ")} selection is no longer ready. Choose a current option before previewing or queueing.`}
        />
      )}
      {error && (
        <WorkflowState
          state="error"
          message={error}
          action={
            errorAction === "choices"
              ? "Retry loading"
              : errorAction === "preview"
                ? "Retry preview"
                : errorAction === "review"
                  ? "Retry loading cells"
                  : "Retry queue"
          }
          onAction={
            errorAction === "choices"
              ? loadChoices
              : errorAction === "preview"
                ? previewNow
                : errorAction === "review"
                  ? loadMorePreviewCells
                  : submit
          }
        />
      )}
      {loadingChoices && (
        <WorkflowState state="loading" message="Loading scenarios and ready assets…" />
      )}
      {!loadingChoices && !scenarios.length && !error && (
        <WorkflowState
          state="empty"
          message="No scenarios are available for scheduling yet."
          action="Reload choices"
          onAction={loadChoices}
        />
      )}
      <section className="panel">
        <label>
          <span>
            Scenario{" "}
            <FieldHelp label="Scenario">
              The versioned scenario defines the workload, target topology, and allowed database
              parameters.
            </FieldHelp>
          </span>
          <select
            disabled={pending || loadingChoices}
            value={scenario?.id ?? ""}
            onChange={(event) => {
              setScenario(scenarios.find((item) => item.id === event.target.value));
              invalidatePreview();
            }}
          >
            <option value="">Choose a scenario</option>
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.relativePath}
              </option>
            ))}
          </select>
          <small>
            {scenario
              ? `${scenario.declaredScenarioId ?? scenario.displayName} · ${scenario.relativePath}`
              : scenarios.length > 1
                ? `Choose explicitly from ${scenarios.length} available scenarios.`
                : "No ready scenarios are available."}
          </small>
        </label>
        <label>
          <span>
            Seed reference{" "}
            <FieldHelp label="Seed reference">
              An immutable managed input reference for database seed data.
            </FieldHelp>
          </span>
          <select
            disabled={pending || loadingChoices}
            value={seed}
            onChange={(event) => updateAssetChoice("seed", setSeed, event.target.value)}
          >
            <option value="">Choose seed</option>
            {seedChoices.map((asset: any) => (
              <option key={asset.id} value={managedAssetReference(asset)}>
                {asset.name}
              </option>
            ))}
          </select>
          <small>{statusForAssetChoice("seed", seedChoices, seed, managedAssetReference)}</small>
        </label>
        <label>
          <span>
            Application archive{" "}
            <FieldHelp label="Application archive">
              An immutable managed application archive reference.
            </FieldHelp>
          </span>
          <select
            disabled={pending || loadingChoices}
            value={applicationArchive}
            onChange={(event) =>
              updateAssetChoice("applicationArchive", setApplicationArchive, event.target.value)
            }
          >
            <option value="">Choose application archive</option>
            {archiveChoices.map((asset: any) => (
              <option key={asset.id} value={managedAssetReference(asset)}>
                {asset.name}
              </option>
            ))}
          </select>
          <small>
            {statusForAssetChoice(
              "applicationArchive",
              archiveChoices,
              applicationArchive,
              managedAssetReference
            )}
          </small>
        </label>
        <label>
          <span>Run name</span>
          <input
            aria-label="Run name"
            required
            maxLength={48}
            value={runName}
            placeholder="db-cache"
            disabled={pending || loadingChoices}
            onChange={(event) => {
              setRunName(event.target.value);
              invalidatePreview();
            }}
          />
          <small>
            Required. Use letters, numbers, spaces, hyphens, or underscores. Each experiment and run
            receives a four-character hexadecimal suffix.
          </small>
          {runName.trim() && !validRunName && (
            <small role="alert">
              Use up to 48 characters, starting and ending with a letter or number.
            </small>
          )}
        </label>
        <label>
          <span>
            Repetitions{" "}
            <FieldHelp label="Repetitions">
              How many independent repetitions are created for every matrix cell.
            </FieldHelp>
          </span>
          <input
            type="number"
            aria-label="Repetitions"
            min="1"
            value={repetitions}
            disabled={pending || loadingChoices}
            onChange={(event) => {
              setRepetitions(Number(event.target.value));
              invalidatePreview();
            }}
          />
        </label>
        <label>
          <span>
            Database latency (ms){" "}
            <FieldHelp label="Database latency">
              Delay added each way between PAS and the database. Round trip ≈ 2×.
            </FieldHelp>
          </span>
          <input
            type="number"
            aria-label="Database latency (ms)"
            min="0"
            max="1000"
            step="1"
            placeholder="0"
            value={latencyAsDimension ? "" : databaseLatency}
            disabled={pending || loadingChoices || latencyAsDimension}
            onChange={(event) => {
              setDatabaseLatency(event.target.value);
              invalidatePreview();
            }}
          />
          {latencyAsDimension ? (
            <small>Set as a matrix dimension below.</small>
          ) : (
            <small>Empty means no added latency. Whole milliseconds from 0 to 1000.</small>
          )}
          {!latencyValid && (
            <small role="alert">Enter a whole number of milliseconds from 0 to 1000.</small>
          )}
          {latencyValid && !latencyAsDimension && latencyValue > 100 && (
            <small className="notice warning" role="status">
              High latency multiplies every database round trip. High-volume operations may exceed
              the 60 s request timeout; consider lower Limits or larger prefetch settings.
            </small>
          )}
        </label>
        <RunControlsFields
          values={runControls}
          dimensions={dimensions.map((d) => d.name.trim())}
          disabled={pending || loadingChoices}
          onChange={(name, value) => {
            setRunControls((current) => ({ ...current, [name]: value }));
            invalidatePreview();
          }}
        />
        <DatabaseParameterCatalog
          options={parameterOptions.filter((p) => p.multiUser)}
          values={fixedStartup}
          dimensions={dimensions.map((d) => d.name)}
          disabled={pending || loadingChoices}
          onChange={(values) => {
            setFixedStartup(values);
            invalidatePreview();
          }}
        />
        <h2>
          Parameter dimensions{" "}
          <FieldHelp label="Parameter dimensions">
            Each dimension is crossed with every other dimension. Four values in two dimensions
            create 16 cells.
          </FieldHelp>
        </h2>
        {dimensions.map((dimension, index) => (
          <div className="dimension-row schedule-dimension" key={dimension.id}>
            <label>
              <span>
                Parameter name{" "}
                <FieldHelp label={`Parameter ${index + 1} name`}>
                  <DatabaseParameterHelp
                    option={parameterOptions.find((p) => p.name === dimension.name)}
                  />
                </FieldHelp>
              </span>
              <select
                disabled={pending || loadingChoices}
                aria-label={`Parameter ${index + 1} name`}
                aria-describedby={`${parameterSummaryId}-${dimension.id}`}
                ref={(node) => {
                  if (node) dimensionSelectors.current.set(dimension.id, node);
                  else dimensionSelectors.current.delete(dimension.id);
                }}
                value={dimension.name}
                onChange={(event) => {
                  setDimensions((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name: event.target.value } : item
                    )
                  );
                  invalidatePreview();
                }}
              >
                <option value="">Choose parameter</option>
                {parameterOptions
                  .filter((option) => option.available)
                  .map((option) => (
                    <option key={option.name} value={option.name}>
                      {option.label ?? option.name}
                    </option>
                  ))}
              </select>
              <small id={`${parameterSummaryId}-${dimension.id}`} className="parameter-summary">
                {parameterOptions.find((p) => p.name === dimension.name)?.description ??
                  "Choose a database startup parameter."}
              </small>
            </label>
            <label>
              <span>
                Values{" "}
                <FieldHelp label={`Parameter ${index + 1} values`}>
                  Comma-separated numbers, enums or booleans; literal text uses one value per line
                  or a JSON array. The scheduler crosses these values with every other dimension.
                </FieldHelp>
              </span>
              <input
                disabled={pending || loadingChoices}
                aria-label={`Parameter ${index + 1} values`}
                value={dimension.values}
                onChange={(event) => {
                  setDimensions((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, values: event.target.value } : item
                    )
                  );
                  invalidatePreview();
                }}
              />
            </label>
            <button
              type="button"
              disabled={pending || loadingChoices}
              onClick={() => {
                pendingDimensionFocus.current =
                  (dimensions[index + 1] ?? dimensions[index - 1])?.id ?? "add";
                setDimensions((current) => current.filter((item) => item.id !== dimension.id));
                invalidatePreview();
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            type="button"
            disabled={pending || loadingChoices}
            onClick={() => {
              const id = nextDimensionId.current++;
              setDimensions((current) => [...current, { id, name: "", values: "" }]);
              invalidatePreview();
            }}
            ref={addDimensionButton}
          >
            Add dimension
          </button>
          <button
            type="button"
            onClick={previewNow}
            disabled={
              !scenario ||
              !validRunName ||
              !latencyValid ||
              !validRunControlsInput(
                runControls,
                dimensions.map((d) => d.name.trim())
              ) ||
              pending ||
              loadingChoices ||
              staleAssetFields.length > 0
            }
          >
            {pending && errorAction === "preview" ? "Previewing…" : "Preview matrix"}
          </button>
        </div>
      </section>
      {preview && (
        <section className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <h2>
                Preview: {preview.cellCount} cells / {preview.runCount} runs
              </h2>
              <p className="notice warning">
                {preview.warning?.message} Explicit confirmation is required.
              </p>
            </div>
            <button onClick={submit} disabled={!reviewComplete || pending}>
              {pending && errorAction === "submit" ? "Queueing…" : "Confirm and queue"}
            </button>
          </div>
          <section className="review-summary" aria-label="Queue review summary">
            <h3>Review before queueing</h3>
            <dl className="details">
              <dt>Scenario:</dt>
              <dd>{scenario?.relativePath}</dd>
              <dt>Run name:</dt>
              <dd>{runName}</dd>
              <dt>Seed:</dt>
              <dd>{selectedLabel(seedChoices, seed, managedAssetReference)}</dd>
              <dt>Application archive:</dt>
              <dd>{selectedLabel(archiveChoices, applicationArchive, managedAssetReference)}</dd>
              <dt>Comparison mode:</dt>
              <dd>exploratory</dd>
              <dt>Repetitions:</dt>
              <dd>{repetitions}</dd>
              <dt>Database latency:</dt>
              <dd>{latencyAsDimension ? "matrix dimension" : `${latencyValue} ms`}</dd>
              <dt>Total runs:</dt>
              <dd>{preview.runCount}</dd>
            </dl>
          </section>
          <p className={reviewComplete ? "notice success" : "notice warning"} role="status">
            {reviewComplete
              ? `Reviewed all ${previewCells.length} expanded run configurations.`
              : `Load and review all ${preview.runCount} expanded run configurations before confirming (${previewCells.length} loaded).`}
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Run name</th>
                <th>Values</th>
                <th>Effective configuration</th>
                <th>Database startup values</th>
                <th>Repetition</th>
              </tr>
            </thead>
            <tbody>
              {previewCells.map((cell: any) => (
                <tr key={`${cell.ordinal}-${cell.repetition}`}>
                  <td>{cell.ordinal}</td>
                  <td className="mono">{cell.runName}</td>
                  <td className="mono">{JSON.stringify(cell.values)}</td>
                  <td className="mono">
                    {latencyLabel(cell.effectiveConfiguration?.[LATENCY_PARAMETER]) && (
                      <div>
                        <strong>
                          {latencyLabel(cell.effectiveConfiguration?.[LATENCY_PARAMETER])}
                        </strong>
                      </div>
                    )}
                    {JSON.stringify(cell.effectiveConfiguration)}
                  </td>
                  <td>
                    <RunControlsSummary controls={cell.databaseRunControls} />
                    <small>
                      startup.pf: {cell.databaseStartup?.startupFile?.status ?? "unavailable"}
                    </small>
                    {(cell.databaseStartup?.parameters ?? []).map((parameter: any) => (
                      <div key={parameter.name}>
                        <strong>
                          {parameter.name} {parameter.displayValue}
                        </strong>{" "}
                        <span className="status">{parameter.source}</span>
                      </div>
                    ))}
                  </td>
                  <td>{cell.repetition}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextPreviewToken && (
            <button type="button" onClick={loadMorePreviewCells} disabled={pending}>
              {pending && errorAction === "review" ? "Loading cells…" : "Load more preview cells"}
            </button>
          )}
        </section>
      )}
      {result && (
        <section className="panel success">
          <h2>Experiment queued</h2>
          <p>
            {result.name ?? result.id} — {result.runCount} runs queued.
          </p>
          {result.name && <small className="run-identity">{result.id}</small>}
          <a className="button" href="#queue">
            Monitor queue
          </a>
        </section>
      )}
    </main>
  );
}
