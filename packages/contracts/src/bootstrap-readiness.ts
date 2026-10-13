import Ajv from "ajv/dist/2020";
import { loadContractSchema } from "./schema-loader";

export const BOOTSTRAP_READINESS_CONTRACT_VERSION = "bootstrap-readiness.v1" as const;

export const REQUIRED_BOOTSTRAP_SERVICES = [
  "control-plane",
  "web-ui",
  "prometheus",
  "grafana",
  "cadvisor",
  "node-exporter"
] as const;

export type RequiredBootstrapService = (typeof REQUIRED_BOOTSTRAP_SERVICES)[number];
export type BootstrapServiceStatus = "ready" | "not_ready";

export const BOOTSTRAP_STAGES = [
  "started",
  "host_preflight",
  "input_preflight",
  "dependency_install",
  "application_build",
  "openedge_generic",
  "seed_create",
  "openedge_final",
  "catalog_inputs",
  "support_images",
  "platform_start",
  "service_readiness",
  "ready",
  "failed"
] as const;

export type BootstrapStage = (typeof BOOTSTRAP_STAGES)[number];

export interface BootstrapReadiness {
  contractVersion: typeof BOOTSTRAP_READINESS_CONTRACT_VERSION;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ready" | "failed";
  stage: BootstrapStage;
  component: string;
  valid: boolean;
  error?: string;
  checks: string[];
  services: Record<RequiredBootstrapService, BootstrapServiceStatus>;
  diagnosticLog: string;
  recoveryAction?: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile<BootstrapReadiness>(loadContractSchema("bootstrap-readiness-v1"));

export function validateBootstrapReadiness(input: unknown): BootstrapReadiness {
  if (!validate(input)) throw new Error("bootstrap_readiness_invalid");
  const result = input as BootstrapReadiness;
  if (
    result.status === "ready" &&
    REQUIRED_BOOTSTRAP_SERVICES.some((name) => result.services[name] !== "ready")
  )
    throw new Error("bootstrap_required_service_not_ready");
  if (result.status === "ready" && (!result.valid || result.stage !== "ready"))
    throw new Error("bootstrap_ready_result_inconsistent");
  if (result.status === "failed" && (result.valid || !result.recoveryAction || !result.finishedAt))
    throw new Error("bootstrap_failure_result_incomplete");
  return result;
}
