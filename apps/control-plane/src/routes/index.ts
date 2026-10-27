import {registerReportRoutes} from "../api/report-routes";
import { ParameterSnapshotQueries } from "../grafana/parameter-snapshots";
import { SavedSummaryQueries } from "../grafana/summary-results";
import fs from "node:fs";
import { Readable } from "node:stream";
import { resolveRequestedRunId } from "../../../../packages/metrics/src/discovery";
import { TERMINAL_STATES } from "../../../../packages/contracts/src/run-state";
import { createPlatform, Platform } from "../platform";
import { ValidationError } from "../../../../packages/contracts/src/errors";
import { validateExperimentRequest } from "../../../../packages/compose-runner/src/preflight";
import { comparison } from "../comparisons/service";
import { comparisonCsv } from "../comparisons/export";
import { buildLiveRunHealth, dependencyHealth, liveRunHealth } from "../health";
import { requestId, redactSecrets } from "../../../../packages/contracts/src";
import { filterCAdvisorMetrics, verifyDiskIoSources } from "../../../../packages/metrics/src";
import { hostCapacity } from "../preflight/capacity";
import { checkImageReference } from "../../../../packages/compose-runner/src/input-checks";
import { registerControlUiRoutes } from "../api/control-ui-routes";
import { registerGrafanaRoutes, repositoryTimelineSource } from "../grafana";
export function registerRoutes(app: any, platform: Platform): void {
  registerReportRoutes(app,platform);
  app.get("/internal/cadvisor/metrics", async (request: any, reply: any) => {
    try {
      const response = await fetch(
        `${platform.config.cadvisorUrl ?? "http://cadvisor:8080"}/metrics`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) {
        reply.code(503);
        return `cadvisor_unavailable:${response.status}`;
      }
      reply.type("text/plain; version=0.0.4");
      const requestedRunId = request.query?.run_id;
      let runId: string | undefined;
      try {
        runId = resolveRequestedRunId(
          requestedRunId,
          (id) => platform.repositories.getRun(id),
          () => platform.activeRunId()
        );
      } catch {
        reply.code(404);
        return "run_not_found";
      }
      return filterCAdvisorMetrics(await response.text(), runId);
    } catch (error) {
      reply.code(503);
      return `cadvisor_proxy_failed:${String(error)}`;
    }
  });
  app.get("/internal/cadvisor/source-metrics", async (_request: any, reply: any) => {
    try {
      const response = await fetch(
        `${platform.config.cadvisorUrl ?? "http://cadvisor:8080"}/metrics`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) {
        reply.code(503);
        return `cadvisor_unavailable:${response.status}`;
      }
      reply.type("text/plain; version=0.0.4");
      // This endpoint is only for source preflight. The Prometheus scrape path
      // above remains scoped to the active run's owned containers.
      return response.text();
    } catch (error) {
      reply.code(503);
      return `cadvisor_source_probe_failed:${String(error)}`;
    }
  });
  app.get("/internal/observer-metrics", async (_request: any, reply: any) => {
    reply.type("text/plain; version=0.0.4");
    return platform.observerMetrics.render();
  });
  app.get("/api/v1/health", async () =>
    dependencyHealth({
      prometheus: (await platform.prometheus.health()) ? "healthy" : "unavailable",
      docker: (await platform.orchestrator.health?.()) === false ? "unavailable" : "healthy"
    })
  );
  app.get("/api/v1/scenarios", async (request: any, reply: any) => {
    const id = typeof request.query?.id === "string" ? request.query.id : undefined;
    const status = typeof request.query?.status === "string" ? request.query.status : undefined;
    if (status && status !== "available")
      return sendError(reply, new Error("scenario_status_invalid"), "invalid_request", 400);
    const controlScenarios = platform.controlUi.listScenarios();
    return {
      contractVersion: "control-ui.v1",
      statusModel: "scenario-catalog.v1",
      scenarios: (controlScenarios.length
        ? controlScenarios
        : platform.scenarios.list({ id, status })
      )
        .filter(
          (scenario: any) => (!id || scenario.id === id) && (!status || status === "available")
        )
        .map((scenario: any) => ({
          ...scenario,
          status: "available"
        }))
    };
  });
  app.post("/api/v1/scenarios", async (_request: any, reply) => {
    reply.code(410);
    return { error: "operation_retired" };
  });
  app.post("/api/v1/preflight", async (request: any, reply) => {
    try {
      const body = request.body ?? {};
      const scenario = resolveScenario(platform, body.scenario);
      validateObserverAdapters(platform, scenario);
      const input = body.request ?? body;
      const [
        prometheusAvailable,
        dockerAvailable,
        dbImageInspectable,
        pasImageInspectable,
        loadgenImageInspectable,
        observerImageInspectable
      ] = await inspectDependencies(platform, input);
      const diskIo = await requiredDiskIo(platform);
      const result = validateExperimentRequest(input, scenario, {
        ...(body.options ?? {}),
        databaseCapabilities: {version:platform.config.openedge?.version ?? "unverified",features:platform.config.openedge?.databaseFeatures ?? []},
        observerValidate: platform.validateObserverDeclaration,
        diskIo,
        ...hostCapacity(platform.config.artifactRoot),
        inputRoot: platform.inputRoot,
        prometheusAvailable,
        dockerAvailable,
        imageInspectable:
          dbImageInspectable &&
          pasImageInspectable &&
          loadgenImageInspectable &&
          observerImageInspectable
      });
      return {
        valid: true,
        scenario: { id: result.scenario.id, version: result.scenario.version },
        inputs: redactInputs(result.inputs),
        provenance: result.provenance,
        warnings: result.warnings
      };
    } catch (error) {
      return sendError(reply, error, "preflight_failed", 422);
    }
  });
  app.post("/api/v1/environments/bootstrap", async (request: any, reply) => {
    try {
      const body = request.body ?? {};
      const scenario = resolveScenario(platform, body.scenario);
      validateObserverAdapters(platform, scenario);
      const input = body.request ?? {
        scenario: { id: scenario.id, version: scenario.version },
        comparisonMode: "exploratory",
        repetitions: 1,
        variants: [{ id: "bootstrap", name: "Bootstrap", parameters: {} }],
        inputs: body.inputs ?? {}
      };
      const [
        prometheusAvailable,
        dockerAvailable,
        dbImageInspectable,
        pasImageInspectable,
        loadgenImageInspectable,
        observerImageInspectable
      ] = await inspectDependencies(platform, input);
      validateExperimentRequest(input, scenario, {
        databaseCapabilities: {version:platform.config.openedge?.version ?? "unverified",features:platform.config.openedge?.databaseFeatures ?? []},
        observerValidate: platform.validateObserverDeclaration,
        diskIo: await requiredDiskIo(platform),
        ...hostCapacity(platform.config.artifactRoot),
        inputRoot: platform.inputRoot,
        prometheusAvailable,
        dockerAvailable,
        imageInspectable:
          dbImageInspectable &&
          pasImageInspectable &&
          loadgenImageInspectable &&
          observerImageInspectable
      });
      const record = await platform.bootstrap.create(input, scenario);
      reply.code(202);
      return {
        ...record,
        input: redactInputs(input.inputs),
        readinessDeadline: new Date(Date.now() + 60000).toISOString()
      };
    } catch (error) {
      return sendError(reply, error, "bootstrap_failed", 422);
    }
  });
  app.get("/api/v1/environments/:environmentId", async (request: any, reply: any) => {
    const record = platform.bootstrap.get(request.params.environmentId);
    if (!record) return sendError(reply, new Error("environment_not_found"), "not_found", 404);
    return record;
  });
  app.post("/api/v1/environments/:environmentId/close", async (request: any, reply: any) => {
    try {
      const record = await platform.bootstrap.close(request.params.environmentId);
      reply.code(202);
      return record;
    } catch (error) {
      return sendError(reply, error, "bootstrap_close_failed", 409);
    }
  });
  app.post("/api/v1/experiments", async (request: any, reply) => {
    try {
      if (request.body?.previewId) {
        const result = platform.controlUi.submit(
          request.body,
          request.headers?.["idempotency-key"]
        );
        reply.code(202);
        return result;
      }
      reply.code(410);
      return {
        code: "operation_retired",
        message: "Use the disk-scenario preview and submit API."
      };
    } catch (error) {
      return sendError(reply, error, "experiment_validation_failed", 422);
    }
  });
  app.get("/api/v1/experiments/:experimentId", async (request: any, reply) => {
    const controlExperiment = platform.controlUi.getExperiment(request.params.experimentId);
    if (controlExperiment) return controlExperiment;
    const experiment = platform.repositories.getExperiment(request.params.experimentId);
    if (!experiment) return sendError(reply, new Error("experiment_not_found"), "not_found", 404);
    return experiment;
  });
  app.get("/api/v1/experiments", async (request: any) => {
    const controlExperiments = platform.controlUi.listExperiments({
      status: typeof request.query?.status === "string" ? request.query.status : undefined,
      scenario: typeof request.query?.scenario === "string" ? request.query.scenario : undefined
    });
    return {
      contractVersion: "control-ui.v1",
      experiments: controlExperiments.length
        ? controlExperiments
        : platform.repositories.listExperiments(),
      items: controlExperiments
    };
  });
  app.get("/api/v1/experiments/:experimentId/runs", async (request: any, reply) => {
    if (platform.controlUi.hasExperiment(request.params.experimentId))
      return {
        items: platform.controlUi.getExperiment(request.params.experimentId)?.runs ?? [],
        runs: platform.controlUi.getExperiment(request.params.experimentId)?.runs ?? []
      };
    const experiment = platform.repositories.getExperiment(request.params.experimentId);
    if (!experiment) return sendError(reply, new Error("experiment_not_found"), "not_found", 404);
    return { runs: platform.repositories.listRuns(experiment.id) };
  });
  app.get("/api/v1/runs/:runId", async (request: any, reply) => {
    const run = platform.repositories.getRun(request.params.runId);
    if (!run) return sendError(reply, new Error("run_not_found"), "not_found", 404);
    const events = platform.repositories.listEvents(run.id);
    const health = await liveRunHealth(run, events, platform.prometheus);
    const detail = await platform.controlUi.runDetail(run.id);
    return {
      ...(detail ?? run),
      latestEventId: events.at(-1)?.id ?? 0,
      latestEventAt: events.at(-1)?.occurredAt,
      health
    };
  });
  app.get("/api/v1/runs/:runId/events", async (request: any, reply) => {
    const run = platform.repositories.getRun(request.params.runId);
    if (!run) return sendError(reply, new Error("run_not_found"), "not_found", 404);
    const events = platform.repositories.listEvents(run.id, Number(request.query?.after ?? 0));
    const allEvents = platform.repositories.listEvents(run.id);
    return {
      events,
      latestEventId: allEvents.at(-1)?.id ?? Number(request.query?.after ?? 0),
      latestEventAt: allEvents.at(-1)?.occurredAt
    };
  });
  app.get("/api/v1/runs/:runId/metrics", async (request: any, reply) => {
    const run = platform.repositories.getRun(request.params.runId);
    if (!run) return sendError(reply, new Error("run_not_found"), "not_found", 404);
    const query = request.query ?? {};
    const selector = [`run_id="${run.id}"`];
    const continuous = run.environmentSnapshot?.metricsCollectionMode === "continuous";
    if (query.phase)
      selector.push(
        continuous
          ? `phase=~"${escapeLabelFilter(query.phase)}|^$"`
          : `phase="${escapeLabelFilter(query.phase)}"`
      );
    if (query.operation) selector.push(`operation="${escapeLabelFilter(query.operation)}"`);
    const metric = query.metric ? String(query.metric) : "";
    if (metric && !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric))
      return sendError(reply, new Error("invalid_metric_filter"), "invalid_request", 400);
    const promQuery = metric ? `${metric}{${selector.join(",")}}` : `{${selector.join(",")}}`;
    try {
      const measurement = query.phase
        ? run.phaseBoundaries?.[query.phase]
        : run.phaseBoundaries?.measurement;
      const collected =
        query.instant === "false"
          ? await platform.prometheus.queryRange(
              promQuery,
              measurement?.startedAt
                ? Date.parse(measurement.startedAt) / 1000
                : Date.now() / 1000 - 60,
              measurement?.finishedAt
                ? Date.parse(measurement.finishedAt) / 1000
                : Date.now() / 1000,
              // The scrape step: a finer step only repeats each scraped sample.
              Math.max(1, platform.config.prometheusScrapeIntervalSeconds ?? 1)
            )
          : await platform.prometheus.queryInstant(promQuery);
      const samples = collected
        .map((sample) => {
          if (!continuous || sample.labels.phase) return sample;
          const phase =
            Object.entries(run.phaseBoundaries ?? {}).find(
              ([, boundary]) =>
                boundary?.startedAt &&
                sample.timestamp >= Date.parse(boundary.startedAt) / 1000 &&
                (!boundary.finishedAt || sample.timestamp < Date.parse(boundary.finishedAt) / 1000)
            )?.[0] ?? "idle";
          return {
            ...sample,
            labels: { ...sample.labels, phase: phase as typeof sample.labels.phase }
          };
        })
        .filter((sample) => !query.phase || sample.labels.phase === query.phase);
      // Run series live only in Prometheus (constitution 4.0.0). A finalized run that recorded
      // samples but returns none has aged out of retention; say so rather than show nothing.
      const availability = samples.length
        ? "available"
        : await platform.metricsAvailability.get(run.id);
      return {
        samples,
        summaries: finalizedSummaries(run, query),
        metricsAvailability: availability,
        stale: false,
        asOf: new Date().toISOString(),
        measurementValidity: run.measurementValidity,
        health: buildLiveRunHealth(run, samples, platform.repositories.listEvents(run.id).at(-1))
      };
    } catch {
      return {
        samples: [],
        summaries: finalizedSummaries(run, query),
        metricsAvailability: "unavailable",
        stale: true,
        asOf: new Date().toISOString(),
        measurementValidity: run.measurementValidity,
        health: buildLiveRunHealth(run, [], platform.repositories.listEvents(run.id).at(-1), true)
      };
    }
  });
  app.post("/api/v1/runs/:runId/cancel", async (request: any, reply) => {
    try {
      const key = requireIdempotencyKey(request);
      const previous = platform.repositories.getIdempotency(
        `cancel-run:${request.params.runId}`,
        key
      );
      if (previous) {
        reply.code(previous.statusCode);
        return previous.response;
      }
      const run = platform.coordinator.cancel(request.params.runId);
      reply.code(202);
      platform.repositories.saveIdempotency(`cancel-run:${request.params.runId}`, key, 202, run);
      return run;
    } catch (error) {
      return sendError(reply, error, "run_already_terminal", 409);
    }
  });
  app.get("/api/v1/runs/:runId/artifacts", async (request: any, reply) => {
    const run = platform.repositories.getRun(request.params.runId);
    if (!run) return sendError(reply, new Error("run_not_found"), "not_found", 404);
    return {
      artifacts: platform.artifacts.list(run.id).map((artifact) => ({
        ...artifact,
        downloadUrl: `/api/v1/runs/${run.id}/artifacts/${artifact.id}`
      }))
    };
  });
  app.get("/api/v1/runs/:runId/artifacts/:artifactId", async (request: any, reply) => {
    const artifact = platform.repositories
      .listArtifacts(request.params.runId)
      .find((item) => item.id === request.params.artifactId);
    if (!artifact) return sendError(reply, new Error("artifact_not_found"), "not_found", 404);
    reply.type("application/octet-stream");
    const filename = platform.storage.safePath(artifact.path);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile())
      return sendError(reply, new Error("artifact_unavailable"), "artifact_unavailable", 404);
    return fs.createReadStream(filename);
  });
  app.get("/api/v1/comparisons/:comparisonId", async (request: any, reply: any) => {
    try {
      const value = platform.controlUi.getComparison(request.params.comparisonId, {
        cursor: request.query?.cursor,
        limit: request.query?.limit
      });
      if (!value)
        return sendError(reply, new Error("comparison_not_found"), "comparison_not_found", 404);
      return value;
    } catch (error) {
      return sendError(reply, error, (error as Error).message, 400);
    }
  });
  app.get("/api/v1/comparisons/:comparisonId/export", async (request: any, reply: any) => {
    try {
      const id = request.params.comparisonId;
      if (platform.controlUi.comparisonPending(id)) {
        reply.header("Retry-After", "2");
        reply.code(409);
        const result = platform.controlUi.getComparison(id);
        return {
          error: {
            code: "comparison_summary_pending",
            message: "Historical summaries are being computed"
          },
          id: result.id,
          selectionRevision: result.selectionRevision,
          totalSelectedRunCount: result.totalSelectedRunCount,
          page: result.page,
          runs: result.runs.map((r: any) => ({ runId: r.runId, status: r.summary.status })),
          readLink: `/api/v1/comparisons/${encodeURIComponent(result.id)}`
        };
      }
      const selection = platform.controlUi.resolveComparisonSelection(id);
      if (!selection)
        return sendError(reply, new Error("comparison_not_found"), "comparison_not_found", 404);
      reply.type("text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="comparison-${encodeURIComponent(selection.id)}.csv"`
      );
      return Readable.from(platform.controlUi.comparisonCsvStream(selection.id));
    } catch (error) {
      return sendError(reply, error, (error as Error).message, 404);
    }
  });
  registerControlUiRoutes(app, platform);
  registerGrafanaRoutes(app, {
    metricsAvailability: (ids) => platform.metricsAvailability.forRuns(ids),
    prometheusUrl: platform.config.prometheusUrl,
    grafanaUrl: platform.config.grafanaUrl ?? "http://127.0.0.1:13001",
    parameterSnapshots: new ParameterSnapshotQueries(platform.repositories, platform.storage),
    savedSummaries: new SavedSummaryQueries(platform.controlRepository.summaryReader(), (id) =>
      platform.summaryWorker?.schedule(id)
    ),
    timelines: repositoryTimelineSource(platform.repositories)
  });
}
function resolveScenario(platform: Platform, input: any): any {
  if (input?.target) return input;
  const found = platform.scenarios.get(input?.id, input?.version);
  if (!found) throw new Error("scenario_not_found");
  return found;
}
function validateObserverAdapters(platform: Platform, scenario: any): void {
  for (const observer of scenario.observers ?? []) {
    platform.validateObserverDeclaration(observer);
    if (observer.required && !platform.supportsObserverKind(observer.kind))
      throw new Error(`observer_adapter_unavailable:${observer.kind}`);
  }
}
async function requiredDiskIo(platform: Platform) {
  if (!platform.requiredDiskIo) return { cadvisor: true, nodeExporterBlockDevice: true };
  return verifyDiskIoSources(platform.prometheus, platform.config.cadvisorUrl);
}

async function inspectDependencies(platform: Platform, request: any) {
  const inputs = request?.inputs ?? {};
  if (platform.requirePinnedSupportImages) {
    checkImageReference(platform.supportImages.loadgen);
    checkImageReference(platform.supportImages.observer);
  }
  return Promise.all([
    platform.prometheus.health(),
    platform.orchestrator.health?.() ?? Promise.resolve(true),
    platform.orchestrator.inspectImage?.(inputs.databaseImage) ?? Promise.resolve(true),
    platform.orchestrator.inspectImage?.(inputs.pasImage) ?? Promise.resolve(true),
    platform.orchestrator.inspectImage?.(platform.supportImages.loadgen) ?? Promise.resolve(true),
    platform.orchestrator.inspectImage?.(platform.supportImages.observer) ?? Promise.resolve(true)
  ]);
}

function requireIdempotencyKey(request: any): string {
  const value = request.headers?.["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8)
    throw new Error("idempotency_key_required");
  return value.trim();
}

function finalizedSummaries(run: any, query: any): unknown[] {
  const summaries = Array.isArray(run.summary?.summaries) ? run.summary.summaries : [];
  return summaries.filter(
    (summary: any) =>
      (!query.phase || query.phase === "all" || summary.phase === query.phase) &&
      (!query.metric || summary.metricName === query.metric) &&
      (!query.operation || summary.labels?.operation === query.operation)
  );
}
function redactInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(inputs) as Record<string, unknown>;
}

function escapeLabelFilter(value: unknown): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}
function sendError(reply: any, error: any, code: string, status = 400) {
  const requestIdValue = requestId();
  reply.code(status);
  return {
    error: {
      code,
      message: redactSecrets(error?.message ?? String(error)),
      fields: error instanceof ValidationError ? error.fields : [],
      requestId: requestIdValue
    }
  };
}
