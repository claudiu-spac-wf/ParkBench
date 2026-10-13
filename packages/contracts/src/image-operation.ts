export { ImageOperation, ImageOperationKind, ImageOperationState } from "./control-ui";

export interface ImageOperationRequest {
  kind: "BUILD" | "VERIFY";
  stage?: string;
  inputAssetIds: string[];
  expectedContracts?: string[];
  outputProfile?: string;
}

export const IMAGE_OPERATION_PROFILES = [
  "workload",
  "loadgen",
  "database",
  "pas",
  "observer"
] as const;
export type ImageOperationProfile = (typeof IMAGE_OPERATION_PROFILES)[number];
export const IMAGE_OPERATION_STAGES = ["generic", "final", "all"] as const;

export const IMAGE_OPERATION_STATES = [
  "REQUESTED",
  "VALIDATING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED"
] as const;
