import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const templateDigest = (value) => createHash("sha256").update(value).digest("hex");
let generated;
function platformSelectors(expression, expandDeclaredConstants = false) {
  if (expandDeclaredConstants) {
    const { DISK_EXCLUDE, INTERFACE_EXCLUDE } = require(
      path.join(repository, "dist/packages/dashboards/src/filters.js")
    );
    const values = { disk_exclude: DISK_EXCLUDE, interface_exclude: INTERFACE_EXCLUDE };
    expression = expression.replace(
      /\$(disk_exclude|interface_exclude)\b|\$\{(disk_exclude|interface_exclude)\}/g,
      (_, name, braced) => values[name ?? braced]
    );
  }
  const { scanSelectors } = require(
    path.join(repository, "dist/apps/control-plane/src/grafana/promql-selectors.js")
  );
  const selectors = scanSelectors(expression);
  if (
    !selectors.length ||
    selectors.some(
      (s) =>
        !s.metric?.startsWith("container_") ||
        !s.matchers.some((m) => m.name === "job" && m.op === "=" && m.value === "cadvisor") ||
        !s.matchers.some(
          (m) =>
            m.name === "container_label_com_docker_compose_project" &&
            m.op === "=" &&
            m.value === "parkbench-platform"
        )
    )
  )
    return null;
  return templateDigest(
    JSON.stringify(
      selectors
        .map((s) => [s.metric, ...s.matchers.map((m) => [m.name, m.op, m.value]).sort()])
        .sort()
    )
  );
}
export function generatedPanelQueries(dashboardUid, panelId) {
  if (!generated) {
    generated = new Map();
    const { dashboardDefinitions } = require(
      path.join(repository, "dist/packages/dashboards/src/dashboards/definitions.js")
    );
    const { emitPanels } = require(path.join(repository, "dist/packages/dashboards/src/emit.js"));
    for (const dashboard of Object.values(dashboardDefinitions())) {
      const visit = (panels) => {
        for (const panel of panels) {
          visit(panel.panels ?? []);
          if (panel.type === "row") continue;
          generated.set(
            `${dashboard.uid}:${panel.id}`,
            (panel.targets ?? [])
              .filter((q) => !q.hide && q.expr)
              .map((q) => {
                const datasourceUid = q.datasource?.uid ?? panel.datasource?.uid;
                const selectorsDigest =
                  datasourceUid === "prometheus" ? platformSelectors(q.expr, true) : null;
                return {
                  refId: q.refId,
                  datasourceUid,
                  templateDigest: templateDigest(q.expr),
                  sourceScope: selectorsDigest ? "GLOBAL_PLATFORM" : "RUN",
                  ...(selectorsDigest ? { selectorsDigest } : {}),
                  ...(selectorsDigest &&
                  dashboard.uid === "parkbench-platform-resources" &&
                  String(panel.id) === "11" &&
                  q.refId === "D" &&
                  /container_spec_memory_limit_bytes\{[^}]+\} > 0/.test(q.expr)
                    ? { emptyRule: "memory_limit_not_configured" }
                    : {})
                };
              })
          );
        }
      };
      visit(emitPanels(dashboard));
    }
  }
  return generated.get(`${dashboardUid}:${panelId}`) ?? [];
}
export function globalPlatformContext({
  selection,
  dashboardVersion,
  target,
  expression,
  effective
}) {
  const declared = generatedPanelQueries(selection.dashboardUid, selection.panelId).find(
    (q) => q.refId === target.refId
  );
  const selectorsDigest = platformSelectors(expression);
  if (
    !declared ||
    declared.sourceScope !== "GLOBAL_PLATFORM" ||
    declared.templateDigest !== templateDigest(target.expr) ||
    !selectorsDigest ||
    selectorsDigest !== declared.selectorsDigest
  )
    return undefined;
  return {
    contractVersion: "measurement-global-chart-context.v1",
    sourceScope: "GLOBAL_PLATFORM",
    runId: selection.runId,
    phase: selection.phase,
    dashboardUid: selection.dashboardUid,
    dashboardVersion,
    panelId: String(selection.panelId),
    refId: target.refId,
    startMs: selection.startMs,
    endMs: selection.endMs,
    effectiveStartMs: effective.startMs,
    effectiveEndMs: effective.endMs,
    templateDigest: declared.templateDigest,
    selectorsDigest,
    expressionDigest: templateDigest(expression)
  };
}
export function globalPlatformContextMatches(query, panel, selection) {
  const context = query.globalContext,
    source = query.sourceMetadata;
  const effective =
    query.kind === "INSTANT"
      ? { startMs: selection.endMs, endMs: selection.endMs }
      : query.kind === "RANGE" &&
          Number.isFinite(query.stepMs) &&
          query.stepMs > 0 &&
          query.stepMs <= selection.endMs - selection.startMs
        ? {
            startMs: Math.floor(selection.startMs / query.stepMs) * query.stepMs,
            endMs: Math.floor(selection.endMs / query.stepMs) * query.stepMs
          }
        : null;
  const declared = panel.queries?.find((q) => q.refId === query.refId);
  return Boolean(
    effective &&
    (query.utcOffsetSec ?? 0) === 0 &&
    context?.effectiveStartMs === effective.startMs &&
    context?.effectiveEndMs === effective.endMs &&
    declared?.sourceScope === "GLOBAL_PLATFORM" &&
    declared.datasourceUid === "prometheus" &&
    query.datasourceUid === "prometheus" &&
    context?.contractVersion === "measurement-global-chart-context.v1" &&
    context.sourceScope === "GLOBAL_PLATFORM" &&
    context.runId === selection.runId &&
    context.phase === "measurement" &&
    context.dashboardUid === panel.dashboardUid &&
    context.panelId === String(panel.panelId) &&
    context.refId === query.refId &&
    context.startMs === selection.startMs &&
    context.endMs === selection.endMs &&
    context.effectiveStartMs === query.effectiveStartMs &&
    context.effectiveEndMs === query.effectiveEndMs &&
    source?.contractVersion === "measurement-chart-query.v1" &&
    source.mode === "unscoped" &&
    source.queryMode === "EVALUATION_GRID" &&
    source.incomplete === false &&
    Array.isArray(source.runIds) &&
    source.runIds.length === 0 &&
    Number.isSafeInteger(source.seriesCount) &&
    source.seriesCount >= 0 &&
    Number.isSafeInteger(source.evaluationPointCount) &&
    source.evaluationPointCount >= 0 &&
    source.requestedStartMs === context.effectiveStartMs &&
    source.requestedEndMs === context.effectiveEndMs &&
    source.stepMs === query.stepMs &&
    query.templateDigest === declared.templateDigest &&
    context.templateDigest === declared.templateDigest &&
    context.selectorsDigest === declared.selectorsDigest &&
    /^[a-f0-9]{64}$/.test(context.expressionDigest ?? "") &&
    Number.isSafeInteger(context.dashboardVersion) &&
    query.templateRef ===
      `${panel.dashboardUid}:${context.dashboardVersion}:${panel.panelId}:${query.refId}`
  );
}
