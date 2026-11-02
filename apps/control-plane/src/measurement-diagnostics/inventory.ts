import { measurementPanelInventory, consumingViews } from "./views";
import { randomUUID } from "node:crypto";
import nativeCatalog from "../../../../packages/contracts/src/openedge-db-metric-catalog.json";
import {
  DATABASE_SUMMARY_CATALOG,
  FILE_SUMMARY_CATALOG,
  RESOURCE_SUMMARY_CATALOG
} from "../../../../packages/contracts/src/summary-catalog";
import {
  MeasurementExpectation,
  canonicalDimensions,
  validateMeasurementEvidence
} from "../../../../packages/contracts/src/measurement-diagnostics";
import type { MetricDefinition } from "../../../../packages/contracts/src/metric-definitions";
export interface InventoryInput {
  runId: string;
  phase: string;
  startMs: number;
  endMs: number;
  sourceCadenceMs: number | null;
  controllerCadenceMs: number | null;
  scrapeCadenceMs: number | null;
  topology?: Array<{
    group: "platform" | "database" | "pas";
    service: string;
    memberId: string;
    replica?: string;
  }>;
  tables?: string[];
  nativeDimensions?: Record<string, string[]>;
  nativeEvidenceRef?: string;
  nativeAvailability?: Array<{
    metricName: string;
    dimensions: Record<string, string>;
    availability: string;
    reasonCode: string;
    sourceRef: string;
  }>;
  nativeIdentities?: Record<string, Array<Record<string, string>>>;
  paths?: Array<{ file: string; kind: "file" | "directory" | "unknown"; evidenceRef?: string }>;
  proofs?: Array<{
    definitionId: string;
    dimensions: Record<string, string>;
    applicability: MeasurementExpectation["applicability"];
    reasonCode: string;
    evidenceRefs: string[];
  }>;
  views?: Record<string, MeasurementExpectation["consumingViews"]>;
  additionalDefinitions?: Array<{
    definition: MetricDefinition;
    dimensions: Record<string, string>;
  }>;
}
export interface ExpectationInventory {
  expectations: Iterable<MeasurementExpectation>;
  inventoryIncomplete: boolean;
  missingInventoryKinds: string[];
}
/** Inventory comes from frozen topology/config/native inventory, never from returned metric rows. */
export function buildMeasurementInventory(input: InventoryInput): ExpectationInventory {
  const panels = measurementPanelInventory();
  const missing = new Set<string>();
  if (!input.topology?.length) missing.add("topology");
  if (!input.tables) missing.add("tables");
  if (!input.paths?.length) missing.add("paths");
  for (const entry of nativeCatalog.entries)
    for (const dimension of entry.dimensions)
      if (!input.nativeDimensions?.[dimension]?.length)
        missing.add(`native_dimension:${dimension}`);
  for (const entry of nativeCatalog.entries) {
    const tuples = input.nativeIdentities?.[entry.name];
    if (entry.dimensions.length > 1 && !tuples) missing.add(`native_tuple_inventory:${entry.name}`);
    if (
      tuples?.some((tuple) =>
        entry.dimensions.some(
          (key) => tuple[key] === undefined && input.nativeDimensions?.[key]?.length !== 1
        )
      )
    )
      missing.add(`native_tuple_dimensions:${entry.name}`);
  }
  const inventory: ExpectationInventory = {
    inventoryIncomplete: missing.size > 0,
    missingInventoryKinds: [...missing].sort(),
    expectations: []
  };
  // Persistent configuration evidence must identify precisely the same native
  // tuple. A missing reading or a transient startup state is never such proof.
  function nativeProof(definition: MetricDefinition, dimensions: Record<string, string>) {
    if (!input.nativeEvidenceRef) return;
    if (
      definition.sourceMetricNames.includes("parkbench_openedge_db_table_operations_total") &&
      dimensions.table === "other" &&
      input.nativeDimensions?.table_inventory_contract?.includes(
        "openedge-db.v4.application-tables-complete"
      ) &&
      !(input.nativeDimensions.application_table ?? []).some(
        (table) => table.toLowerCase() === "other"
      )
    )
      return {
        applicability: "INAPPLICABLE" as const,
        reasonCode: "empty_other_table_scope",
        evidenceRefs: [input.nativeEvidenceRef]
      };
    const candidates = (input.nativeAvailability ?? []).filter((item) => {
      if (!definition.sourceMetricNames.includes(item.metricName)) return false;
      const tuple = { ...item.dimensions };
      for (const [key, values] of Object.entries(input.nativeDimensions ?? {}))
        if (["database", "database_epoch"].includes(key) && values.length === 1)
          tuple[key] ??= values[0];
      const expected = { ...dimensions };
      for (const key of ["database", "database_epoch"])
        if (!(key in expected) && input.nativeDimensions?.[key]?.length === 1)
          expected[key] = input.nativeDimensions[key][0];
      return canonicalDimensions(tuple) === canonicalDimensions(expected);
    });
    if (candidates.length !== 1) return;
    const item = candidates[0];
    if (
      item.availability === "not_configured" &&
      item.reasonCode === "alternate_pool_disabled" &&
      dimensions.pool === "alternate"
    )
      return {
        applicability: "INAPPLICABLE" as const,
        reasonCode: item.reasonCode,
        evidenceRefs: [input.nativeEvidenceRef]
      };
  }
  function expectation(
    definition: MetricDefinition,
    dimensions: Record<string, string>,
    statistic: string,
    forced?: {
      applicability: MeasurementExpectation["applicability"];
      reason: string;
      refs: string[];
    }
  ): MeasurementExpectation {
    const proof =
      input.proofs?.find(
        (p) =>
          p.definitionId === definition.definitionId &&
          canonicalDimensions(p.dimensions) === canonicalDimensions(dimensions)
      ) ?? nativeProof(definition, dimensions);
    let applicability: MeasurementExpectation["applicability"] =
      forced?.applicability ?? proof?.applicability ?? "EXPECTED";
    let reason = forced?.reason ?? proof?.reasonCode ?? null;
    const refs = forced?.refs ?? proof?.evidenceRefs ?? [];
    if (["INAPPLICABLE", "UNSUPPORTED"].includes(applicability) && !refs.length) {
      applicability = "UNRESOLVED";
      reason = "applicability_proof_missing";
    }
    const cadence = input.controllerCadenceMs ?? input.sourceCadenceMs ?? input.scrapeCadenceMs;
    if (!cadence) throw new Error("measurement_inventory_cadence_unknown");
    return validateMeasurementEvidence<MeasurementExpectation>({
      contractVersion: "measurement-expectation.v1",
      expectationId: randomUUID(),
      runId: input.runId,
      definitionId: definition.definitionId,
      semanticVersion: definition.sourceContractVersion,
      statistic,
      scope: `${definition.group}:${definition.coverageScope}`,
      dimensions: Object.fromEntries(
        Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      ),
      sourceKind: definition.authoritativePublisher.includes("native")
        ? "native_snapshot"
        : definition.coverageScope === "resource"
          ? "resource_scrape"
          : "endpoint",
      publisher: definition.authoritativePublisher,
      phase: input.phase,
      startMs: input.startMs,
      endMs: input.endMs,
      sourceCadenceMs: input.sourceCadenceMs,
      controllerCadenceMs: input.controllerCadenceMs,
      scrapeCadenceMs: input.scrapeCadenceMs,
      qualityRequirement: definition.required ? "required" : "optional",
      applicability,
      applicabilityReason: reason,
      evidenceRefs: refs,
      slotRuleVersion: "phase-start.v1",
      expectedSlots: Math.ceil((input.endMs - input.startMs) / cadence),
      consumingViews:
        input.views?.[`${definition.definitionId}:${definition.group}`] ??
        input.views?.[definition.definitionId] ??
        consumingViews(definition, panels)
    });
  }
  function* readings(
    definition: MetricDefinition,
    dimensions: Record<string, string>,
    forced?: Parameters<typeof expectation>[3]
  ) {
    yield expectation(definition, dimensions, "source_reading", forced);
    for (const statistic of definition.supportedStatistics)
      yield expectation(definition, dimensions, statistic, forced);
  }
  function* dimensionsFor(
    keys: readonly string[],
    index = 0,
    dimensions: Record<string, string> = {}
  ): Generator<Record<string, string>> {
    if (index === keys.length) {
      yield dimensions;
      return;
    }
    for (const value of input.nativeDimensions?.[keys[index]] ?? [])
      yield* dimensionsFor(keys, index + 1, { ...dimensions, [keys[index]]: value });
  }
  inventory.expectations = {
    *[Symbol.iterator]() {
      for (const definition of RESOURCE_SUMMARY_CATALOG) {
        const direction = definition.definitionId.startsWith("disk.")
          ? { direction: definition.definitionId.includes("read") ? "read" : "write" }
          : definition.definitionId.startsWith("network.")
            ? { direction: definition.definitionId.endsWith("receive") ? "receive" : "transmit" }
            : {};
        for (const member of input.topology?.filter((m) => m.group === definition.group) ?? [])
          yield* readings(definition, {
            ...direction,
            service: member.service,
            member: member.memberId,
            ...(member.replica ? { replica: member.replica } : {})
          });
        // Group statistics also require every independently expected constituent.
        yield* readings(definition, { ...direction, scope: definition.group });
      }
      for (const definition of DATABASE_SUMMARY_CATALOG) {
        if (definition.definitionId.startsWith("db.table."))
          for (const table of input.tables ?? [])
            yield* readings(definition, { ...definition.selectorDimensions, table });
        else yield* readings(definition, { ...definition.selectorDimensions });
      }
      for (const definition of FILE_SUMMARY_CATALOG) {
        if (definition.coverageScope === "logical_bi") {
          yield* readings(definition, { scope: definition.coverageScope });
          continue;
        }
        for (const file of input.paths ?? []) {
          const unsupported =
            definition.definitionId === "disk.space.file_size" && file.kind === "directory";
          const unknown = file.kind === "unknown" || !file.evidenceRef;
          yield* readings(
            definition,
            { scope: definition.coverageScope, file: file.file },
            unsupported
              ? {
                  applicability: file.evidenceRef ? "UNSUPPORTED" : "UNRESOLVED",
                  reason: "path_kind_directory",
                  refs: file.evidenceRef ? [file.evidenceRef] : []
                }
              : unknown
                ? { applicability: "UNRESOLVED", reason: "path_kind_unconfirmed", refs: [] }
                : undefined
          );
        }
      }
      for (const entry of nativeCatalog.entries) {
        const definition: MetricDefinition = {
          definitionId: `parkbench_openedge_db_${entry.name}`,
          displayName: entry.name,
          group: "database",
          sourceMetricNames: [`parkbench_openedge_db_${entry.name}`],
          type: entry.type === "counter" ? "counter" : "gauge",
          sourceUnit: entry.unit,
          rateOrLevelUnit: entry.unit,
          totalUnit: null,
          coverageScope: entry.family,
          allowedDimensions: entry.dimensions,
          required: false,
          supportedStatistics: [],
          authoritativePublisher: "native_db_endpoint",
          sourceContractVersion: nativeCatalog.contractVersion
        };
        const tuples = input.nativeIdentities?.[entry.name];
        if (tuples) {
          for (const tuple of tuples) {
            const dimensions = Object.fromEntries(
              entry.dimensions.map((key) => [
                key,
                tuple[key] ??
                  (input.nativeDimensions?.[key]?.length === 1
                    ? input.nativeDimensions[key][0]
                    : undefined)
              ])
            );
            if (Object.values(dimensions).some((value) => value === undefined)) continue;
            yield expectation(definition, dimensions, "source_reading");
          }
        } else if (entry.dimensions.length <= 1)
          for (const dimensions of dimensionsFor(entry.dimensions))
            yield expectation(definition, dimensions, "source_reading");
      }
      for (const { definition, dimensions } of input.additionalDefinitions ?? [])
        yield* readings(definition, dimensions);
    }
  };
  return inventory;
}
/** Streaming bounded pages. Refusal never changes source collection or the input inventory. */
export async function persistInventoryPages(
  inventory: ExpectationInventory,
  writePage: (body: string, page: number) => Promise<boolean>,
  limits: { pageLimitBytes: number; totalLimitBytes: number }
) {
  if (
    !Number.isSafeInteger(limits.pageLimitBytes) ||
    limits.pageLimitBytes < 1024 ||
    !Number.isSafeInteger(limits.totalLimitBytes) ||
    limits.totalLimitBytes < 0
  )
    throw new Error("measurement_inventory_invalid:page_bounds");
  let page: MeasurementExpectation[] = [],
    pageBytes = 2,
    totalBytes = 0,
    pageNumber = 0,
    persistedExpectations = 0,
    truncated = false;
  async function flush() {
    if (!page.length) return true;
    const body = JSON.stringify(page),
      bytes = Buffer.byteLength(body);
    if (totalBytes + bytes > limits.totalLimitBytes || !(await writePage(body, pageNumber)))
      return false;
    totalBytes += bytes;
    pageNumber++;
    persistedExpectations += page.length;
    page = [];
    pageBytes = 2;
    return true;
  }
  for (const expectation of inventory.expectations) {
    const bytes = Buffer.byteLength(JSON.stringify(expectation));
    if (bytes + 2 > limits.pageLimitBytes) {
      truncated = true;
      break;
    }
    if (pageBytes + bytes + (page.length ? 1 : 0) > limits.pageLimitBytes && !(await flush())) {
      truncated = true;
      break;
    }
    page.push(expectation);
    pageBytes += bytes + (page.length > 1 ? 1 : 0);
  }
  if (!truncated && !(await flush())) truncated = true;
  return {
    inventoryIncomplete: inventory.inventoryIncomplete || truncated,
    missingInventoryKinds: [...inventory.missingInventoryKinds],
    truncated,
    persistedExpectations,
    pageCount: pageNumber,
    totalBytes
  };
}

export interface MembershipDelta {
  contractVersion: "measurement-inventory-delta.v1";
  deltaId: string;
  runId: string;
  recordedAtMs: number;
  action: "ADD" | "REMOVE";
  member: NonNullable<InventoryInput["topology"]>[number];
  evidenceRef: string;
}
export function inventoryMembershipDelta(
  runId: string,
  before: NonNullable<InventoryInput["topology"]>,
  after: NonNullable<InventoryInput["topology"]>,
  recordedAtMs: number,
  ownershipEvidenceRef: string
): MembershipDelta[] {
  if (!ownershipEvidenceRef || !Number.isFinite(recordedAtMs) || recordedAtMs < 0)
    throw new Error("measurement_inventory_invalid:membership_proof");
  const identity = (member: (typeof before)[number]) => canonicalDimensions(member);
  const old = new Map(before.map((member) => [identity(member), member])),
    current = new Map(after.map((member) => [identity(member), member]));
  if (old.size !== before.length || current.size !== after.length)
    throw new Error("measurement_inventory_invalid:duplicate_member");
  return [
    ...[...old]
      .filter(([key]) => !current.has(key))
      .map(([, member]) => ({ action: "REMOVE" as const, member })),
    ...[...current]
      .filter(([key]) => !old.has(key))
      .map(([, member]) => ({ action: "ADD" as const, member }))
  ].map((value) => ({
    contractVersion: "measurement-inventory-delta.v1",
    deltaId: randomUUID(),
    runId,
    recordedAtMs,
    ...value,
    member: { ...value.member },
    evidenceRef: ownershipEvidenceRef
  }));
}
