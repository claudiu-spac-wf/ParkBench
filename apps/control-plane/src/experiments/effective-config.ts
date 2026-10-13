import { Variant } from "../../../../packages/contracts/src/experiment";
import {
  applyParameters,
  PARAMETER_ADAPTER_VERSION
} from "../../../../packages/compose-runner/src/parameters";
export function effectiveConfiguration(
  base: Record<string, unknown>,
  variant: Variant
): { values: Record<string, unknown>; adapterVersion: string } {
  const values = applyParameters(base, variant);
  return {
    values,
    adapterVersion: PARAMETER_ADAPTER_VERSION
  };
}
