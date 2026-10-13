import { CatalogAsset, ImageOperation } from "../../../../packages/contracts/src";

export interface ControlledImageRunner {
  verify(input: {
    assets: CatalogAsset[];
    expectedContracts: string[];
    signal?: AbortSignal;
  }): Promise<{ diagnostics: string[] }>;
  build(input: {
    assets: CatalogAsset[];
    stage?: string;
    outputProfile?: string;
    operationId?: string;
    signal?: AbortSignal;
  }): Promise<{ reference?: string; diagnostics: string[] }>;
}

export async function runControlledImageOperation(
  operation: ImageOperation,
  assets: CatalogAsset[],
  runner: ControlledImageRunner,
  signal?: AbortSignal
): Promise<{ reference?: string; diagnostics: string[] }> {
  if (operation.kind === "VERIFY")
    return runner.verify({
      assets,
      expectedContracts: operation.expectedContracts,
      signal
    });
  return runner.build({
    assets,
    stage: operation.stage,
    outputProfile: operation.outputProfile,
    operationId: operation.id,
    signal
  });
}
