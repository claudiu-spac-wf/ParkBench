import {
  DatabaseParameterDefinition,
  MatrixCell,
  MatrixPreviewRequest
} from "../../../../packages/contracts/src";
import {
  expandMatrix,
  validateMatrixRequest
} from "../../../../packages/contracts/src/matrix-expansion";

export { validateMatrixRequest };

export function expandControlMatrix(
  request: MatrixPreviewRequest,
  definitions: DatabaseParameterDefinition[]
): MatrixCell[] {
  return expandMatrix(request, definitions);
}
