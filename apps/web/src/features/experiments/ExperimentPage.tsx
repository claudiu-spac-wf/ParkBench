import { DatabaseParameterCatalog } from "./DatabaseParameterCatalog";
import { getUiOptions } from "../../shared/control-ui-client";
import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { createExperiment } from "./experimentApi";
import { preflight } from "../bootstrap/bootstrapApi";
import { FieldHelp } from "../../shared/FieldHelp";
import {
  RunControlsFields,
  mergeRunControlValues,
  validRunControlsInput
} from "./RunControlsFields";
export function ExperimentPage() {
  const [parameterOptions, setParameterOptions] = useState([] as any[]);
  const [fixedStartup, setFixedStartup] = useState({} as Record<string, string | number | boolean>);
  const [scenarios, setScenarios] = useState([]);
  const [scenario, setScenario] = useState();
  const [result, setResult] = useState();
  const [repetitions, setRepetitions] = useState(1);
  const [pasReplicas, setPasReplicas] = useState(1);
  const [baselineVariantId, setBaselineVariantId] = useState("baseline");
  const [comparisonMode, setComparisonMode] = useState(
    "comparative" as "comparative" | "exploratory"
  );
  const [databaseImage, setDatabaseImage] = useState("openedge-db:fixture");
  const [pasImage, setPasImage] = useState("openedge-pas:fixture");
  const [seed, setSeed] = useState("input:seed");
  const [applicationArchive, setApplicationArchive] = useState("input:archive");
  const [credentialRef, setCredentialRef] = useState("");
  const [variants, setVariants] = useState([
    { id: "baseline", name: "Baseline", parameters: "{}" }
  ]);
  const [preflightResult, setPreflightResult] = useState();
  const [runControls, setRunControls] = useState({} as Record<string, string>);
  useEffect(() => {
    void getUiOptions()
      .then((options) => setParameterOptions(options.databaseParameters?.parameters ?? []))
      .catch(() => undefined);
    void api("/scenarios")
      .then((value: any) => {
        setScenarios(value.scenarios ?? []);
        const first = value.scenarios?.[0];
        setScenario(first);
        if (first?.target?.pasReplicas) setPasReplicas(first.target.pasReplicas);
      })
      .catch(() => undefined);
  }, []);
  const submit = () => {
    if (!scenario || !validRunControlsInput(runControls)) return;
    let parsedVariants: Array<{ id: string; name: string; parameters: Record<string, unknown> }>;
    try {
      parsedVariants = variants.map((variant) => ({
        id: variant.id.trim(),
        name: variant.name.trim(),
        parameters: mergeRunControlValues(
          { ...fixedStartup, ...JSON.parse(variant.parameters) },
          runControls
        )
      }));
    } catch (error) {
      setResult({
        error:
          error instanceof SyntaxError
            ? "Every variant parameter value must be valid JSON."
            : (error as Error).message
      });
      return;
    }
    const request = {
      scenario: { ...scenario, target: { ...scenario.target, pasReplicas } },
      comparisonMode,
      ...(comparisonMode === "comparative" ? { baselineVariantId } : {}),
      repetitions,
      variants: parsedVariants,
      inputs: {
        databaseImage,
        pasImage,
        seed,
        applicationArchive,
        ...(credentialRef ? { credentialRef } : {})
      }
    };
    void preflight({ scenario: request.scenario, request })
      .then((checked) => {
        setPreflightResult(checked);
        return createExperiment(request);
      })
      .then(setResult)
      .catch((error) => setResult({ error: error.message }));
  };
  return (
    <main>
      <h1>Experiments</h1>
      <label>
        <span>
          Scenario{" "}
          <FieldHelp label="Scenario">
            The versioned scenario used to create this experiment.
          </FieldHelp>
        </span>
        <select
          value={scenario ? `${scenario.id}@${scenario.version}` : ""}
          onChange={(event) => {
            const next = scenarios.find(
              (item) => `${item.id}@${item.version}` === event.target.value
            );
            setScenario(next);
            if (next?.target?.pasReplicas) setPasReplicas(next.target.pasReplicas);
          }}
        >
          {scenarios.map((item) => (
            <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>
              {item.id}@{item.version}
            </option>
          ))}
        </select>
      </label>
      <p>Select a scenario, baseline, variants, and repetitions.</p>
      <label>
        <span>
          Comparison mode{" "}
          <FieldHelp label="Comparison mode">
            Comparative mode supports baseline-relative deltas; exploratory mode records descriptive
            results.
          </FieldHelp>
        </span>
        <select
          value={comparisonMode}
          onChange={(event) =>
            setComparisonMode(event.target.value as "comparative" | "exploratory")
          }
        >
          <option value="comparative">Comparative</option>
          <option value="exploratory">Exploratory</option>
        </select>
      </label>
      <label>
        <span>
          Repetitions{" "}
          <FieldHelp label="Repetitions">
            The number of independent executions for each variant.
          </FieldHelp>
        </span>
        <input
          type="number"
          min="1"
          value={repetitions}
          onChange={(event) => setRepetitions(Number(event.target.value))}
        />
      </label>
      <label>
        <span>
          PAS replicas{" "}
          <FieldHelp label="PAS replicas">
            The number of PAS instances in each run-owned topology.
          </FieldHelp>
        </span>
        <input
          type="number"
          min="1"
          max="8"
          value={pasReplicas}
          onChange={(event) => setPasReplicas(Number(event.target.value))}
        />
      </label>
      <label>
        <span>
          Database image{" "}
          <FieldHelp label="Database image">
            The configured non-latest database image reference for this experiment.
          </FieldHelp>
        </span>
        <input value={databaseImage} onChange={(event) => setDatabaseImage(event.target.value)} />
      </label>
      <label>
        <span>
          PAS image{" "}
          <FieldHelp label="PAS image">The configured non-latest PAS image reference.</FieldHelp>
        </span>
        <input value={pasImage} onChange={(event) => setPasImage(event.target.value)} />
      </label>
      <label>
        <span>
          Seed reference{" "}
          <FieldHelp label="Seed reference">The immutable seed input reference.</FieldHelp>
        </span>
        <input value={seed} onChange={(event) => setSeed(event.target.value)} />
      </label>
      <label>
        <span>
          Application archive{" "}
          <FieldHelp label="Application archive">
            The immutable application archive input.
          </FieldHelp>
        </span>
        <input
          value={applicationArchive}
          onChange={(event) => setApplicationArchive(event.target.value)}
        />
      </label>
      <label>
        <span>
          Credential reference{" "}
          <FieldHelp label="Credential reference">
            A reference to a secret, never the secret value itself.
          </FieldHelp>
        </span>
        <input
          value={credentialRef}
          placeholder="credential:pas-readonly"
          onChange={(event) => setCredentialRef(event.target.value)}
        />
      </label>
      <RunControlsFields
        values={runControls}
        onChange={(name, value) => setRunControls((current) => ({ ...current, [name]: value }))}
      />
      <DatabaseParameterCatalog
        options={parameterOptions}
        values={fixedStartup}
        onChange={setFixedStartup}
      />
      <fieldset>
        <legend>Variants</legend>
        {variants.map((variant, index) => (
          <div key={index}>
            <label>
              <span>
                ID <FieldHelp label="Variant ID">A stable identifier for this variant.</FieldHelp>
              </span>
              <input
                value={variant.id}
                onChange={(event) =>
                  setVariants((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, id: event.target.value } : item
                    )
                  )
                }
              />
            </label>
            <label>
              <span>
                Name{" "}
                <FieldHelp label="Variant name">A human-readable label for the variant.</FieldHelp>
              </span>
              <input
                value={variant.name}
                onChange={(event) =>
                  setVariants((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name: event.target.value } : item
                    )
                  )
                }
              />
            </label>
            <label>
              <span>
                Parameters{" "}
                <FieldHelp label="Variant parameters">
                  A JSON object of fixed database parameter overrides.
                </FieldHelp>
              </span>
              <textarea
                value={variant.parameters}
                onChange={(event) =>
                  setVariants((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, parameters: event.target.value } : item
                    )
                  )
                }
              />
            </label>
            {variants.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setVariants((current) => {
                    const remaining = current.filter((_, itemIndex) => itemIndex !== index);
                    if (baselineVariantId === variant.id)
                      setBaselineVariantId(remaining[0]?.id ?? "");
                    return remaining;
                  });
                }}
              >
                Remove variant
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setVariants((current) => [
              ...current,
              {
                id: `variant-${current.length + 1}`,
                name: `Variant ${current.length + 1}`,
                parameters: "{}"
              }
            ])
          }
        >
          Add variant
        </button>
      </fieldset>
      {comparisonMode === "comparative" && (
        <label>
          <span>
            Baseline variant{" "}
            <FieldHelp label="Baseline variant">
              The variant used for relative comparison. You can also select a run later in the
              comparison workflow.
            </FieldHelp>
          </span>
          <select
            value={baselineVariantId}
            onChange={(event) => setBaselineVariantId(event.target.value)}
          >
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.name || variant.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <button onClick={submit} disabled={!scenario || !variants.length}>
        Submit experiment
      </button>
      {preflightResult && <p role="status">Preflight passed; experiment submission accepted.</p>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
      <a href="#history">Run history</a>
    </main>
  );
}
