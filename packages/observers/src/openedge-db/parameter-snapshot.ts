import {databaseParameterDefinition,databaseParameterInput} from '../../../contracts/src/database-parameter-options';
import {
  DatabaseParameterSnapshot,
  validateDatabaseParameterSnapshot
} from "../../../contracts/src/database-parameter-snapshot";
import type { DatabaseStartupParameters } from "../../../contracts/src/database-startup";
import {
  OPENEDGE_DB_PARAMETER_MAX_METRIC_VALUE_BYTES,
  OpenEdgeDbParameterCapture,
  validateOpenEdgeDbParameterCapture
} from "../../../contracts/src/openedge-db-parameter-capture";

export interface ParameterSnapshotIdentity {
  runId: string;
  experimentId: string;
  variantId: string;
  repetition: number;
}

const NUMERIC_DTYPES = new Set([4, 5, 7, 8]);

export function deriveDatabaseParameterSnapshot(
  input: OpenEdgeDbParameterCapture,
  identity: ParameterSnapshotIdentity,
  startup?: DatabaseStartupParameters
): DatabaseParameterSnapshot {
  const capture = validateOpenEdgeDbParameterCapture(input);
  const rows: DatabaseParameterSnapshot["rows"] = [];
  const gaps: string[] = [];
  const byName = new Map<string, OpenEdgeDbParameterCapture["rows"]>();
  const nondefaultByName = new Map<string, OpenEdgeDbParameterCapture["rows"][number]>();
  for (const sourceRow of capture.rows) {
    const key = sourceRow.name.toLowerCase();
    const namedRows = byName.get(key) ?? [];
    namedRows.push(sourceRow);
    byName.set(key, namedRows);
    if (sourceRow.isDefault === null) {
      gaps.push(`default_flag_unknown:${sourceRow.name}`);
      continue;
    }
    if (sourceRow.isDefault) continue;
    const prior = nondefaultByName.get(key);
    if (prior) {
      if (prior.rawValue !== sourceRow.rawValue || prior.dtype !== sourceRow.dtype)
        gaps.push(`duplicate_parameter:${sourceRow.name}`);
      continue;
    }
    nondefaultByName.set(key, sourceRow);
    const displayValue = sourceRow.rawValue;
    if (
      displayValue !== null &&
      Buffer.byteLength(displayValue) > OPENEDGE_DB_PARAMETER_MAX_METRIC_VALUE_BYTES
    )
      gaps.push(`metric_value_limit:${sourceRow.name}`);
    const numeric =
      displayValue !== null &&
      sourceRow.dtype !== null &&
      NUMERIC_DTYPES.has(sourceRow.dtype) &&
      /^[-+]?\d+(?:\.\d+)?$/.test(displayValue.trim())
        ? Number(displayValue.trim())
        : undefined;
    rows.push({
      name: sourceRow.name,
      displayValue,
      valueStatus: displayValue === null ? "unknown" : "recorded",
      ...(numeric !== undefined && Number.isFinite(numeric) ? { numericValue: numeric } : {}),
      dtype: sourceRow.dtype,
      isDefault: false,
      ...(sourceRow.isModifiable !== undefined ? { isModifiable: sourceRow.isModifiable } : {})
    });
  }
  const verificationResults = (startup?.parameters ?? []).map((parameter) => {
    const namedRows = byName.get(parameter.name.toLowerCase()) ?? [];
    const nondefaultRows = namedRows.filter((row) => row.isDefault === false);
    const candidates = nondefaultRows.length ? nondefaultRows : namedRows;
    const distinctValues = new Set(candidates.map((row) => row.rawValue));
    const observed = distinctValues.size === 1 ? candidates[0] : undefined;
    const actual = observed?.rawValue ?? null;
    const expected = parameter.displayValue;
    const definition=startup?.registryVersion?databaseParameterDefinition(parameter.name):undefined;
    const numericActual=actual!==null&&/^-?\d+(?:\.\d+)?$/.test(actual.trim())?Number(actual):undefined;
    const numericExpected=/^-?\d+(?:\.\d+)?$/.test(expected)?Number(expected):undefined;
    const brokerSlot=numericActual!==undefined&&numericExpected!==undefined&&['-n','-Mn'].includes(parameter.name)&&numericActual===numericExpected+1;
    let comparable=numericActual!==undefined&&numericExpected!==undefined;
    let matched=comparable&&(numericActual===numericExpected||brokerSlot);
    if(definition&&actual!==null){
      if(definition.valueKind==='presence_flag'||definition.valueKind==='valued_boolean'){
        const boolean=/^(?:1|true|yes)$/i.test(actual.trim())?true:/^(?:0|false|no)$/i.test(actual.trim())?false:undefined;
        comparable=boolean!==undefined&&!(definition.valueKind==='presence_flag'&&expected==='false');
        matched=comparable&&boolean===databaseParameterInput(parameter.name,expected);
      }else if(definition.valueKind==='string'||definition.valueKind==='enum'){
        comparable=true;matched=definition.enumCase==='insensitive'?actual.toLowerCase()===expected.toLowerCase():parameter.name==='-diagFormat'?actual===expected.toLowerCase():actual===expected;
      }
    }
    const verification=observed&&comparable?(matched?'matched' as const:'mismatched' as const):'unverifiable' as const;
    return {
      name: parameter.name,
      displayValue: expected,
      source: parameter.source,
      verification,
      observedValue: actual,
      ...(brokerSlot ? { reason: "openedge_primary_broker_slot" } : {}),
      ...(verification === "unverifiable"
        ? {
            reason: observed
              ? "value_unavailable"
              : candidates.length
                ? "duplicate_parameter"
                : "parameter_missing"
          }
        : {})
    };
  });
  const status =
    capture.status === "unavailable"
      ? "unavailable"
      : capture.status === "partial" || gaps.length
        ? "partial"
        : rows.length === 0
          ? "empty"
          : "complete";
  const reason = capture.reason ?? gaps[0];
  return validateDatabaseParameterSnapshot({
    contractVersion: "db-parameter-snapshot.v1",
    ...identity,
    databaseName: capture.databaseName,
    attemptedAt: capture.attemptedAt,
    ...(capture.capturedAt ? { capturedAt: capture.capturedAt } : {}),
    status,
    ...(reason ? { reason } : {}),
    ...(gaps.length ? { gaps } : {}),
    rowCount: rows.length,
    source: "_DbParams",
    rows,
    verificationResults
  });
}
