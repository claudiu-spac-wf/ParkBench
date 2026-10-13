import {
  IMAGE_OPERATION_PROFILES,
  IMAGE_OPERATION_STAGES,
  ImageOperation,
  ImageOperationState,
  ValidationError
} from "../../../../packages/contracts/src";

const allowed: Record<ImageOperationState, ImageOperationState[]> = {
  REQUESTED: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: ["REQUESTED"],
  CANCELLED: ["REQUESTED"]
};

export function canTransitionImageOperation(
  from: ImageOperationState,
  to: ImageOperationState
): boolean {
  return from === to || allowed[from].includes(to);
}

export function assertControlledOperationInput(input: Record<string, unknown>): void {
  const allowed = new Set(["kind", "stage", "inputAssetIds", "expectedContracts", "outputProfile"]);
  const forbidden = Object.keys(input).find((key) => !allowed.has(key));
  if (forbidden) throw new Error(`arbitrary_operation_input_forbidden:${forbidden}`);
  if (input.kind !== "BUILD" && input.kind !== "VERIFY")
    throw new ValidationError([{ path: "/kind", code: "operation_kind_invalid" }]);
  if (input.stage !== undefined && !IMAGE_OPERATION_STAGES.includes(input.stage as any))
    throw new ValidationError([{ path: "/stage", code: "operation_stage_invalid" }]);
  if (
    !Array.isArray(input.inputAssetIds) ||
    input.inputAssetIds.length < 1 ||
    input.inputAssetIds.length > 100
  )
    throw new ValidationError([{ path: "/inputAssetIds", code: "asset_ids_invalid" }]);
  if (
    (input.inputAssetIds as unknown[]).some(
      (assetId) => typeof assetId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(assetId)
    )
  )
    throw new ValidationError([{ path: "/inputAssetIds", code: "asset_id_invalid" }]);
  if (
    input.expectedContracts !== undefined &&
    (!Array.isArray(input.expectedContracts) ||
      (input.expectedContracts as unknown[]).some((item) => typeof item !== "string"))
  )
    throw new ValidationError([{ path: "/expectedContracts", code: "contracts_invalid" }]);
  if (
    input.outputProfile !== undefined &&
    !IMAGE_OPERATION_PROFILES.includes(input.outputProfile as any)
  )
    throw new ValidationError([{ path: "/outputProfile", code: "operation_profile_invalid" }]);
  if (input.kind === "BUILD" && !input.outputProfile)
    throw new ValidationError([{ path: "/outputProfile", code: "operation_profile_required" }]);
}

export class ImageOperationService {
  constructor(private readonly save: (operation: ImageOperation) => void) {}

  transition(operation: ImageOperation, state: ImageOperationState): ImageOperation {
    if (!canTransitionImageOperation(operation.state, state))
      throw new Error(`invalid_image_operation_transition:${operation.state}:${state}`);
    const updated = { ...operation, state };
    this.save(updated);
    return updated;
  }
}
