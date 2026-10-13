import { MatrixPreview, MatrixPreviewRequest } from "../../../../packages/contracts/src";

export interface MatrixPreviewStore {
  save(preview: {
    id: string;
    request: MatrixPreviewRequest;
    expiresAt: string;
  }): void;
  get(
    id: string
  ):
    | { id: string; request: MatrixPreviewRequest; expiresAt: string }
    | undefined;
}

export function assertPreviewSubmission(
  preview: { expiresAt: string } | undefined,
  confirm: boolean
): void {
  if (!confirm) throw new Error("matrix_confirmation_required");
  if (!preview) throw new Error("preview_not_found");
  if (Date.parse(preview.expiresAt) <= Date.now()) throw new Error("preview_expired");
}

export function previewWarning(runCount: number): MatrixPreview["warning"] {
  return {
    code: "matrix_submission_confirmation",
    message: `This submission will queue ${runCount} runs. Confirm to continue.`
  };
}
