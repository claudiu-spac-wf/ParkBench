import { ExperimentRequest } from "../../../../packages/contracts/src/experiment";
import { validateVariant } from "../../../../packages/contracts/src/variant";
export function validateMatrix(request: ExperimentRequest): void {
  if (!request.variants.length || request.repetitions < 1)
    throw new Error("matrix_must_have_variant_and_repetition");
  const ids = new Set<string>();
  for (const variant of request.variants) {
    if (ids.has(variant.id)) throw new Error(`duplicate_variant:${variant.id}`);
    ids.add(variant.id);
    validateVariant(variant);
  }
  if (request.baselineVariantId && !ids.has(request.baselineVariantId))
    throw new Error("baseline_variant_not_found");
  if (request.comparisonMode === "exploratory" && request.baselineVariantId)
    throw new Error("exploratory_baseline_forbidden");
}
export function expandMatrix(
  request: ExperimentRequest
): Array<{ variantId: string; repetition: number }> {
  validateMatrix(request);
  return request.variants.flatMap((variant) =>
    Array.from({ length: request.repetitions }, (_, index) => ({
      variantId: variant.id,
      repetition: index + 1
    }))
  );
}
