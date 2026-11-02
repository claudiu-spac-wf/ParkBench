#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  auditRunMeasurements,
  confirmationSequences,
  digest,
  nativeIdentityCovered,
  validateScreenshotPng
} from "./measurement-acceptance.mjs";
import { validateChartCapture } from "./capture-measurement-charts.mjs";
import { globalQueryAvailabilityMatches } from "./measurement-global-availability.mjs";
import { globalPlatformContextMatches } from "./measurement-chart-scope.mjs";
const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultRoot = path.join(repository, ".parkbench/validation/feature024");
const terminal = new Set([
  "SUCCEEDED",
  "INCOMPLETE",
  "THRESHOLD_FAILED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);
const opaque = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error("campaign_identity_invalid");
  return value;
};
export function campaignRunName(campaignId, configurationId, batchOrdinal) {
  const source = `${campaignId}-${configurationId}-${batchOrdinal}`;
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (normalized && normalized.length <= 48 && normalized === source.toLowerCase())
    return normalized;
  return `${(normalized || "campaign").slice(0, 39).replace(/-$/, "")}-${digest(source).slice(0, 8)}`;
}
function contracts() {
  try {
    return require(path.join(repository, "dist/packages/contracts/src/measurement-diagnostics.js"));
  } catch {
    throw new Error("campaign_contracts_build_required");
  }
}
async function readJson(file, max = 8 * 1024 ** 2) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error("campaign_file_unavailable");
  if ((await fs.realpath(file)) !== path.resolve(file)) throw new Error("campaign_symlink_refused");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function safeDirectory(root, directory) {
  const relative = path.relative(root, path.resolve(directory));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("campaign_path_outside_root");
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === ".") continue;
    current = path.join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (!(await fs.lstat(current)).isDirectory() || (await fs.realpath(current)) !== current)
      throw new Error("campaign_symlink_refused");
  }
}
async function writeJson(root, file, value, replace = false) {
  await safeDirectory(root, path.dirname(file));
  const body = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(body) > 8 * 1024 ** 2) throw new Error("campaign_metadata_limit");
  const target = replace ? file + "." + randomUUID() + ".tmp" : file,
    handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (replace) await fs.rename(target, file);
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export class CampaignStore {
  static async open(file, options = {}) {
    const lexicalRoot = path.resolve(options.root ?? defaultRoot),
      absolute = path.resolve(file);
    if (!absolute.startsWith(lexicalRoot + path.sep) || !absolute.endsWith(".json"))
      throw new Error("campaign_path_outside_root");
    await fs.mkdir(lexicalRoot, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(lexicalRoot)) !== lexicalRoot)
      throw new Error("campaign_symlink_refused");
    await safeDirectory(lexicalRoot, path.dirname(absolute));
    return new CampaignStore(
      lexicalRoot,
      absolute,
      options.validate ?? ((input) => contracts().validateMeasurementEvidence(input))
    );
  }
  constructor(root, file, validate) {
    this.root = root;
    this.file = file;
    this.directory = file.slice(0, -5) + ".state";
    this.validate = validate;
  }
  async declare(input, requests) {
    const campaign = this.validate(structuredClone(input));
    if (campaign.state !== "DECLARED" || campaign.attempts.length)
      throw new Error("campaign_declaration_invalid");
    opaque(campaign.campaignId);
    for (const configuration of campaign.configurations) {
      opaque(configuration.configurationId);
      const request = requests[configuration.configurationId];
      if (
        !request ||
        request.contractVersion !== "experiment-schedule.v2" ||
        request.scenarioSourceId !== configuration.scenarioSourceId ||
        request.inputs?.seed !== configuration.seedRef ||
        request.inputs?.applicationArchive !== configuration.archiveRef ||
        request.repetitions !== 1 ||
        !Array.isArray(request.dimensions) ||
        request.dimensions.some((d) => !Array.isArray(d.values) || d.values.length !== 1)
      )
        throw new Error("campaign_request_configuration_mismatch");
      const allowed = new Set([
        "contractVersion",
        "runName",
        "scenarioSourceId",
        "dimensions",
        "repetitions",
        "fixedOverrides",
        "inputs",
        "databaseSetup",
        "measurementDiagnostics"
      ]);
      if (
        Object.keys(request).some((k) => !allowed.has(k)) ||
        Object.keys(request.inputs).some((k) => !["seed", "applicationArchive"].includes(k))
      )
        throw new Error("campaign_request_fields_invalid");
      if ((configuration.setup === "ORDERED") !== Boolean(request.databaseSetup?.steps?.length))
        throw new Error("campaign_setup_configuration_mismatch");
      if ((request.measurementDiagnostics?.mode ?? "summary") !== configuration.diagnostics.mode)
        throw new Error("campaign_mode_configuration_mismatch");
      const parameters = {
        ...request.fixedOverrides,
        ...Object.fromEntries(request.dimensions.map((d) => [d.name, d.values[0]]))
      };
      if (
        Object.keys(parameters).some(
          (key) => !Object.hasOwn(configuration.startupParameters, key)
        ) ||
        request.dimensions.some((d) =>
          Object.keys(d).some((key) => !["name", "values"].includes(key))
        )
      )
        throw new Error("campaign_parameter_fields_invalid");
      for (const [key, value] of Object.entries(configuration.startupParameters))
        if (parameters[key] !== value) throw new Error("campaign_startup_configuration_mismatch");
    }
    await writeJson(this.root, this.file, campaign);
    await writeJson(this.root, path.join(this.directory, "requests.json"), requests);
    await this.saveCheckpoint({
      contractVersion: "measurement-campaign-checkpoint.v1",
      campaignId: campaign.campaignId,
      batches: [],
      active: null,
      state: "DECLARED",
      updatedAtMs: Date.now()
    });
    return campaign;
  }
  async declareHypothesis(input) {
    const campaign = await this.read();
    const fields = [
      "contractVersion",
      "hypothesisId",
      "campaignRevision",
      "configurationIds",
      "supportingObservationRefs",
      "discriminatingTestRef",
      "controlRef",
      "intendedChangeRef",
      "requiredEvidenceRefs",
      "observedConditionRefs",
      "nextDecisionRule"
    ];
    if (
      input?.contractVersion !== "measurement-hypothesis-batch.v1" ||
      Object.keys(input).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(input, key)) ||
      input.campaignRevision !== campaign.revision
    )
      throw new Error("campaign_hypothesis_invalid");
    opaque(input.hypothesisId);
    for (const key of [
      "configurationIds",
      "supportingObservationRefs",
      "requiredEvidenceRefs",
      "observedConditionRefs"
    ])
      if (
        !Array.isArray(input[key]) ||
        input[key].length > 128 ||
        input[key].some((value) => typeof value !== "string" || !value || value.length > 256)
      )
        throw new Error("campaign_hypothesis_invalid");
    for (const key of [
      "discriminatingTestRef",
      "controlRef",
      "intendedChangeRef",
      "nextDecisionRule"
    ])
      if (typeof input[key] !== "string" || !input[key] || input[key].length > 1024)
        throw new Error("campaign_hypothesis_invalid");
    if (
      !input.configurationIds.length ||
      !input.supportingObservationRefs.length ||
      !input.requiredEvidenceRefs.length ||
      input.configurationIds.some(
        (id) => !campaign.configurations.some((c) => c.configurationId === id)
      )
    )
      throw new Error("campaign_hypothesis_invalid");
    await writeJson(
      this.root,
      path.join(this.directory, "hypotheses", input.hypothesisId + ".json"),
      { ...input, recordedAtMs: Date.now() }
    );
    return { hypothesisId: input.hypothesisId, state: "DECLARED" };
  }
  async hypothesis(id) {
    return readJson(path.join(this.directory, "hypotheses", opaque(id) + ".json"), 65536);
  }
  async checkpoint() {
    try {
      return await readJson(path.join(this.directory, "checkpoint.json"));
    } catch (e) {
      if (e.code === "ENOENT") return { batches: [], active: null, state: "DECLARED" };
      throw e;
    }
  }
  async saveCheckpoint(checkpoint) {
    const next = { ...checkpoint, updatedAtMs: Date.now() };
    let previous;
    try {
      previous = await readJson(path.join(this.directory, "checkpoint.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const stable = (value) => JSON.stringify({ ...value, updatedAtMs: undefined });
    if (!previous || stable(previous) !== stable(next)) {
      const eventId = randomUUID();
      await writeJson(this.root, path.join(this.directory, "transitions", `${eventId}.json`), {
        contractVersion: "measurement-campaign-transition.v1",
        eventId,
        recordedAtMs: next.updatedAtMs,
        fromState: previous?.state ?? "DRAFT",
        toState: next.state,
        fromStage: previous?.active?.stage ?? null,
        toStage: next.active?.stage ?? null,
        reasonCode: next.blockedReason ?? next.active?.reasonCode ?? "checkpoint_progress",
        links: {
          configurationId: next.active?.configurationId ?? null,
          previewId: next.active?.previewId ?? null,
          submitKey: next.active?.submitKey ?? null,
          startKey: next.active?.startKey ?? null,
          runIds: next.active?.runIds ?? []
        }
      });
    }
    await writeJson(this.root, path.join(this.directory, "checkpoint.json"), next, true);
  }
  async read() {
    const declaration = await readJson(this.file),
      checkpoint = await this.checkpoint();
    let names = [];
    try {
      names = await fs.readdir(path.join(this.directory, "attempts"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (names.length > 4096) throw new Error("campaign_attempt_limit");
    const attempts = [];
    for (const name of names.sort()) {
      if (!/^\d{5}-[a-f0-9-]{36}\.json$/.test(name))
        throw new Error("campaign_attempt_file_invalid");
      attempts.push(await readJson(path.join(this.directory, "attempts", name), 65536));
    }
    return this.validate({
      ...declaration,
      state: checkpoint.state ?? declaration.state,
      attempts,
      updatedAtMs: Math.max(declaration.updatedAtMs, checkpoint.updatedAtMs ?? 0)
    });
  }
  async request(configuration) {
    return structuredClone(
      (await readJson(path.join(this.directory, "requests.json")))[configuration]
    );
  }
  async appendAttempt(attempt) {
    const before = await this.read();
    if (before.attempts.some((a) => a.attemptId === attempt.attemptId))
      throw new Error("campaign_attempt_immutable");
    this.validate({ ...before, attempts: [...before.attempts, attempt] });
    await writeJson(
      this.root,
      path.join(
        this.directory,
        "attempts",
        `${String(before.attempts.length).padStart(5, "0")}-${opaque(attempt.attemptId)}.json`
      ),
      attempt
    );
  }
}
export class CampaignClient {
  constructor(baseUrl = "http://127.0.0.1:13002") {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("campaign_base_url_invalid");
    this.baseUrl = url.origin;
  }
  async request(method, route, body, key, format = "json") {
    const response = await fetch(this.baseUrl + route, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 ** 2) throw new Error("campaign_response_limit");
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString();
    if (!response.ok) {
      let reason = "";
      try {
        const error = JSON.parse(content).error;
        reason = [error?.code, error?.message]
          .filter((value) => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value))
          .join(":");
      } catch {
        /* Arbitrary response bodies and exception messages are not retained. */
      }
      throw new Error(`campaign_http_${response.status}${reason ? ":" + reason : ""}`);
    }
    return format === "text" ? content : JSON.parse(content);
  }
  get(route) {
    return this.request("GET", route);
  }
  post(route, body, key) {
    return this.request("POST", route, body, key);
  }
  text(route) {
    return this.request("GET", route, undefined, undefined, "text");
  }
}
function owned(checkpoint) {
  const batches = [
    ...(checkpoint.batches ?? []),
    ...(checkpoint.active ? [checkpoint.active] : [])
  ];
  return {
    runs: new Set(batches.flatMap((b) => b.runIds ?? [])),
    experiments: new Set(batches.map((b) => b.experimentId).filter(Boolean))
  };
}
async function queueGuard(store, client) {
  const checkpoint = await store.checkpoint(),
    queue = await client.get("/api/v1/queue"),
    known = owned(checkpoint);
  if (
    queue.hasMore ||
    queue.items?.some((run) => !known.runs.has(run.id)) ||
    (queue.activeExperiment && !known.experiments.has(queue.activeExperiment))
  ) {
    checkpoint.state = "BLOCKED";
    checkpoint.blockedReason = "unrelated_queue_work";
    if (checkpoint.active)
      checkpoint.active.exposureReasonCodes = [
        ...new Set([...(checkpoint.active.exposureReasonCodes ?? []), "unrelated_queue_work"])
      ];
    await store.saveCheckpoint(checkpoint);
    throw new Error("campaign_unrelated_queue_work");
  }
  if (queue.items?.some((run) => known.runs.has(run.id) && run.queueState === "BLOCKED")) {
    checkpoint.state = "BLOCKED";
    checkpoint.blockedReason = "owned_queue_preflight_blocked";
    await store.saveCheckpoint(checkpoint);
    throw new Error("campaign_owned_queue_preflight_blocked");
  }
  return queue;
}

export async function resumeCampaign(store, client) {
  const checkpoint = await store.checkpoint(),
    active = checkpoint.active;
  if (!active) return checkpoint;
  if (!active.runIds?.length && active.previewId) {
    const result = await client.get("/api/v1/experiments"),
      matches = (result.experiments ?? result.items ?? []).filter(
        (e) => e.previewId === active.previewId
      );
    if (matches.length > 1) throw new Error("campaign_submission_identity_ambiguous");
    if (matches.length === 1) {
      active.experimentId = matches[0].id;
      active.runIds = matches[0].runs.map((r) => r.id);
      active.stage = "SUBMITTED";
      await store.saveCheckpoint(checkpoint);
    }
  }
  if (active.runIds?.length) {
    const observations = [];
    for (const runId of active.runIds) {
      const detail = await client.get(`/api/v1/history/runs/${encodeURIComponent(runId)}`);
      const run = detail.run ?? detail;
      observations.push({
        runId,
        state: run.state,
        measurementValidity: run.measurementValidity,
        cleanupStatus: run.cleanupStatus
      });
    }
    active.observations = observations;
    if (observations.every((r) => terminal.has(r.state))) {
      const queue = await client.get("/api/v1/queue");
      active.stage = queue.activeExperiment === active.experimentId ? "DRAINING" : "TERMINAL";
    }
    await store.saveCheckpoint(checkpoint);
  }
  return checkpoint;
}
export async function runCampaign(store, client, options) {
  const campaign = await store.read(),
    configuration = campaign.configurations.find(
      (c) => c.configurationId === options.configuration
    ),
    count = options.count ?? 1;
  if (!configuration || !Number.isSafeInteger(count) || count < 1 || count > 128)
    throw new Error("campaign_batch_configuration_invalid");
  const origin = options.origin ?? "LIVE";
  if (!["LIVE", "FIXTURE", "CONTROL", "FAULT"].includes(origin))
    throw new Error("campaign_origin_invalid");
  if (campaign.mode === "INVESTIGATE" && origin !== "FIXTURE") {
    if (!options.hypothesisRef || !options.intendedChangeRef)
      throw new Error("campaign_hypothesis_declaration_required");
    const hypothesis = await store.hypothesis(options.hypothesisRef);
    if (
      hypothesis.campaignRevision !== campaign.revision ||
      !hypothesis.configurationIds.includes(configuration.configurationId) ||
      hypothesis.intendedChangeRef !== options.intendedChangeRef
    )
      throw new Error("campaign_hypothesis_configuration_mismatch");
  }
  if (campaign.state === "DRAFT" || campaign.state === "PASSED")
    throw new Error("campaign_not_declared");
  let checkpoint = await resumeCampaign(store, client);
  if (checkpoint.active?.stage === "TERMINAL") {
    checkpoint.batches.push(checkpoint.active);
    checkpoint.active = null;
    await store.saveCheckpoint(checkpoint);
  }
  if (!checkpoint.active) {
    await queueGuard(store, client);
    const batchId = randomUUID();
    checkpoint.active = {
      batchId,
      configurationId: configuration.configurationId,
      count,
      stage: "PREVIEW_PENDING",
      previewKey: `preview-${batchId}`,
      submitKey: `submit-${batchId}`,
      startKey: `start-${batchId}`,
      runIds: [],
      origin: options.origin ?? "LIVE",
      hypothesisRef: options.hypothesisRef ?? null,
      intendedChangeRef: options.intendedChangeRef ?? null
    };
    checkpoint.state = "RUNNING";
    await store.saveCheckpoint(checkpoint);
  }
  const active = checkpoint.active;
  if (active.configurationId !== configuration.configurationId || active.count !== count)
    throw new Error("campaign_pending_batch_mismatch");
  if (!active.previewId) {
    const request = await store.request(configuration.configurationId);
    request.repetitions = count;
    request.runName = campaignRunName(
      campaign.campaignId,
      configuration.configurationId,
      checkpoint.batches.length + 1
    );
    const preview = await client.post("/api/v1/experiments/preview", request, active.previewKey);
    if (preview.cellCount !== 1 || preview.runCount !== count)
      throw new Error("campaign_preview_configuration_mismatch");
    active.previewId = preview.previewId;
    active.stage = "REVIEW_PENDING";
    await store.saveCheckpoint(checkpoint);
  }
  if (
    ["REVIEW_PENDING", "REVIEWED", "SUBMIT_PENDING"].includes(active.stage) &&
    !active.runIds.length
  ) {
    let page = await client.get(
        `/api/v1/experiments/previews/${encodeURIComponent(active.previewId)}/cells`
      ),
      reviewed = 0;
    const tokens = new Set(),
      identities = new Set();
    while (true) {
      if (page.previewId !== active.previewId || page.cellCount !== 1 || page.runCount !== count)
        throw new Error("campaign_preview_configuration_mismatch");
      for (const cell of page.cells.items) {
        const identity = `${cell.ordinal}:${cell.repetition}`;
        if (
          identities.has(identity) ||
          !Number.isSafeInteger(cell.repetition) ||
          cell.repetition < 1 ||
          cell.repetition > count
        )
          throw new Error("campaign_preview_duplicate_or_invalid_cell");
        identities.add(identity);
        for (const [name, value] of Object.entries(configuration.startupParameters))
          if (cell.effectiveConfiguration?.[name] !== value)
            throw new Error("campaign_preview_parameters_mismatch");
        if (
          (cell.measurementDiagnostics?.mode ?? "summary") !== configuration.diagnostics.mode ||
          Boolean(cell.databaseSetup?.steps?.length) !== (configuration.setup === "ORDERED")
        )
          throw new Error("campaign_preview_configuration_mismatch");
        reviewed++;
      }
      if (!page.cells.hasMore) break;
      const token = page.cells.nextPageToken;
      if (!token || tokens.has(token)) throw new Error("campaign_preview_pagination_invalid");
      tokens.add(token);
      page = await client.get(
        `/api/v1/experiments/previews/${encodeURIComponent(active.previewId)}/cells?${new URLSearchParams({ pageToken: token })}`
      );
    }
    if (reviewed !== count) throw new Error("campaign_preview_review_incomplete");
    active.stage = "REVIEWED";
    await store.saveCheckpoint(checkpoint);
  }
  if (!active.runIds.length) {
    await queueGuard(store, client);
    active.stage = "SUBMIT_PENDING";
    await store.saveCheckpoint(checkpoint);
    const submitted = await client.post(
      "/api/v1/experiments/submit",
      { previewId: active.previewId, confirm: true },
      active.submitKey
    );
    if (!submitted.id || submitted.runs?.length !== count)
      throw new Error("campaign_submission_result_invalid");
    active.experimentId = submitted.id;
    active.runIds = submitted.runs.map((r) => r.id);
    active.stage = "SUBMITTED";
    await store.saveCheckpoint(checkpoint);
  }
  if (["SUBMITTED", "START_PENDING"].includes(active.stage)) {
    await queueGuard(store, client);
    active.stage = "START_PENDING";
    await store.saveCheckpoint(checkpoint);
    await client.post("/api/v1/queue/start", {}, active.startKey);
    active.stage = "STARTED";
    await store.saveCheckpoint(checkpoint);
  }
  if (options.wait === false) return checkpoint;
  while (true) {
    await queueGuard(store, client);
    checkpoint = await resumeCampaign(store, client);
    if (checkpoint.active.stage === "TERMINAL") return checkpoint;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(250, Math.min(5000, options.pollMs ?? 2000)))
    );
  }
}
export async function cancelCampaignRun(store, client, runId) {
  const checkpoint = await store.checkpoint();
  if (!owned(checkpoint).runs.has(runId)) throw new Error("campaign_cancel_run_not_owned");
  const key = checkpoint.cancelKeys?.[runId] ?? `cancel-${randomUUID()}`;
  checkpoint.cancelKeys = { ...checkpoint.cancelKeys, [runId]: key };
  await store.saveCheckpoint(checkpoint);
  return client.post(`/api/v1/queue/runs/${encodeURIComponent(runId)}/cancel`, {}, key);
}
export async function assessEvidence({
  campaign,
  run,
  diagnostics,
  sourceAudit,
  summaryAudit,
  charts,
  configuration,
  origin = "LIVE"
}) {
  const reasonCodes = [];
  if (run.state !== "SUCCEEDED") reasonCodes.push("run_not_succeeded");
  if (run.measurementValidity !== "VALID") reasonCodes.push("measurement_not_valid");
  if (run.cleanupStatus !== "COMPLETE") reasonCodes.push("cleanup_not_complete");
  if (
    diagnostics?.recordingState !== "SEALED" ||
    diagnostics.inventoryIncomplete ||
    diagnostics.findingsIncomplete ||
    diagnostics.droppedEvents ||
    diagnostics.writeFailures ||
    !diagnostics.producers?.length ||
    ["controller", "metadata", "db-observer", "file-sampler", "pas-observer"].some(
      (component) => !diagnostics.producers?.some((p) => p.component === component)
    ) ||
    diagnostics.producers.some(
      (p) =>
        p.collectionStatus !== "COMPLETE" ||
        p.flushState !== "COMPLETE" ||
        p.budgetAccountingState !== "CONFIRMED" ||
        p.droppedMetadataRecords ||
        p.droppedEvents ||
        p.writeFailures ||
        p.unconfirmedEvents
    )
  )
    reasonCodes.push("diagnostics_incomplete");
  if (!sourceAudit) reasonCodes.push("source_audit_missing");
  if (!summaryAudit) reasonCodes.push("summary_audit_missing");
  if (!charts?.length) reasonCodes.push("rendered_chart_evidence_missing");
  if (campaign.mode === "INVESTIGATE") reasonCodes.push("investigation_requires_findings_review");
  if (origin !== "LIVE") reasonCodes.push("not_fresh_live_confirmation");
  if (campaign.mode === "CONFIRM") {
    if (!configuration) reasonCodes.push("configuration_missing");
    else {
      const snapshot = run.environmentSnapshot ?? {},
        scenario = snapshot.scenario ?? {};
      const load = scenario.workload?.load;
      if (
        JSON.stringify(scenario.phases) !== JSON.stringify(configuration.phases) ||
        (load?.concurrency ?? load?.["constant-concurrency"]) !== configuration.concurrency ||
        Object.entries(configuration.startupParameters).some(
          ([k, v]) => snapshot.effectiveConfiguration?.[k] !== v
        ) ||
        snapshot.inputs?.seedName !== configuration.seedRef.split("/").at(-1)
      )
        reasonCodes.push("frozen_configuration_mismatch");
      for (const [name, image] of Object.entries(configuration.deployedRefs)) {
        const roles =
          name === "native-observer"
            ? ["db-observer"]
            : name === "generic-observer"
              ? ["file-sampler", "pas-observer"]
              : name === "pas"
                ? ["pas-1"]
                : [name];
        if (roles.some((role) => diagnostics?.deployedRefs?.[role] !== image))
          reasonCodes.push("deployed_build_mismatch");
      }
      if (
        diagnostics?.config?.mode !== configuration.diagnostics.mode ||
        [
          "summaryLimitBytes",
          "traceLimitBytes",
          "pendingLimitBytes",
          "eventLimitBytes",
          "flushIntervalMs"
        ].some((key) => diagnostics?.config?.[key] !== configuration.diagnostics[key])
      )
        reasonCodes.push("diagnostic_settings_mismatch");
      const setup = snapshot.databaseSetupEvidence;
      if (configuration.setup === "ORDERED" && (!setup || setup.state !== "SUCCEEDED"))
        reasonCodes.push("setup_proof_missing");
      if (configuration.setup === "NONE" && snapshot.databaseSetup?.steps?.length)
        reasonCodes.push("unexpected_setup");
      const cadences = snapshot.sourceCadences;
      if (
        cadences?.prometheusScrapeSeconds * 1000 !==
          (configuration.cadencesMs.scrape ?? configuration.cadencesMs.core) ||
        cadences?.nativeDatabaseRefreshSeconds * 1000 !==
          (configuration.cadencesMs.native ?? configuration.cadencesMs["openedge-db"]) ||
        Object.entries(configuration.cadencesMs).some(
          ([key, value]) =>
            !["native", "scrape"].includes(key) &&
            !cadences?.observers?.some((o) => o.id === key && o.stepSeconds * 1000 === value)
        )
      )
        reasonCodes.push("source_cadence_mismatch");
      for (const [phase, seconds] of [
        ["warmup", configuration.phases.warmupSeconds],
        ["measurement", configuration.phases.measurementSeconds],
        ["cooldown", configuration.phases.cooldownSeconds]
      ]) {
        const boundary = run.phaseBoundaries?.[phase];
        if (
          !boundary ||
          Math.abs(
            Date.parse(boundary.finishedAt) - Date.parse(boundary.startedAt) - seconds * 1000
          ) > 1
        )
          reasonCodes.push("phase_window_mismatch");
      }
      if (
        run.completeness?.complete !== true ||
        !Array.isArray(run.completeness?.requiredGaps) ||
        run.completeness.requiredGaps.length
      )
        reasonCodes.push("required_quality_unproven");
    }
    const startMs = Date.parse(run.phaseBoundaries?.measurement?.startedAt),
      endMs = Date.parse(run.phaseBoundaries?.measurement?.finishedAt);
    const owner = (proof, version) =>
      proof?.contractVersion === version &&
      proof.runId === run.id &&
      proof.startMs === startMs &&
      proof.endMs === endMs;
    if (
      !owner(sourceAudit, "measurement-source-audit.v1") ||
      sourceAudit.revision !== campaign.revision ||
      !sourceAudit.inventoryEvidenceRef ||
      !sourceAudit.inventoryCount ||
      sourceAudit.assessedCount !== sourceAudit.inventoryCount ||
      sourceAudit.gapCount !== 0 ||
      sourceAudit.identities?.length !== sourceAudit.inventoryCount ||
      sourceAudit.identities.some((i) => !nativeIdentityCovered(i))
    )
      reasonCodes.push("source_coverage_unproven");
    if (
      !owner(summaryAudit, "measurement-summary-audit.v1") ||
      !summaryAudit.savedDigest ||
      !summaryAudit.savedRowCount ||
      summaryAudit.assessedRowCount !== summaryAudit.savedRowCount ||
      [
        "mismatches",
        "unassessedRows",
        "unsupportedGaps",
        "missingMembers",
        "membershipMismatches"
      ].some((key) => !Array.isArray(summaryAudit[key]) || summaryAudit[key].length)
    )
      reasonCodes.push("summary_reconciliation_unproven");
    const comparison = summaryAudit?.comparison;
    if (
      !comparison?.comparisonId ||
      !comparison.csvDigest ||
      comparison.comparisonRowCount !== summaryAudit?.savedRowCount ||
      comparison.csvRowCount !== summaryAudit?.savedRowCount ||
      !Array.isArray(comparison.comparisonMismatches) ||
      comparison.comparisonMismatches.length ||
      !Array.isArray(comparison.csvMismatches) ||
      comparison.csvMismatches.length
    )
      reasonCodes.push("comparison_csv_unproven");
    const required = sourceAudit?.requiredPanels;
    if (!required?.length) reasonCodes.push("affected_panel_inventory_missing");
    for (const panel of required ?? []) {
      const chart = charts?.find(
        (c) => c.dashboardUid === panel.dashboardUid && c.panelId === panel.panelId
      );
      try {
        validateChartCapture(chart, {
          ...panel,
          runId: run.id,
          phase: "measurement",
          startMs,
          endMs,
          timezone: "UTC",
          origin: "LIVE"
        });
        if (!panel.queries?.length || chart.queries.length !== panel.queries.length)
          throw new Error("declared_chart_queries_missing");
        for (const query of chart.queries) {
          const declared = panel.queries.find((q) => q.refId === query.refId);
          if (
            !declared ||
            declared.datasourceUid !== query.datasourceUid ||
            declared.templateDigest !== query.templateDigest
          )
            throw new Error("chart_query_template_changed");
          if (
            query.sourceMetadata?.contractVersion !== "measurement-chart-query.v1" ||
            query.sourceMetadata.incomplete !== false ||
            !(declared.sourceScope === "GLOBAL_PLATFORM"
              ? globalPlatformContextMatches(query, panel, { runId: run.id, startMs, endMs }) &&
                globalQueryAvailabilityMatches(
                  query,
                  declared,
                  sourceAudit.globalAvailability,
                  diagnostics,
                  run.id
                )
              : declared.sourceScope === "RUN" &&
                query.datasourceUid === "parkbench-runs" &&
                query.sourceMetadata.runIds?.length === 1 &&
                query.sourceMetadata.runIds[0] === run.id)
          )
            throw new Error("source_query_receipt_missing");
        }
      } catch {
        reasonCodes.push("affected_panel_proof_missing");
      }
    }
  }
  return {
    assessment: reasonCodes.some((r) =>
      ["run_not_succeeded", "measurement_not_valid", "cleanup_not_complete"].includes(r)
    )
      ? "REJECTED"
      : reasonCodes.length
        ? "INCONCLUSIVE"
        : "ACCEPTED",
    reasonCodes: [...new Set(reasonCodes)]
  };
}
export async function chartEvidence(store, runId, window, requestedRefs) {
  const charts = [],
    refs = [],
    failures = [],
    superseded = [],
    entries = [];
  const verifyImages = async (capture) => {
    for (const screenshot of [capture.screenshot, capture.inspectorScreenshot]) {
      const relative = path.relative(store.root, path.resolve(screenshot));
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("campaign_chart_path_invalid");
      const stat = await fs.lstat(screenshot);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 8 * 1024 ** 2)
        throw new Error("campaign_chart_screenshot_missing");
      if ((await fs.realpath(screenshot)) !== path.resolve(screenshot))
        throw new Error("campaign_symlink_refused");
      validateScreenshotPng(await fs.readFile(screenshot));
    }
  };
  let names = [];
  try {
    names = await fs.readdir(path.join(store.root, "charts"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (names.length > 4096) throw new Error("campaign_chart_limit");
  for (const name of names) {
    if (!name.startsWith(`chart-${runId}-`)) continue;
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(name)) throw new Error("campaign_chart_identity_invalid");
    const file = path.join(store.root, "charts", name, "capture.json");
    let capture;
    try {
      capture = await readJson(file, 1024 ** 2);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const failure = path.join(store.root, "charts", name, "failure.json");
      const record = await readJson(failure, 16384);
      if (record.runId !== runId || record.complete !== false)
        throw new Error("campaign_chart_failure_invalid");
      failures.push(path.relative(store.root, failure));
      continue;
    }
    if (capture.runId !== runId) throw new Error("campaign_chart_owner_invalid");
    const ref = path.relative(store.root, file);
    if (requestedRefs && !requestedRefs.includes(ref)) {
      superseded.push(ref);
      continue;
    }
    if (capture.complete !== true) {
      failures.push(ref);
      continue;
    }
    if (
      window &&
      (capture.startMs !== Date.parse(window.startedAt) ||
        capture.endMs !== Date.parse(window.finishedAt) ||
        capture.phase !== "measurement" ||
        capture.timezone !== "UTC" ||
        capture.origin !== "LIVE")
    ) {
      superseded.push(ref);
      continue;
    }
    if (!Number.isSafeInteger(capture.recordedAtMs))
      throw new Error("campaign_chart_timestamp_invalid");
    entries.push({ capture, ref });
  }
  const selected = new Set();
  for (const entry of entries.sort((a, b) => b.capture.recordedAtMs - a.capture.recordedAtMs)) {
    const key = `${entry.capture.dashboardUid}:${entry.capture.panelId}`;
    if (selected.has(key)) {
      superseded.push(entry.ref);
      continue;
    }
    await verifyImages(entry.capture);
    selected.add(key);
    charts.push(entry.capture);
    refs.push(entry.ref);
  }
  return { charts, refs, failures, superseded };
}
export async function assessCampaign(store, client) {
  await resumeCampaign(store, client);
  const checkpoint = await store.checkpoint(),
    campaign = await store.read();
  const batches = [
    ...(checkpoint.batches ?? []),
    ...(checkpoint.active ? [checkpoint.active] : [])
  ];
  const results = [];
  checkpoint.state = "ASSESSING";
  await store.saveCheckpoint(checkpoint);
  for (const batch of batches)
    for (const runId of batch.runIds ?? []) {
      if (campaign.attempts.some((attempt) => attempt.runId === runId)) continue;
      const detail = await client.get(`/api/v1/history/runs/${encodeURIComponent(runId)}`),
        run = detail.run ?? detail;
      if (!terminal.has(run.state)) continue;
      const artifactListing = await client.get(
        `/api/v1/runs/${encodeURIComponent(runId)}/artifacts`
      );
      const artifacts = artifactListing.artifacts ?? [],
        manifestReceipt =
          artifacts.find(
            (a) =>
              a.id === run.environmentSnapshot?.measurementDiagnosticsEvidence?.manifestArtifactId
          ) ??
          artifacts
            .filter((a) => a.sourceMetadata?.role === "manifest")
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      let diagnostics,
        findingCount = 0,
        unresolvedFindings = 0,
        diagnosticError = false;
      if (manifestReceipt) {
        try {
          diagnostics = store.validate(
            await client.get(
              `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(manifestReceipt.id)}`
            )
          );
          if (diagnostics.runId !== runId) throw new Error("campaign_diagnostic_owner_invalid");
          for (const reference of diagnostics.findingPages) {
            const receipt = artifacts.find(
              (a) =>
                a.id === reference &&
                a.sourceMetadata?.attemptId === diagnostics.diagnosticAttemptId &&
                a.sourceMetadata?.role === "findings"
            );
            if (!receipt) throw new Error("campaign_finding_evidence_missing");
            const records = await client.get(
              `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(receipt.id)}`
            );
            if (!Array.isArray(records)) throw new Error("campaign_finding_evidence_invalid");
            for (const envelope of records) {
              const finding = store.validate(envelope.record);
              if (finding.runId !== runId) throw new Error("campaign_finding_owner_invalid");
              findingCount++;
              if (
                finding.classification === "UNRESOLVED" ||
                (finding.classification === "DEFECT" && finding.state !== "CONFIRMED")
              )
                unresolvedFindings++;
            }
          }
        } catch {
          diagnosticError = true;
        }
      }
      const attemptId = randomUUID();
      let sourceAudit,
        summaryAudit,
        chartRecords = { charts: [], refs: [] },
        auditError;
      const sourceAuditRefs = [],
        summaryAuditRefs = [];
      if (campaign.mode === "CONFIRM" && diagnostics && !diagnosticError) {
        try {
          const configuration = campaign.configurations.find(
            (c) => c.configurationId === batch.configurationId
          );
          chartRecords = await chartEvidence(store, runId, run.phaseBoundaries?.measurement);
          const availabilityRef = `confirmation-kernel-${runId}.jsonl`;
          let availabilityEvidence;
          try {
            await fs.access(path.join(store.root, availabilityRef));
            availabilityEvidence = { root: store.root, reference: availabilityRef };
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          ({ sourceAudit, summaryAudit } = await auditRunMeasurements({
            client,
            run,
            diagnostics,
            configuration: { ...configuration, revision: campaign.revision },
            charts: chartRecords.charts,
            availabilityEvidence
          }));
          for (const [role, value, refs] of [
            ["source", sourceAudit, sourceAuditRefs],
            ["summary", summaryAudit, summaryAuditRefs]
          ]) {
            const file = path.join(store.directory, "assessments", `${attemptId}-${role}.json`);
            await writeJson(store.root, file, value);
            refs.push(path.relative(store.root, file));
          }
        } catch (error) {
          auditError = /^acceptance_[a-z_]+$/.test(error.message)
            ? error.message
            : "independent_audit_unavailable";
        }
      }
      const assessment = await assessEvidence({
        campaign,
        run,
        diagnostics,
        sourceAudit,
        summaryAudit,
        charts: chartRecords.charts,
        configuration: campaign.configurations.find(
          (c) => c.configurationId === batch.configurationId
        ),
        origin: batch.origin ?? "LIVE"
      });
      if (diagnosticError) assessment.reasonCodes.push("diagnostic_evidence_unavailable");
      if (unresolvedFindings) assessment.reasonCodes.push("unresolved_findings");
      if (auditError) assessment.reasonCodes.push(auditError);
      assessment.reasonCodes.push(...(batch.exposureReasonCodes ?? []));
      if (assessment.assessment === "ACCEPTED" && assessment.reasonCodes.length)
        assessment.assessment = "INCONCLUSIVE";
      const auditFile = path.join(store.directory, "assessments", `${attemptId}.json`);
      await writeJson(store.root, auditFile, {
        contractVersion: "measurement-investigation-assessment.v1",
        assessmentId: attemptId,
        runId,
        configurationId: batch.configurationId,
        revision: campaign.revision,
        recordedAtMs: Date.now(),
        assessment: assessment.assessment,
        reasonCodes: assessment.reasonCodes,
        recordingState: diagnostics?.recordingState ?? "UNAVAILABLE",
        findingCount,
        unresolvedFindings,
        manifestArtifactId: manifestReceipt?.id ?? null,
        chartFailureRefs: chartRecords.failures ?? [],
        supersededChartRefs: chartRecords.superseded ?? []
      });
      const attempt = {
        attemptId,
        configurationId: batch.configurationId,
        runId,
        revision: campaign.revision,
        recordedAtMs: Date.now(),
        origin: batch.origin ?? "LIVE",
        sequenceOrdinal:
          campaign.attempts.filter((a) => a.configurationId === batch.configurationId).length +
          results.filter((a) => a.configurationId === batch.configurationId).length,
        assessment: assessment.assessment,
        runState: run.state,
        measurementValidity: run.measurementValidity ?? "UNAVAILABLE",
        cleanupState: run.cleanupStatus ?? "UNAVAILABLE",
        diagnosticCompleteness:
          diagnostics?.recordingState === "SEALED" && !diagnosticError ? "COMPLETE" : "UNAVAILABLE",
        sourceAuditRefs,
        summaryAuditRefs,
        chartRefs: chartRecords.refs,
        findingRefs: diagnostics?.findingPages ?? [],
        reasonCodes: assessment.reasonCodes,
        previewRef: batch.previewId,
        submitKey: batch.submitKey,
        startKey: batch.startKey,
        hypothesisRef: batch.hypothesisRef ?? null,
        intendedChangeRef: batch.intendedChangeRef ?? null,
        observedConditionRefs: [path.relative(store.root, auditFile)],
        nextAction: "review findings and collect independent source/summary/chart audits"
      };
      await store.appendAttempt(attempt);
      results.push(attempt);
    }
  checkpoint.state = "NEEDS_INVESTIGATION";
  await store.saveCheckpoint(checkpoint);
  return { state: checkpoint.state, attempts: results };
}
export async function verifyCampaign(store, client = new CampaignClient(), options = {}) {
  const campaign = await store.read();
  const result = confirmationSequences(campaign);
  if (campaign.mode === "CONFIRM") {
    try {
      const deployed = await (options.inspectDeployment ?? inspectDeployment)();
      if (
        deployed.members.some((m) => m.state !== "running") ||
        campaign.configurations.some((c) =>
          Object.entries(c.deployedRefs).some(
            ([role, image]) => deployed.deployedRefs[role] !== image
          )
        )
      )
        result.reasonCodes.push("final_deployment_mismatch");
    } catch {
      result.reasonCodes.push("final_deployment_unavailable");
    }
  }
  try {
    const names = await fs.readdir(path.join(store.directory, "transitions"));
    if (!names.length || names.length > 16384) throw new Error("transition_count");
    const transitions = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("transition_file");
      const event = await readJson(path.join(store.directory, "transitions", name), 16384);
      if (
        event.contractVersion !== "measurement-campaign-transition.v1" ||
        !Number.isSafeInteger(event.recordedAtMs) ||
        event.recordedAtMs < campaign.createdAtMs ||
        typeof event.reasonCode !== "string" ||
        !event.reasonCode ||
        !event.links ||
        !Array.isArray(event.links.runIds)
      )
        throw new Error("transition_proof");
      transitions.push(event);
    }
    for (const attempt of campaign.attempts) {
      const linked = transitions.filter((e) => e.links.runIds.includes(attempt.runId));
      if (
        [attempt.previewRef, attempt.submitKey, attempt.startKey].some(
          (id) => typeof id !== "string" || !id
        )
      )
        throw new Error("transition_lineage");
      const stageTimes = ["SUBMITTED", "START_PENDING", "STARTED", "TERMINAL"].map((stage) =>
        Math.min(
          ...linked
            .filter(
              (e) =>
                e.toStage === stage &&
                e.links.previewId === attempt.previewRef &&
                e.links.submitKey === attempt.submitKey &&
                e.links.startKey === attempt.startKey
            )
            .map((e) => e.recordedAtMs)
        )
      );
      if (
        stageTimes.some((time, i) => !Number.isFinite(time) || (i > 0 && time < stageTimes[i - 1]))
      )
        throw new Error("transition_lineage");
      if (
        attempt.assessment === "ACCEPTED" &&
        linked.some((e) => e.reasonCode === "unrelated_queue_work")
      )
        throw new Error("uncontrolled_activity");
    }
  } catch {
    result.reasonCodes.push("transition_evidence_unavailable");
  }
  for (const attempt of campaign.attempts.filter((a) => a.assessment === "ACCEPTED")) {
    try {
      const configuration = campaign.configurations.find(
        (c) => c.configurationId === attempt.configurationId
      );
      const detail = await client.get(`/api/v1/history/runs/${encodeURIComponent(attempt.runId)}`),
        run = detail.run ?? detail;
      const getProof = async (ref) => {
        const file = path.resolve(store.root, ref);
        if (!file.startsWith(store.root + path.sep)) throw new Error("proof_path");
        return readJson(file);
      };
      const sourceAudit = await getProof(attempt.sourceAuditRefs[0]),
        summaryAudit = await getProof(attempt.summaryAuditRefs[0]);
      const id = run.environmentSnapshot?.measurementDiagnosticsEvidence?.manifestArtifactId;
      const diagnostics = store.validate(
        await client.get(
          `/api/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(id)}`
        )
      );
      const saved = await client.get(
        `/api/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(summaryAudit.summaryArtifactId)}`
      );
      if (digest(saved) !== summaryAudit.savedDigest) throw new Error("summary_changed");
      const { charts, refs } = await chartEvidence(
        store,
        run.id,
        run.phaseBoundaries?.measurement,
        attempt.chartRefs
      );
      if (attempt.chartRefs.some((ref) => !refs.includes(ref))) throw new Error("chart_missing");
      if (summaryAudit.sourceAvailabilityEvidenceRefs?.length) {
        if (summaryAudit.sourceAvailabilityEvidenceRefs.length !== 1)
          throw new Error("availability_proof_count");
        const renewed = await auditRunMeasurements({
          client,
          run,
          diagnostics,
          configuration: { ...configuration, revision: campaign.revision },
          charts,
          availabilityEvidence: {
            root: store.root,
            reference: summaryAudit.sourceAvailabilityEvidenceRefs[0]
          }
        });
        if (
          renewed.sourceAudit.gapCount ||
          renewed.summaryAudit.unsupportedGaps.length ||
          renewed.summaryAudit.mismatches.length ||
          digest(renewed.summaryAudit.legitimateLimitations) !==
            digest(summaryAudit.legitimateLimitations) ||
          digest(renewed.summaryAudit.sourceAvailabilityProofs) !==
            digest(summaryAudit.sourceAvailabilityProofs)
        )
          throw new Error("availability_proof_changed");
      }
      const assessment = await assessEvidence({
        campaign,
        run,
        configuration,
        diagnostics,
        sourceAudit,
        summaryAudit,
        charts,
        origin: attempt.origin
      });
      if (assessment.assessment !== "ACCEPTED") throw new Error("proof_incomplete");
    } catch {
      result.reasonCodes.push(`accepted_evidence_unavailable:${attempt.runId}`);
    }
  }
  // A sequence alone is insufficient. Later work must also supply the explicit
  // independent negative, overhead, trigger, history and causal gate receipts.
  const gates = new Set();
  for (const ref of campaign.evidenceRefs) {
    const file = path.resolve(store.root, ref);
    if (!file.startsWith(store.root + path.sep)) {
      result.reasonCodes.push("evidence_path_invalid");
      continue;
    }
    try {
      const record = await readJson(file);
      if (
        record.contractVersion !== "measurement-confirmation-gate.v1" ||
        record.revision !== campaign.revision
      )
        continue;
      if (
        record.status === "PASSED" &&
        record.evidenceRefs?.length &&
        record.checks?.length >= 2 &&
        record.checks.every(
          (c) =>
            typeof c.evidenceRef === "string" &&
            record.evidenceRefs.includes(c.evidenceRef) &&
            Array.isArray(c.path) &&
            c.path.length > 0 &&
            c.path.every(
              (key) =>
                typeof key === "string" &&
                /^[a-zA-Z0-9_-]+$/.test(key) &&
                !["__proto__", "constructor", "prototype"].includes(key)
            ) &&
            Object.hasOwn(c, "expected") &&
            !Object.hasOwn(c, "observed")
        )
      ) {
        const evidence = new Map();
        for (const evidenceRef of record.evidenceRefs) {
          const evidenceFile = path.resolve(store.root, evidenceRef);
          if (!evidenceFile.startsWith(store.root + path.sep)) throw new Error("gate_path");
          evidence.set(evidenceRef, await readJson(evidenceFile));
        }
        if (
          record.checks.every((check) => {
            let observed = evidence.get(check.evidenceRef);
            for (const key of check.path) {
              if (!Object.hasOwn(observed ?? {}, key)) return false;
              observed = observed[key];
            }
            return digest(observed) === digest(check.expected);
          })
        )
          gates.add(record.gate);
      }
    } catch {
      result.reasonCodes.push("gate_evidence_unavailable");
    }
  }
  for (const gate of [
    "causal",
    "negative",
    "overhead",
    "targeted",
    "history",
    "cleanup",
    "privacy-retention"
  ])
    if (!gates.has(gate)) result.reasonCodes.push(`gate_missing:${gate}`);
  result.passed = result.reasonCodes.length === 0;
  if (result.passed) {
    store.validate({ ...campaign, state: "PASSED" });
    const checkpoint = await store.checkpoint();
    checkpoint.state = "PASSED";
    await store.saveCheckpoint(checkpoint);
  }
  return { ...result, state: result.passed ? "PASSED" : campaign.state };
}
export async function inspectDeployment() {
  const execute = promisify(execFile);
  const listing = await execute(
    "docker",
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      "label=com.docker.compose.project=parkbench-platform",
      "--format",
      "{{.ID}}"
    ],
    { timeout: 10000, maxBuffer: 65536 }
  );
  const ids = listing.stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.length || ids.length > 128 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
    throw new Error("campaign_deployment_inventory_unavailable");
  const inspected = await execute(
    "docker",
    [
      "inspect",
      "--format",
      '[{{json .Id}},{{json .Image}},{{json .State.Status}},{{json (index .Config.Labels "com.docker.compose.service")}},{{json .Created}}]',
      ...ids
    ],
    { timeout: 10000, maxBuffer: 131072 }
  );
  const members = inspected.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [id, imageId, state, service, createdAt] = JSON.parse(line);
      return { id, imageId, state, service, createdAt };
    });
  const componentImages = {
    "native-observer": "parkbench/openedge-observer:dev",
    "generic-observer": "parkbench/observer:dev",
    database: "parkbench/openedge-db:dev",
    pas: "parkbench/openedge-pasoe:dev"
  };
  const components = await execute(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", ...Object.values(componentImages)],
    { timeout: 10000, maxBuffer: 65536 }
  );
  const imageIds = components.stdout.trim().split(/\r?\n/);
  if (imageIds.length !== 4 || imageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)))
    throw new Error("campaign_component_inventory_unavailable");
  return {
    recordedAtMs: Date.now(),
    members,
    deployedRefs: {
      ...Object.fromEntries(members.map((member) => [member.service, member.imageId])),
      ...Object.fromEntries(Object.keys(componentImages).map((role, i) => [role, imageIds[i]]))
    }
  };
}
export function databaseParameterNames(options) {
  const parameters = Array.isArray(options.databaseParameters)
    ? options.databaseParameters
    : (options.databaseParameters?.parameters ?? []);
  return parameters
    .map((parameter) => parameter.canonicalName ?? parameter.name)
    .filter((name) => typeof name === "string" && name.length <= 128);
}
export async function inventory(store, client) {
  const [options, queue, discovery, deployment] = await Promise.all([
    client.get("/api/v1/ui-options"),
    client.get("/api/v1/queue"),
    client.get("/api/v1/catalog/discovery"),
    inspectDeployment()
  ]);
  const assets = [],
    tokens = new Set();
  let token;
  for (const category of [undefined, "scenarios"]) {
    token = undefined;
    tokens.clear();
    do {
      const page = await client.get(
        "/api/v1/catalog/assets?" +
          new URLSearchParams({
            pageSize: "250",
            ...(category ? { category } : {}),
            ...(token ? { pageToken: token } : {})
          })
      );
      for (const asset of page.items ?? [])
        assets.push(
          Object.fromEntries(
            [
              "id",
              "category",
              "kind",
              "relativePath",
              "displayName",
              "sourceStatus",
              "declaredScenarioId",
              "declaredScenarioVersion"
            ]
              .filter((key) => asset[key] !== undefined)
              .map((key) => [key, asset[key]])
          )
        );
      if (assets.length > 10000) throw new Error("campaign_inventory_limit");
      token = page.hasMore ? page.nextPageToken : undefined;
      if (page.hasMore && (!token || tokens.has(token)))
        throw new Error("campaign_inventory_pagination_invalid");
      if (token) tokens.add(token);
    } while (token);
  }
  const scenarios = [];
  for (const asset of assets.filter(
    (asset) =>
      asset.category === "scenarios" &&
      ["parkbench-read-mix", "parkbench-read-write-80-20"].includes(asset.declaredScenarioId)
  )) {
    const result = await client.get(
        `/api/v1/scenarios/${encodeURIComponent(asset.declaredScenarioId)}/${encodeURIComponent(asset.declaredScenarioVersion)}`
      ),
      scenario = result.document;
    if (!scenario?.phases || !scenario.workload?.load)
      throw new Error("campaign_scenario_inventory_unavailable");
    scenarios.push({
      scenarioSourceId: asset.id,
      scenarioId: scenario.id,
      version: scenario.version,
      phases: scenario.phases,
      concurrency: scenario.workload.load.concurrency,
      observers: scenario.observers.map((observer) => ({
        id: observer.id,
        kind: observer.kind,
        required: observer.required,
        samplingIntervalSeconds: observer.samplingIntervalSeconds
      }))
    });
  }
  const snapshot = {
    contractVersion: "measurement-campaign-inventory.v1",
    recordedAtMs: Date.now(),
    queue: {
      activeExperiment: queue.activeExperiment ?? null,
      runIds: (queue.items ?? []).map((run) => run.id)
    },
    deployment,
    assets,
    scenarios,
    candidateConfigurations: scenarios.flatMap((scenario) =>
      ["NONE", "ORDERED"].map((setup) => ({
        ...scenario,
        configurationId: `${scenario.scenarioId === "parkbench-read-mix" ? "read" : "mixed"}-${setup === "NONE" ? "no-setup" : "setup"}`,
        workloadClass: scenario.scenarioId === "parkbench-read-mix" ? "READ_ONLY" : "MIXED",
        setup,
        setupRef: setup === "NONE" ? null : "idxbuild-all",
        startupParametersState: "EXPLICIT_CAPACITY_REVIEW_REQUIRED",
        inputSelectionState: "SELECT_VALIDATED_SEED_AND_ARCHIVE"
      }))
    ),
    parameterNames: databaseParameterNames(options),
    discovery: { status: discovery.status ?? "unknown", checkedAt: discovery.checkedAt ?? null }
  };
  const file = store.file.slice(0, -5) + `.inventory-${randomUUID()}.json`;
  await writeJson(store.root, file, snapshot);
  return {
    file,
    candidateCount: snapshot.candidateConfigurations.length,
    deployedRefs: deployment.deployedRefs
  };
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args,
    flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--") || rest[i + 1] === undefined)
      throw new Error("campaign_arguments_invalid");
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  if (!flags.campaign)
    throw new Error(
      "usage: measurement-campaign.mjs inventory|declare|run|resume|assess|verify|cancel --campaign PATH [--base-url URL]"
    );
  const store = await CampaignStore.open(flags.campaign),
    client = new CampaignClient(flags["base-url"]);
  if (command === "inventory") return inventory(store, client);
  if (command === "declare") {
    const input = await readJson(flags.declaration);
    return store.declare(input.campaign, input.requests);
  }
  if (command === "declare-hypothesis")
    return store.declareHypothesis(await readJson(flags.declaration));
  if (command === "run")
    return runCampaign(store, client, {
      configuration: flags.configuration,
      count: Number(flags.count ?? 1),
      origin: flags.origin ?? "LIVE",
      hypothesisRef: flags.hypothesis ?? null,
      intendedChangeRef: flags.change ?? null
    });
  if (command === "resume") return resumeCampaign(store, client);
  if (command === "cancel") return cancelCampaignRun(store, client, flags["run-id"]);
  if (command === "verify") return verifyCampaign(store, client);
  if (command === "assess") return assessCampaign(store, client);
  throw new Error("campaign_command_unknown");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (result.passed === false || result.assessment === "INCONCLUSIVE") process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(
        (/^campaign_|^usage:/.test(error.message) ? error.message : "campaign_operation_failed") +
          "\n"
      );
      process.exitCode = 1;
    });
