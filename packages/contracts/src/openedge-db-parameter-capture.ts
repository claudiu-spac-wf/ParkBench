import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";

export const OPENEDGE_DB_PARAMETER_CAPTURE_VERSION = "openedge-db-parameter-capture.v1" as const;
export const OPENEDGE_DB_PARAMETER_MAX_ROWS = 1024;
export const OPENEDGE_DB_PARAMETER_MAX_NAME_BYTES = 128;
export const OPENEDGE_DB_PARAMETER_MAX_VALUE_BYTES = 65536;
export const OPENEDGE_DB_PARAMETER_MAX_METRIC_VALUE_BYTES = 8192;
export const OPENEDGE_DB_PARAMETER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OpenEdgeDbParameterCaptureRow {
  name: string;
  rawValue: string | null;
  dtype: number | null;
  isDefault: boolean | null;
  isModifiable?: boolean | null;
}

export interface OpenEdgeDbParameterCapture {
  contractVersion: typeof OPENEDGE_DB_PARAMETER_CAPTURE_VERSION;
  databaseName: string;
  attemptedAt: string;
  capturedAt?: string;
  source: "_DbParams";
  status: "complete" | "partial" | "unavailable";
  reason?: string;
  rows: OpenEdgeDbParameterCaptureRow[];
}

const validate = new Ajv({ allErrors: true, strict: false }).compile<OpenEdgeDbParameterCapture>(
  loadContractSchema("openedge-db-parameter-capture-v1")
);

export function validateOpenEdgeDbParameterCapture(input: unknown): OpenEdgeDbParameterCapture {
  if (Buffer.byteLength(JSON.stringify(input)) > OPENEDGE_DB_PARAMETER_MAX_RESPONSE_BYTES || !validate(input))
    throw new Error(`openedge_db_parameter_capture_invalid:${JSON.stringify(validate.errors)}`);
  const capture = input as OpenEdgeDbParameterCapture;
  if ((capture.status === "complete" && !capture.capturedAt) ||
    (capture.status === "unavailable" && (capture.capturedAt !== undefined || capture.rows.length !== 0)) ||
    (capture.status === "partial" && (capture.rows.length > 0) !== Boolean(capture.capturedAt)))
    throw new Error("openedge_db_parameter_capture_state_invalid");
  return capture;
}
